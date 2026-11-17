import { vi } from "vitest";
import { cacheKey, createCacheStore } from "../src/core/cache.js";
import type { CacheEntry, CacheStore } from "../src/core/cache.js";
import type { Config } from "../src/core/config.js";
import type { GitHubApi } from "../src/core/github.js";

//? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
//! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
export function makeClientWith(data: unknown, headers: Headers = new Headers()): GitHubApi {
  return {
    api: vi.fn(async () => ({ data, headers, status: 200, contentType: "application/json" })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

//? In-memory cache store for offline hint tests: no filesystem, no network.
export function memoryCacheStore(): CacheStore {
  return createCacheStore({ mode: "memory", dir: "" });
}

//? Seeds a tree listing under the exact key the handlers derive
//* (cacheKey(url, fingerprint)); the entry mirrors what GithubClient stores
//* after a 200 JSON response, so hint reads see a realistic cache hit.
export async function seedCacheTree(
  store: CacheStore,
  fingerprint: string,
  url: string,
  body: unknown,
): Promise<void> {
  const entry: CacheEntry = {
    version: 1,
    url,
    etag: null,
    last_modified: null,
    link: null,
    fetched_at: Date.now(),
    status: 200,
    content_type: "application/json",
    body: JSON.stringify(body),
  };
  await store.set(cacheKey(url, fingerprint), entry);
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    proxyMode: "auto",
    cacheMode: "off",
    logLevel: "error",
    timeoutMs: 30000,
    maxFileBytes: 262144,
    exposeIdentity: false,
    ...overrides,
  };
}

export function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}
