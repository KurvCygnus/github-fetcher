import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { rateLimitTool } from "../../src/tools/rate.js";
import { makeConfig } from "../helpers.js";

const fixture = {
  resources: {
    core: { limit: 5000, remaining: 4999, reset: 1_700_000_600, used: 1 },
    search: { limit: 30, remaining: 30, reset: 1_700_000_060, used: 0 },
  },
};

describe("github_rate_limit", () => {
  it("projects quota without leaking identity", async () => {
    //? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
    //! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
    const client = { api: vi.fn(async () => ({ data: fixture, headers: new Headers(), status: 200, contentType: "application/json" })), apiRaw: vi.fn(), raw: vi.fn() } as unknown as GitHubApi;
    const result = await rateLimitTool.handler(
      {},
      { client, config: makeConfig(), authFingerprint: "abc123" },
    );
    expect(result).toEqual({
      auth: "token",
      resources: {
        core: { limit: 5000, remaining: 4999, reset: "2023-11-14T22:23:20.000Z", used: 1 },
        search: { limit: 30, remaining: 30, reset: "2023-11-14T22:14:20.000Z", used: 0 },
      },
    });
    expect(JSON.stringify(result)).not.toContain("abc123");
    expect(client.api).toHaveBeenCalledWith("/rate_limit", { cacheTtlMs: 0 });
  });

  it("labels anonymous mode", async () => {
    const client = { api: vi.fn(async () => ({ data: fixture, headers: new Headers(), status: 200, contentType: "application/json" })), apiRaw: vi.fn(), raw: vi.fn() } as unknown as GitHubApi;
    const result = await rateLimitTool.handler(
      {},
      { client, config: makeConfig(), authFingerprint: "anonymous" },
    );
    expect(result).toMatchObject({ auth: "anonymous" });
  });

  it("filters resources when resource is given", async () => {
    const client = { api: vi.fn(async () => ({ data: fixture, headers: new Headers(), status: 200, contentType: "application/json" })), apiRaw: vi.fn(), raw: vi.fn() } as unknown as GitHubApi;
    const output = await rateLimitTool.handler(
      { resource: "core" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(Object.keys((output as { resources: Record<string, unknown> }).resources)).toEqual(["core"]);
  });

  it("returns empty resources for an unknown resource", async () => {
    const client = { api: vi.fn(async () => ({ data: fixture, headers: new Headers(), status: 200, contentType: "application/json" })), apiRaw: vi.fn(), raw: vi.fn() } as unknown as GitHubApi;
    const output = await rateLimitTool.handler(
      { resource: "nope" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect((output as { resources: Record<string, unknown> }).resources).toEqual({});
  });

  //? One mock serves both endpoints: /rate_limit returns the quota fixture with an
  //! optional scopes header, /user returns the login or throws. Assertions inspect
  //! the same mock, so the cast to GitHubApi stays.
  function identityClient(options: { scopes?: string; login?: string; userError?: Error }) {
    return {
      api: vi.fn(async (path: string) => {
        if (path === "/user") {
          if (options.userError) throw options.userError;
          return {
            data: { login: options.login },
            headers: new Headers(),
            status: 200,
            contentType: "application/json",
          };
        }
        return {
          data: fixture,
          headers: new Headers(options.scopes === undefined ? {} : { "x-oauth-scopes": options.scopes }),
          status: 200,
          contentType: "application/json",
        };
      }),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
  }

  it("keeps the 0.2.0 shape by default and never calls /user", async () => {
    const client = identityClient({ scopes: "repo" });
    const result = await rateLimitTool.handler(
      {},
      { client, config: makeConfig(), authFingerprint: "abc123" },
    );
    expect(result).toEqual({
      auth: "token",
      resources: {
        core: { limit: 5000, remaining: 4999, reset: "2023-11-14T22:23:20.000Z", used: 1 },
        search: { limit: 30, remaining: 30, reset: "2023-11-14T22:14:20.000Z", used: 0 },
      },
    });
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(client.api).toHaveBeenCalledWith("/rate_limit", { cacheTtlMs: 0 });
  });

  it("adds identity and scopes when the opt-in is set", async () => {
    const client = identityClient({ scopes: "gist, repo , workflow", login: "KurvCygnus" });
    const result = await rateLimitTool.handler(
      {},
      { client, config: makeConfig({ exposeIdentity: true }), authFingerprint: "abc123" },
    );
    expect(result).toEqual({
      auth: "token",
      authenticated_as: "KurvCygnus",
      scopes: ["gist", "repo", "workflow"],
      resources: {
        core: { limit: 5000, remaining: 4999, reset: "2023-11-14T22:23:20.000Z", used: 1 },
        search: { limit: 30, remaining: 30, reset: "2023-11-14T22:14:20.000Z", used: 0 },
      },
    });
    expect(client.api).toHaveBeenCalledWith("/user", { cacheTtlMs: 300_000 });
    expect(JSON.stringify(result)).not.toContain("abc123");
  });

  it("degrades to a null identity when /user fails", async () => {
    const client = identityClient({ scopes: "repo", userError: new Error("upstream down") });
    const result = await rateLimitTool.handler(
      {},
      { client, config: makeConfig({ exposeIdentity: true }), authFingerprint: "abc123" },
    );
    expect(result).toMatchObject({ authenticated_as: null, scopes: ["repo"] });
    expect((result as { resources: unknown }).resources).toBeDefined();
  });

  it("reports anonymous identity without calling /user", async () => {
    const client = identityClient({});
    const result = await rateLimitTool.handler(
      {},
      { client, config: makeConfig({ exposeIdentity: true }), authFingerprint: "anonymous" },
    );
    expect(result).toEqual({
      auth: "anonymous",
      authenticated_as: null,
      scopes: [],
      resources: {
        core: { limit: 5000, remaining: 4999, reset: "2023-11-14T22:23:20.000Z", used: 1 },
        search: { limit: 30, remaining: 30, reset: "2023-11-14T22:14:20.000Z", used: 0 },
      },
    });
    expect(client.api).toHaveBeenCalledTimes(1);
  });
});
