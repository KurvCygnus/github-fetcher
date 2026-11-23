import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

//* The doctor must never open a TCP probe socket; pin that at the module
//* boundary so a reintroduced createConnection fails this suite immediately.
const netMocks = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock("node:net", () => ({ createConnection: netMocks.createConnection }));
import type { GitHubApi } from "../../src/core/github.js";
import { createPinStore } from "../../src/core/pin-store.js";
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
function rateClient(options: { scopes?: string; rateReject?: Error } = {}) {
  return {
    api: vi.fn(async (path: string) => {
      if (path === "/user") {
        return { data: { login: "KurvCygnus" }, headers: new Headers(), status: 200, contentType: "application/json" };
      }
      if (options.rateReject !== undefined) throw options.rateReject;
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
  it("reports the full screen in direct mode with reachable true and no TCP probe", async () => {
    const client = rateClient();
    const listCache = vi.fn(async () => ({ entries: 3, bytes: 120 }));
    const tool = createDoctorTool({ listCache });
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
      pinned_repos: [],
      meta: { cache: "miss", calls: 1 },
    });
    expect(netMocks.createConnection).not.toHaveBeenCalled();
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(client.api).toHaveBeenCalledWith("/rate_limit", { cacheTtlMs: 0 });
  });

  it("reports a configured proxy reachable when its own /rate_limit call resolves", async () => {
    const client = rateClient();
    const tool = createDoctorTool({ listCache: async () => ({ entries: 0, bytes: 0 }) });
    const result = await tool.handler(
      {},
      {
        client,
        config: makeConfig({ proxyMode: "always", httpsProxy: "http://127.0.0.1:12334" }),
        authFingerprint: "abc",
      },
    );
    expect(result.proxy).toEqual({ mode: "always", url: "http://127.0.0.1:12334", reachable: true });
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(client.api).toHaveBeenCalledWith("/rate_limit", { cacheTtlMs: 0 });
    expect(netMocks.createConnection).not.toHaveBeenCalled();
  });

  it("reports a configured proxy unreachable with a short message when /rate_limit rejects", async () => {
    const client = rateClient({ rateReject: new Error("proxy refused the tunnel") });
    const logger = vi.fn();
    const tool = createDoctorTool({ logger, listCache: async () => ({ entries: 0, bytes: 0 }) });
    const result = await tool.handler(
      {},
      {
        client,
        config: makeConfig({ proxyMode: "always", httpsProxy: "http://127.0.0.1:12334" }),
        authFingerprint: "abc",
      },
    );
    expect(result.proxy).toEqual({ mode: "always", url: "http://127.0.0.1:12334", reachable: false });
    expect(logger).toHaveBeenCalledTimes(1);
    const message = logger.mock.calls[0]?.[0];
    expect(typeof message).toBe("string");
    expect(message).toContain("http://127.0.0.1:12334");
    expect(message).toContain("proxy refused the tunnel");
    expect(netMocks.createConnection).not.toHaveBeenCalled();
  });

  it("keeps the public envelope shape when a configured proxy is unreachable", async () => {
    const client = rateClient({ rateReject: new Error("proxy refused the tunnel") });
    const tool = createDoctorTool({ logger: () => {}, listCache: async () => ({ entries: 0, bytes: 0 }) });
    const result = await tool.handler(
      {},
      {
        client,
        config: makeConfig({ proxyMode: "always", httpsProxy: "http://127.0.0.1:12334" }),
        authFingerprint: "abc",
      },
    );
    expect(Object.keys(result.proxy!).sort()).toEqual(["mode", "reachable", "url"]);
    expect(result.meta).toEqual({ cache: "miss", calls: 1 });
    expect(result.quota).toEqual({});
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
    const tool = createDoctorTool({ listCache: async () => ({ entries: 0, bytes: 0 }) });
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
    const tool = createDoctorTool({ listCache: async () => ({ entries: 0, bytes: 0 }) });
    const result = await tool.handler(
      {},
      { client, config: makeConfig({ proxyMode: "direct", exposeIdentity: true }), authFingerprint: "abc123" },
    );
    expect(result.identity).toEqual({ authenticated_as: "KurvCygnus", scopes: ["gist", "repo", "workflow"] });
    expect(client.api).toHaveBeenCalledWith("/user", { cacheTtlMs: 300_000 });
  });

  it("reports an anonymous token and null identity without calling /user", async () => {
    const client = rateClient();
    const tool = createDoctorTool({ listCache: async () => ({ entries: 0, bytes: 0 }) });
    const result = await tool.handler(
      {},
      { client, config: makeConfig({ proxyMode: "direct", exposeIdentity: true }), authFingerprint: "anonymous" },
    );
    expect(result.token).toEqual({ present: false });
    expect(result.identity).toEqual({ authenticated_as: null, scopes: [] });
    expect(client.api).toHaveBeenCalledTimes(1);
  });

  it("lists only the current context's pins in pinned_repos", async () => {
    //* A context without a pin store reports no pins; a context with one lists
    //* its own keys, never another context's keys.
    const client = rateClient();
    const tool = createDoctorTool({ listCache: async () => ({ entries: 0, bytes: 0 }) });
    const pinsA = createPinStore();
    const pinsB = createPinStore();
    pinsA.set("o/r", "main", "sha-a");
    pinsB.set("o/other", "main", "sha-b");
    const resultA = await tool.handler(
      {},
      { client, config: makeConfig({ proxyMode: "direct" }), authFingerprint: "abc", pins: pinsA },
    );
    const resultB = await tool.handler(
      {},
      { client, config: makeConfig({ proxyMode: "direct" }), authFingerprint: "abc", pins: pinsB },
    );
    const resultNone = await tool.handler(
      {},
      { client, config: makeConfig({ proxyMode: "direct" }), authFingerprint: "abc" },
    );
    expect(resultA.pinned_repos).toEqual(["o/r"]);
    expect(resultB.pinned_repos).toEqual(["o/other"]);
    expect(resultNone.pinned_repos).toEqual([]);
  });

  it("exports a ready-made tool with an empty input schema", () => {
    expect(doctorTool.name).toBe("github_doctor");
    expect(doctorTool.inputSchema).toEqual({});
  });
});
