import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { createDoctorTool, doctorTool } from "../../src/tools/doctor.js";
import { makeConfig } from "../helpers.js";

const rateFixture = {
  resources: {
    core: { limit: 5000, remaining: 4999, reset: 1_700_000_600, used: 1 },
    search: { limit: 30, remaining: 30, reset: 1_700_000_060, used: 0 },
    //? graphql is a bucket GitHub really reports; doctor's quota projection must
    //* trim it exactly like github_rate_limit's default (core + search only).
    graphql: { limit: 50, remaining: 50, reset: 1_700_000_050, used: 0 },
  },
};

//? One mock serves /rate_limit and (for the identity opt-in) /user; the cache
//! outcome is spelled out because responseMeta derives the meta entry from it.
//! A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
//! mock literal is asserted to GitHubApi and assertions inspect the same mock.
function rateClient(options: { scopes?: string } = {}) {
  return {
    api: vi.fn(async (path: string) => {
      if (path === "/user") {
        return { data: { login: "KurvCygnus" }, headers: new Headers(), status: 200, contentType: "application/json" };
      }
      return {
        data: rateFixture,
        headers: new Headers(options.scopes === undefined ? {} : { "x-oauth-scopes": options.scopes }),
        status: 200,
        contentType: "application/json",
        cache: { state: "miss" as const },
      };
    }),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

describe("github_doctor", () => {
  it("reports the full screen in direct mode without probing", async () => {
    const client = rateClient();
    const probe = vi.fn(async () => true);
    const listCache = vi.fn(async () => ({ entries: 3, bytes: 120 }));
    const tool = createDoctorTool({ probe, listCache });
    const result = await tool.handler(
      {},
      { client, config: makeConfig({ proxyMode: "direct", cacheDir: "/tmp/cache" }), authFingerprint: "abc" },
    );
    expect(result).toEqual({
      token: { present: true },
      proxy: { mode: "direct", url: null, reachable: true },
      cache: { mode: "off", dir: "/tmp/cache", entries: 3, bytes: 120 },
      quota: {
        core: { limit: 5000, remaining: 4999, reset: "2023-11-14T22:23:20.000Z" },
        search: { limit: 30, remaining: 30, reset: "2023-11-14T22:14:20.000Z" },
      },
      meta: { cache: "miss" },
    });
    expect(probe).not.toHaveBeenCalled();
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(client.api).toHaveBeenCalledWith("/rate_limit", { cacheTtlMs: 0 });
  });

  it("probes the resolved proxy host and port when a proxy URL exists", async () => {
    const client = rateClient();
    const probe = vi.fn(async () => true);
    const tool = createDoctorTool({ probe, listCache: async () => ({ entries: 0, bytes: 0 }) });
    const result = await tool.handler(
      {},
      {
        client,
        config: makeConfig({ proxyMode: "always", httpsProxy: "http://127.0.0.1:12334" }),
        authFingerprint: "abc",
      },
    );
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith("127.0.0.1", 12334);
    expect(result.proxy).toEqual({ mode: "always", url: "http://127.0.0.1:12334", reachable: true });
  });

  it("reports unreachable when the probe answers false", async () => {
    const client = rateClient();
    const probe = vi.fn(async () => false);
    const tool = createDoctorTool({ probe, listCache: async () => ({ entries: 0, bytes: 0 }) });
    const result = await tool.handler(
      {},
      {
        client,
        config: makeConfig({ proxyMode: "always", httpsProxy: "http://127.0.0.1:12334" }),
        authFingerprint: "abc",
      },
    );
    expect(result.proxy).toEqual({ mode: "always", url: "http://127.0.0.1:12334", reachable: false });
  });

  it("degrades a rejecting probe to unreachable instead of throwing", async () => {
    const client = rateClient();
    const probe = vi.fn(async () => {
      throw new Error("probe blew up");
    });
    const tool = createDoctorTool({ probe, listCache: async () => ({ entries: 0, bytes: 0 }) });
    const result = await tool.handler(
      {},
      {
        client,
        config: makeConfig({ proxyMode: "always", httpsProxy: "http://127.0.0.1:12334" }),
        authFingerprint: "abc",
      },
    );
    expect(result.proxy).toEqual({ mode: "always", url: "http://127.0.0.1:12334", reachable: false });
  });

  it("passes cache walk numbers through and resolves the dir from injected env", async () => {
    const client = rateClient();
    const listCache = vi.fn(async () => ({ entries: 7, bytes: 4096 }));
    const tool = createDoctorTool({
      env: { XDG_CACHE_HOME: "/xdg" },
      homedir: "/home/u",
      platform: "linux",
      listCache,
    });
    //? join() keeps the expectation host-independent: defaultCacheDir normalizes
    //* separators with the running platform's path module.
    const expectedDir = join("/xdg", "github-fetcher", "cache");
    const result = await tool.handler(
      {},
      { client, config: makeConfig({ proxyMode: "direct", cacheMode: "disk" }), authFingerprint: "abc" },
    );
    expect(listCache).toHaveBeenCalledWith(expectedDir);
    expect(result.cache).toEqual({ mode: "disk", dir: expectedDir, entries: 7, bytes: 4096 });
  });

  it("degrades cache stats to zeros when the walk fails (missing dir)", async () => {
    const client = rateClient();
    const listCache = vi.fn(async () => {
      throw new Error("ENOENT: no such file or directory");
    });
    const tool = createDoctorTool({ env: {}, homedir: "/home/u", platform: "linux", listCache });
    const result = await tool.handler(
      {},
      { client, config: makeConfig({ proxyMode: "direct", cacheMode: "disk", cacheDir: "/gone" }), authFingerprint: "abc" },
    );
    expect(result.cache).toEqual({ mode: "disk", dir: "/gone", entries: 0, bytes: 0 });
  });

  it("omits identity keys unless the opt-in is on", async () => {
    const client = rateClient({ scopes: "repo" });
    const tool = createDoctorTool({ probe: async () => true, listCache: async () => ({ entries: 0, bytes: 0 }) });
    const result = await tool.handler(
      {},
      { client, config: makeConfig({ proxyMode: "direct" }), authFingerprint: "abc123" },
    );
    expect(result).not.toHaveProperty("identity");
    expect(JSON.stringify(result)).not.toContain("scopes");
    expect(result.token).toEqual({ present: true });
    expect(client.api).toHaveBeenCalledTimes(1);
  });

  it("adds identity and scopes when the opt-in is on", async () => {
    const client = rateClient({ scopes: "gist, repo , workflow" });
    const tool = createDoctorTool({ probe: async () => true, listCache: async () => ({ entries: 0, bytes: 0 }) });
    const result = await tool.handler(
      {},
      { client, config: makeConfig({ proxyMode: "direct", exposeIdentity: true }), authFingerprint: "abc123" },
    );
    expect(result.identity).toEqual({ authenticated_as: "KurvCygnus", scopes: ["gist", "repo", "workflow"] });
    expect(client.api).toHaveBeenCalledWith("/user", { cacheTtlMs: 300_000 });
  });

  it("reports an anonymous token and null identity without calling /user", async () => {
    const client = rateClient();
    const tool = createDoctorTool({ probe: async () => true, listCache: async () => ({ entries: 0, bytes: 0 }) });
    const result = await tool.handler(
      {},
      { client, config: makeConfig({ proxyMode: "direct", exposeIdentity: true }), authFingerprint: "anonymous" },
    );
    expect(result.token).toEqual({ present: false });
    expect(result.identity).toEqual({ authenticated_as: null, scopes: [] });
    expect(client.api).toHaveBeenCalledTimes(1);
  });

  it("exports a ready-made tool with an empty input schema", () => {
    expect(doctorTool.name).toBe("github_doctor");
    expect(doctorTool.inputSchema).toEqual({});
  });
});
