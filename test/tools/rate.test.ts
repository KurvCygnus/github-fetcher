import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { rateLimitTool } from "../../src/tools/rate.js";
import { makeConfig } from "../helpers.js";

const fixture = {
  resources: {
    core: { limit: 5000, remaining: 4999, reset: 1_700_000_600, used: 1 },
    search: { limit: 30, remaining: 30, reset: 1_700_000_060, used: 0 },
    graphql: { limit: 50, remaining: 50, reset: 1_700_000_050, used: 0 },
  },
};

//* graphql is a third bucket GitHub really reports; it exists in the fixture to
//* prove the default projection trims it and that only all: true or an explicit
//* resource brings it back.

describe("github_rate_limit", () => {
  it("projects quota without leaking identity", async () => {
    //? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
    //! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
    const client = { api: vi.fn(async () => ({ data: fixture, headers: new Headers(), status: 200, contentType: "application/json", cache: { state: "miss" } })), apiRaw: vi.fn(), raw: vi.fn() } as unknown as GitHubApi;
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
      meta: { cache: "miss" },
    });
    expect(JSON.stringify(result)).not.toContain("abc123");
    expect(client.api).toHaveBeenCalledWith("/rate_limit", { cacheTtlMs: 0 });
  });

  it("labels anonymous mode", async () => {
    const client = { api: vi.fn(async () => ({ data: fixture, headers: new Headers(), status: 200, contentType: "application/json", cache: { state: "miss" } })), apiRaw: vi.fn(), raw: vi.fn() } as unknown as GitHubApi;
    const result = await rateLimitTool.handler(
      {},
      { client, config: makeConfig(), authFingerprint: "anonymous" },
    );
    expect(result).toMatchObject({ auth: "anonymous" });
  });

  it("trims the default projection to the core and search buckets", async () => {
    const client = { api: vi.fn(async () => ({ data: fixture, headers: new Headers(), status: 200, contentType: "application/json", cache: { state: "miss" } })), apiRaw: vi.fn(), raw: vi.fn() } as unknown as GitHubApi;
    const output = await rateLimitTool.handler(
      {},
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(Object.keys((output as { resources: Record<string, unknown> }).resources)).toEqual(["core", "search"]);
  });

  it("returns every bucket when all is true", async () => {
    const client = { api: vi.fn(async () => ({ data: fixture, headers: new Headers(), status: 200, contentType: "application/json", cache: { state: "miss" } })), apiRaw: vi.fn(), raw: vi.fn() } as unknown as GitHubApi;
    const output = await rateLimitTool.handler(
      { all: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      auth: "token",
      resources: {
        core: { limit: 5000, remaining: 4999, reset: "2023-11-14T22:23:20.000Z", used: 1 },
        search: { limit: 30, remaining: 30, reset: "2023-11-14T22:14:20.000Z", used: 0 },
        graphql: { limit: 50, remaining: 50, reset: "2023-11-14T22:14:10.000Z", used: 0 },
      },
      meta: { cache: "miss" },
    });
  });

  it("returns only graphql when resource alone names it", async () => {
    const client = { api: vi.fn(async () => ({ data: fixture, headers: new Headers(), status: 200, contentType: "application/json", cache: { state: "miss" } })), apiRaw: vi.fn(), raw: vi.fn() } as unknown as GitHubApi;
    const output = await rateLimitTool.handler(
      { resource: "graphql" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(Object.keys((output as { resources: Record<string, unknown> }).resources)).toEqual(["graphql"]);
  });

  it("prefers resource over all when both are given", async () => {
    const client = { api: vi.fn(async () => ({ data: fixture, headers: new Headers(), status: 200, contentType: "application/json", cache: { state: "miss" } })), apiRaw: vi.fn(), raw: vi.fn() } as unknown as GitHubApi;
    const output = await rateLimitTool.handler(
      { resource: "graphql", all: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(Object.keys((output as { resources: Record<string, unknown> }).resources)).toEqual(["graphql"]);
  });

  it("filters resources when resource is given", async () => {
    const client = { api: vi.fn(async () => ({ data: fixture, headers: new Headers(), status: 200, contentType: "application/json", cache: { state: "miss" } })), apiRaw: vi.fn(), raw: vi.fn() } as unknown as GitHubApi;
    const output = await rateLimitTool.handler(
      { resource: "core" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(Object.keys((output as { resources: Record<string, unknown> }).resources)).toEqual(["core"]);
  });

  it("returns empty resources for an unknown resource", async () => {
    const client = { api: vi.fn(async () => ({ data: fixture, headers: new Headers(), status: 200, contentType: "application/json", cache: { state: "miss" } })), apiRaw: vi.fn(), raw: vi.fn() } as unknown as GitHubApi;
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
          cache: { state: "miss" },
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
      meta: { cache: "miss" },
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
      meta: { cache: "miss" },
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

  //? Sweep test (Task 14): a single-request tool appends responseMeta from its one
  //* /rate_limit call. A mock without an observation reports the cache outcome
  //* alone; the client extracts the x-ratelimit header pair into the result's
  //* quota snapshot, and the mock spells that extracted snapshot out directly.
  it("appends meta from the quota call's cache outcome and quota snapshot", async () => {
    const headerless = {
      api: vi.fn(async () => ({
        data: fixture,
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
        cache: { state: "miss" },
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const output = await rateLimitTool.handler(
      {},
      { client: headerless, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      auth: "token",
      resources: {
        core: { limit: 5000, remaining: 4999, reset: "2023-11-14T22:23:20.000Z", used: 1 },
        search: { limit: 30, remaining: 30, reset: "2023-11-14T22:14:20.000Z", used: 0 },
      },
      meta: { cache: "miss" },
    });

    const withQuota = {
      api: vi.fn(async () => ({
        data: fixture,
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
        cache: { state: "miss" },
        quota: { resource: "core", remaining: 4990 },
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const quotaOutput = await rateLimitTool.handler(
      {},
      { client: withQuota, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(quotaOutput).toEqual({
      auth: "token",
      resources: {
        core: { limit: 5000, remaining: 4999, reset: "2023-11-14T22:23:20.000Z", used: 1 },
        search: { limit: 30, remaining: 30, reset: "2023-11-14T22:14:20.000Z", used: 0 },
      },
      meta: { cache: "miss", quota: { resource: "core", remaining: 4990 } },
    });
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
      meta: { cache: "miss" },
    });
    expect(client.api).toHaveBeenCalledTimes(1);
  });
});
