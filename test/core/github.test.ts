import { describe, expect, it, vi } from "vitest";
import { cacheKey, createCacheStore } from "../../src/core/cache.js";
import { GithubClient } from "../../src/core/github.js";
import type { HttpGetOptions, HttpClient, HttpResponse } from "../../src/core/http.js";
import { makeConfig } from "../helpers.js";

type GetLike = (url: string, options?: HttpGetOptions) => Promise<HttpResponse>;

function httpResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers: new Headers(headers),
    body: new TextEncoder().encode(body),
    url: "https://api.github.com/repos/a/b",
  };
}

function harness() {
  const clock = { now: 1_000_000 };
  const cache = createCacheStore({ mode: "memory", dir: "" });
  const get = vi.fn<GetLike>(async () => {
    throw new Error("no response queued");
  });
  //? The mock is a plain object built around vi.fn, asserted to HttpClient exactly like the
  //? tool tests assert their literals to GitHubApi: a concrete vi.fn return cannot satisfy
  //? HttpClient.get under exactOptionalPropertyTypes. Assertions still inspect the same mock.
  const client = new GithubClient({
    http: { get } as unknown as HttpClient,
    cache,
    config: makeConfig(),
    authFingerprint: "test-fingerprint",
    now: () => clock.now,
  });
  return { client, get, clock, cache };
}

