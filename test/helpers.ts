import { vi } from "vitest";
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
