import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/github.js";
import { commitsTool } from "../../src/tools/commits.js";
import { makeConfig } from "../helpers.js";

describe("github_commits", () => {
  it("maps commits and forwards filters", async () => {
    const link = '<https://api.github.com/repos/o/r/commits?page=2>; rel="next"';
    //? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
    //! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
    const client = {
      api: vi.fn(async () => ({
        data: [
          {
            sha: "1234567890",
            html_url: "https://github.com/o/r/commit/1234567890",
            commit: {
              message: "fix: thing",
              author: { name: "A", email: "a@example.com", date: "2024-01-01T00:00:00Z" },
            },
            author: { login: "a" },
          },
        ],
        headers: new Headers({ link }),
        status: 200,
        contentType: "application/json",
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const output = await commitsTool.handler(
      { repo: "o/r", ref: "main", path: "src", per_page: 1 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith(
      "/repos/o/r/commits?sha=main&path=src&page=1&per_page=1",
      { fresh: undefined, cacheTtlMs: 120_000 },
    );
    expect(output).toEqual({
      items: [
        {
          sha: "1234567890",
          short_sha: "1234567",
          message: "fix: thing",
          author: { name: "A", email: "a@example.com", login: "a" },
          date: "2024-01-01T00:00:00Z",
          url: "https://github.com/o/r/commit/1234567890",
        },
      ],
      page: 1,
      per_page: 1,
      has_more: true,
      next_page: 2,
    });
  });
});
