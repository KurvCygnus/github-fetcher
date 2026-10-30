import type { Config } from "../src/config.js";

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    proxyMode: "auto",
    cacheMode: "off",
    logLevel: "error",
    timeoutMs: 30000,
    maxFileBytes: 262144,
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
