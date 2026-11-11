import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { contributorsTool } from "../../src/tools/contributors.js";
import { makeConfig } from "../helpers.js";

//? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
//! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
function clientWith(data: unknown, link: string | null = null) {
  return {
    api: vi.fn(async () => ({ data, headers: new Headers(link ? { link } : {}), status: 200, contentType: "application/json", cache: { state: "miss" } })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

describe("github_contributors", () => {
  it("projects login, type, and contributions inside the list envelope", async () => {
    const client = clientWith([
      { login: "octocat", id: 1, type: "User", contributions: 650 },
      { login: "release-bot[bot]", id: 2, type: "Bot", contributions: 12 },
    ]);
    const output = await contributorsTool.handler(
      { repo: "octocat/hello-world" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/repos/octocat/hello-world/contributors?page=1&per_page=20", {
      fresh: undefined,
      cacheTtlMs: 120_000,
    });
    expect(output).toEqual({
      items: [
        { login: "octocat", type: "User", contributions: 650 },
        { login: "release-bot[bot]", type: "Bot", contributions: 12 },
      ],
      page: 1,
      per_page: 20,
      has_more: false,
      next_page: null,
      meta: { cache: "miss" },
    });
  });

  it("forwards pagination and fresh to the endpoint and reads next_page from the link header", async () => {
    const client = clientWith(
      [{ login: "octocat", type: "User", contributions: 650 }],
      '<https://api.github.com/repos/octocat/hello-world/contributors?page=3&per_page=5>; rel="next"',
    );
    const output = await contributorsTool.handler(
      { repo: "octocat/hello-world", page: 2, per_page: 5, fresh: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/repos/octocat/hello-world/contributors?page=2&per_page=5", {
      fresh: true,
      cacheTtlMs: 120_000,
    });
    expect(output).toEqual({
      items: [{ login: "octocat", type: "User", contributions: 650 }],
      page: 2,
      per_page: 5,
      has_more: true,
      next_page: 3,
      meta: { cache: "miss" },
    });
  });

  it("returns an empty envelope when the repository has no contributors", async () => {
    const client = clientWith([]);
    const output = await contributorsTool.handler(
      { repo: "octocat/hello-world" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      items: [],
      page: 1,
      per_page: 20,
      has_more: false,
      next_page: null,
      meta: { cache: "miss" },
    });
  });

  it("rejects a repo outside owner/name form with invalid_params", async () => {
    const client = clientWith([]);
    await expect(
      contributorsTool.handler(
        { repo: "no-slash" },
        { client, config: makeConfig(), authFingerprint: "abc" },
      ),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});
