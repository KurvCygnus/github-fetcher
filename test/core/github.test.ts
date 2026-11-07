import { describe, expect, it, vi } from "vitest";
import { createCacheStore } from "../../src/core/cache.js";
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
  return { client, get, clock };
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
    for (const path of ["//evil.test/x", "/a/../b", "/repos/a/b#frag", "repos/a/b"]) {
      await expect(client.apiRaw(path)).rejects.toMatchObject({ code: "invalid_params" });
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("allows dot-dot and rejects only raw fragments inside the query part", async () => {
    const { client, get } = harness();
    get.mockResolvedValueOnce(
      httpResponse(200, JSON.stringify({ ok: true }), { "content-type": "application/json" }),
    );
    const result = await client.apiRaw("/search/issues?q=stars:10..20");
    expect(result.status).toBe(200);
    expect(get.mock.calls[0]![0]).toBe("https://api.github.com/search/issues?q=stars:10..20");
    await expect(client.apiRaw("/search/issues?q=stars:10..20&x=1#frag")).rejects.toMatchObject({
      code: "invalid_params",
      message: expect.stringContaining("fragment"),
    });
    await expect(client.apiRaw("/search/issues?q=a?b")).rejects.toMatchObject({
      code: "invalid_params",
      message: expect.stringContaining("at most one query string separator"),
    });
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
});
