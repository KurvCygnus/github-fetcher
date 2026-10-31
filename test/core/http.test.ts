import { describe, expect, it, vi } from "vitest";
import type { TokenResolver } from "../../src/core/auth.js";
import { HttpClient, retryDelayMs, routeOrder, type FetchLike } from "../../src/core/http.js";
import { makeConfig } from "../helpers.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(fetchImpl: FetchLike) {
  const auth: TokenResolver = {
    get: vi.fn(async () => "token-a"),
    refresh: vi.fn(async () => "token-b"),
  };
  const sleep = vi.fn(async () => {});
  const client = new HttpClient({
    config: makeConfig({ timeoutMs: 5000 }),
    auth,
    proxy: { url: "http://127.0.0.1:12334", source: "GITHUB_PROXY" },
    fetchImpl,
    sleep,
    now: () => 1_700_000_000_000,
  });
  return { client, auth, sleep };
}

describe("routeOrder", () => {
  it("keeps direct mode direct", () => {
    expect(routeOrder("api.github.com", "direct", true)).toEqual(["direct"]);
    expect(routeOrder("raw.githubusercontent.com", "direct", true)).toEqual(["direct"]);
  });

  it("prefers direct for the API and proxy for raw", () => {
    expect(routeOrder("api.github.com", "auto", true)).toEqual(["direct", "proxy"]);
    expect(routeOrder("raw.githubusercontent.com", "auto", true)).toEqual(["proxy", "direct"]);
  });

  it("puts the proxy first in always mode", () => {
    expect(routeOrder("api.github.com", "always", true)).toEqual(["proxy", "direct"]);
  });

  it("never invents a proxy route", () => {
    expect(routeOrder("raw.githubusercontent.com", "auto", false)).toEqual(["direct"]);
  });
});

describe("retryDelayMs", () => {
  it("reads Retry-After seconds", () => {
    expect(retryDelayMs(new Headers({ "retry-after": "2" }), 0)).toBe(2000);
  });

  it("reads Retry-After HTTP dates", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const headers = new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:30 GMT" });
    expect(retryDelayMs(headers, now)).toBe(30000);
  });

  it("falls back to the reset epoch", () => {
    const headers = new Headers({ "x-ratelimit-reset": "1700000060" });
    expect(retryDelayMs(headers, 1_700_000_000_000)).toBe(60000);
  });

  it("returns null without hints", () => {
    expect(retryDelayMs(new Headers(), 0)).toBeNull();
  });
});

describe("HttpClient", () => {
  it("sends identity, accept, and auth headers", async () => {
    //? vi.fn() alone infers a zero-arg procedure, so mock.calls[0] is a [] tuple with no
    //? init slot; <FetchLike> gives calls the (url, init) shape. "!" satisfies
    //? noUncheckedIndexedAccess: the call is known to have happened by this point.
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({ ok: true }));
    const { client } = makeClient(fetchImpl);
    const response = await client.get("https://api.github.com/repos/a/b");
    expect(response.status).toBe(200);
    const headers = fetchImpl.mock.calls[0]![1]?.headers as Headers;
    expect(headers.get("user-agent")).toMatch(/^github-fetcher\//);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("authorization")).toBe("Bearer token-a");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
  });

  it("refreshes the token once on 401", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "Bad credentials" }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { client, auth } = makeClient(fetchImpl);
    await client.get("https://api.github.com/user");
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    const secondHeaders = fetchImpl.mock.calls[1]![1]?.headers as Headers;
    expect(secondHeaders.get("authorization")).toBe("Bearer token-b");
  });

  it("waits out a short rate-limit window and retries", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ message: "rate limited" }, 403, { "retry-after": "1" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { client, sleep } = makeClient(fetchImpl);
    await expect(client.get("https://api.github.com/repos/a/b")).resolves.toMatchObject({ status: 200 });
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("raises rate_limited for a long window without waiting", async () => {
    const reset = String(Math.floor(1_700_000_000_000 / 1000) + 3600);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ message: "API rate limit exceeded" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": reset,
      }),
    );
    const { client, sleep } = makeClient(fetchImpl);
    await expect(client.get("https://api.github.com/repos/a/b")).rejects.toMatchObject({
      code: "rate_limited",
      details: { reset_at: expect.stringMatching(/^\d{4}-/) },
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("maps 404 to not_found", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: "Not Found" }, 404));
    const { client } = makeClient(fetchImpl);
    await expect(client.get("https://api.github.com/repos/a/missing")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("surfaces the decoded GitHub message and documentation url", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { message: "Not Found", documentation_url: "https://docs.github.com/rest/releases" },
        404,
      ),
    );
    const { client } = makeClient(fetchImpl);
    await expect(client.get("https://api.github.com/repos/a/missing")).rejects.toMatchObject({
      code: "not_found",
      message: "Not Found",
      details: { status: 404, documentation_url: "https://docs.github.com/rest/releases" },
    });
  });

  it("retries a network failure and falls back to the proxy", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const { client } = makeClient(fetchImpl);
    await client.get("https://api.github.com/repos/a/b");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]![1]).toHaveProperty("dispatcher");
  });

  it("follows same-origin redirects", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/repos/new/name" } }))
      .mockResolvedValueOnce(jsonResponse({ full_name: "new/name" }));
    const { client } = makeClient(fetchImpl);
    const response = await client.get("https://api.github.com/repos/old/name");
    expect(response.status).toBe(200);
    expect(fetchImpl.mock.calls[1]![0]).toBe("https://api.github.com/repos/new/name");
  });

  //? R1 (controller ruling): the plan's "network_error" was a typo; ErrorCode has "network".
  it("rejects redirects that leave GitHub", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
    );
    const { client } = makeClient(fetchImpl);
    await expect(client.get("https://api.github.com/repos/a/b")).rejects.toMatchObject({
      code: "network",
    });
  });

  //? Review round 1: redirect-policy rejections are deterministic, so the first occurrence
  //? must surface immediately — one fetch, no route sweep, no retry sleeps.
  it("does not retry a cross-origin redirect rejection", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
    );
    const { client, sleep } = makeClient(fetchImpl);
    await expect(client.get("https://api.github.com/repos/a/b")).rejects.toMatchObject({
      code: "network",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry a missing-Location redirect rejection", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 301 }));
    const { client, sleep } = makeClient(fetchImpl);
    await expect(client.get("https://api.github.com/repos/a/b")).rejects.toMatchObject({
      code: "network",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
