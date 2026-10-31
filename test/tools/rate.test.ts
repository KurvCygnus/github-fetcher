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
});