describe("GithubClient", () => {
  it("rejects lookalike api hosts with unsupported", async () => {
    const { client, get } = harness();
    await expect(client.api("https://api.github.com.evil.com/x")).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects non-https prefixes and bare origins with unsupported", async () => {
    const { client, get } = harness();
    await expect(client.api("http://api.github.com/repos/a/b")).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(client.api("api.github.com/repos/a/b")).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects traversal, fragments, and relative paths in apiRaw with invalid_params", async () => {
    const { client, get } = harness();
    for (const path of ["//evil.test/x", "/a/../b", "repos/a/b"]) {
      await expect(client.apiRaw(path)).rejects.toMatchObject({ code: "invalid_params" });
    }
    //? The fragment message is asserted at the path-part position: a raw # in the
    //* path is the common case, and the whole-string check rejects it before the
    //* path/query split, so the same message covers a # in the query part.
    await expect(client.apiRaw("/repos/a/b#frag")).rejects.toMatchObject({
      code: "invalid_params",
      message: expect.stringContaining("fragment"),
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("allows dot-dot in the query part and rejects a second query separator", async () => {
    const { client, get } = harness();
    get.mockResolvedValueOnce(
      httpResponse(200, JSON.stringify({ ok: true }), { "content-type": "application/json" }),
    );
    const result = await client.apiRaw("/search/issues?q=stars:10..20");
    expect(result.status).toBe(200);
    expect(get.mock.calls[0]![0]).toBe("https://api.github.com/search/issues?q=stars:10..20");
    await expect(client.apiRaw("/search/issues?q=a?b")).rejects.toMatchObject({
      code: "invalid_params",
      message: expect.stringContaining("at most one query string separator"),
    });
  });

  it("rejects percent-encoded dot segments and lets dots inside longer segments pass", async () => {
    const { client, get } = harness();
    //? WHATWG URL normalization (what fetch applies) collapses %2e variants into
    //* real path traversal, so every case form of a dot-only encoded segment must
    //* be rejected even though the raw text contains no literal "..".
    for (const path of ["/repos/a/%2e%2e/b", "/repos/a/.%2E/b", "/repos/a/%2e./b"]) {
      await expect(client.apiRaw(path)).rejects.toMatchObject({ code: "invalid_params" });
    }
    expect(get).not.toHaveBeenCalled();
    //? .. inside a longer segment is a plain file name, not a traversal step, and
    //* %2e%2ex decodes to ..x which is likewise a longer segment, not "..".
    get.mockResolvedValueOnce(
      httpResponse(200, JSON.stringify({ ok: true }), { "content-type": "application/json" }),
    );
    const file = await client.apiRaw("/repos/a/contents/my..file.md");
    expect(file.status).toBe(200);
    expect(get.mock.calls[0]![0]).toBe("https://api.github.com/repos/a/contents/my..file.md");
    get.mockResolvedValueOnce(
      httpResponse(200, JSON.stringify({ ok: true }), { "content-type": "application/json" }),
    );
    const dotX = await client.apiRaw("/repos/a/%2e%2ex/b");
    expect(dotX.status).toBe(200);
    expect(get.mock.calls[1]![0]).toBe("https://api.github.com/repos/a/%2e%2ex/b");
  });

  it("rejects non-raw hosts in raw with unsupported", async () => {
    const { client, get } = harness();
    await expect(client.raw("https://api.github.com/repos/a/b")).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(client.raw("https://raw.githubusercontent.com.evil.com/x")).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("parses JSON and returns data on a 200", async () => {
    const { client, get } = harness();
    get.mockResolvedValueOnce(
      httpResponse(200, JSON.stringify({ hello: "world" }), {
        "content-type": "application/json; charset=utf-8",
      }),
    );
    const result = await client.api<{ hello: string }>("/repos/a/b");
    expect(result.data).toEqual({ hello: "world" });
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("application/json; charset=utf-8");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![0]).toBe("https://api.github.com/repos/a/b");
  });

  it("maps invalid JSON to upstream", async () => {
    const { client, get } = harness();
    get.mockResolvedValueOnce(
      httpResponse(200, "<html>not json</html>", { "content-type": "text/html" }),
    );
    await expect(client.api("/repos/a/b")).rejects.toMatchObject({ code: "upstream" });
  });

  it("serves fresh entries from the cache until the TTL expires", async () => {
    const { client, get, clock } = harness();
    get.mockResolvedValue(
      httpResponse(200, JSON.stringify({ n: 1 }), { "content-type": "application/json", etag: '"v1"' }),
    );
    await client.api("/repos/a/b", { cacheTtlMs: 60_000 });
    const withinTtl = await client.api<{ n: number }>("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(withinTtl.data).toEqual({ n: 1 });
    expect(get).toHaveBeenCalledTimes(1);

    clock.now += 61_000;
    await client.api("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("revalidates with if-none-match and replays the cached body on 304", async () => {
    const { client, get, clock } = harness();
    get.mockResolvedValueOnce(
      httpResponse(200, JSON.stringify({ n: 1 }), { "content-type": "application/json", etag: '"v1"' }),
    );
    const first = await client.api<{ n: number }>("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(first.data).toEqual({ n: 1 });

    clock.now += 61_000;
    get.mockResolvedValueOnce(httpResponse(304, ""));
    const second = await client.api<{ n: number }>("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(second.data).toEqual({ n: 1 });
    expect(second.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(2);
    const secondOptions = get.mock.calls[1]![1];
    expect(secondOptions?.headers?.["if-none-match"]).toBe('"v1"');
  });

  it("caches apiRaw JSON responses and reports hit with age", async () => {
    const { client, get, clock } = harness();
    get.mockResolvedValue(
      httpResponse(200, JSON.stringify({ ok: true }), {
        "content-type": "application/json",
        etag: '"v1"',
      }),
    );
    await client.apiRaw("/repos/a/b", { cacheTtlMs: 60_000 });
    const hit = await client.apiRaw("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(get).toHaveBeenCalledTimes(1);
    expect(hit.cache).toEqual({ state: "hit", ageSeconds: 0 });
    expect(new TextDecoder().decode(hit.bytes)).toBe(JSON.stringify({ ok: true }));

    clock.now += 5_000;
    const aged = await client.apiRaw("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(aged.cache).toEqual({ state: "hit", ageSeconds: 5 });
  });

  it("revalidates a stale apiRaw entry and reports revalidated", async () => {
    const { client, get, clock } = harness();
    get.mockResolvedValueOnce(
      httpResponse(200, JSON.stringify({ ok: true }), { "content-type": "application/json", etag: '"v1"' }),
    );
    await client.apiRaw("/repos/a/b", { cacheTtlMs: 60_000 });
    clock.now += 61_000;
    get.mockResolvedValueOnce(httpResponse(304, ""));
    const result = await client.apiRaw("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(result.cache).toEqual({ state: "revalidated", ageSeconds: 0 });
    expect(result.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache for non-text content types", async () => {
    const { client, get } = harness();
    const binary = new Uint8Array([0, 1, 2, 3]);
    get.mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/octet-stream" }),
      body: binary,
      url: "https://api.github.com/repos/a/b",
    });
    const first = await client.apiRaw("/repos/a/b", { cacheTtlMs: 60_000 });
    const second = await client.apiRaw("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(get).toHaveBeenCalledTimes(2);
    expect(first.cache).toEqual({ state: "miss" });
    expect(second.cache).toEqual({ state: "miss" });
    expect(second.bytes).toEqual(binary);
  });

  it("honors fresh on apiRaw and reports miss", async () => {
    const { client, get } = harness();
    get.mockResolvedValue(
      httpResponse(200, JSON.stringify({ ok: true }), { "content-type": "application/json" }),
    );
    await client.apiRaw("/repos/a/b", { cacheTtlMs: 60_000 });
    const fresh = await client.apiRaw("/repos/a/b", { fresh: true, cacheTtlMs: 60_000 });
    expect(get).toHaveBeenCalledTimes(2);
    expect(fresh.cache).toEqual({ state: "miss" });
  });

  it("carries quota from the live response headers on a miss", async () => {
    const { client, get } = harness();
    get.mockResolvedValueOnce(
      httpResponse(200, JSON.stringify({ n: 1 }), {
        "content-type": "application/json",
        "x-ratelimit-resource": "core",
        "x-ratelimit-remaining": "4990",
      }),
    );
    const miss = await client.api<{ n: number }>("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(miss.cache).toEqual({ state: "miss" });
    expect(miss.quota).toEqual({ resource: "core", remaining: 4990 });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("stores the quota pair on a miss and reports it from the entry on a hit", async () => {
    const { client, get } = harness();
    get.mockResolvedValueOnce(
      httpResponse(200, JSON.stringify({ n: 1 }), {
        "content-type": "application/json",
        etag: '"v1"',
        "x-ratelimit-resource": "core",
        "x-ratelimit-remaining": "4990",
      }),
    );
    await client.api<{ n: number }>("/repos/a/b", { cacheTtlMs: 60_000 });
    const hit = await client.api<{ n: number }>("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(hit.cache).toEqual({ state: "hit", ageSeconds: 0 });
    expect(hit.quota).toEqual({ resource: "core", remaining: 4990 });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("serves a hit with quota undefined when the entry was stored without quota fields", async () => {
    const { client, get, clock, cache } = harness();
    //* Part 1 wrote entries without quota fields; seeding the store directly
    //* reproduces such an entry so no cache migration can be smuggled in.
    const url = "https://api.github.com/repos/a/b";
    await cache.set(cacheKey(url, "test-fingerprint"), {
      version: 1,
      url,
      etag: null,
      last_modified: null,
      link: null,
      fetched_at: clock.now,
      status: 200,
      content_type: "application/json",
      body: JSON.stringify({ n: 1 }),
    });
    const hit = await client.api<{ n: number }>("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(hit.data).toEqual({ n: 1 });
    expect(hit.cache).toEqual({ state: "hit", ageSeconds: 0 });
    expect(hit.quota).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it("revalidation refreshes quota from the 304 headers and the refreshed pair is stored", async () => {
    const { client, get, clock } = harness();
    get.mockResolvedValueOnce(
      httpResponse(200, JSON.stringify({ n: 1 }), {
        "content-type": "application/json",
        etag: '"v1"',
        "x-ratelimit-resource": "core",
        "x-ratelimit-remaining": "4990",
      }),
    );
    await client.api<{ n: number }>("/repos/a/b", { cacheTtlMs: 60_000 });

    clock.now += 61_000;
    get.mockResolvedValueOnce(
      httpResponse(304, "", { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "4980" }),
    );
    const revalidated = await client.api<{ n: number }>("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(revalidated.cache).toEqual({ state: "revalidated", ageSeconds: 0 });
    expect(revalidated.quota).toEqual({ resource: "core", remaining: 4980 });

    const hit = await client.api<{ n: number }>("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(hit.cache).toEqual({ state: "hit", ageSeconds: 0 });
    expect(hit.quota).toEqual({ resource: "core", remaining: 4980 });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("revalidation keeps the stored quota when the 304 headers carry none", async () => {
    const { client, get, clock } = harness();
    get.mockResolvedValueOnce(
      httpResponse(200, JSON.stringify({ n: 1 }), {
        "content-type": "application/json",
        etag: '"v1"',
        "x-ratelimit-resource": "core",
        "x-ratelimit-remaining": "4990",
      }),
    );
    await client.api<{ n: number }>("/repos/a/b", { cacheTtlMs: 60_000 });

    clock.now += 61_000;
    get.mockResolvedValueOnce(httpResponse(304, ""));
    const revalidated = await client.api<{ n: number }>("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(revalidated.cache).toEqual({ state: "revalidated", ageSeconds: 0 });
    expect(revalidated.quota).toEqual({ resource: "core", remaining: 4990 });
  });

  it("omits quota when the remaining header is missing or not a finite number", async () => {
    const { client, get } = harness();
    get.mockResolvedValueOnce(
      httpResponse(200, JSON.stringify({ n: 1 }), {
        "content-type": "application/json",
        "x-ratelimit-resource": "core",
      }),
    );
    const noRemaining = await client.api<{ n: number }>("/repos/a/b", { cacheTtlMs: 60_000 });
    expect(noRemaining.quota).toBeUndefined();

    get.mockResolvedValueOnce(
      httpResponse(200, JSON.stringify({ n: 2 }), {
        "content-type": "application/json",
        "x-ratelimit-resource": "core",
        "x-ratelimit-remaining": "not-a-number",
      }),
    );
    const badRemaining = await client.api<{ n: number }>("/repos/a/b", { fresh: true, cacheTtlMs: 60_000 });
    expect(badRemaining.quota).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
