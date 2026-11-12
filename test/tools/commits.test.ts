import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
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
        cache: { state: "miss" },
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
      meta: { cache: "miss" },
    });
  });

  //? One long ASCII message + one short one: the cap clips the long body to N
  //* characters and must leave the short one byte-identical. Pure ASCII keeps
  //* the N-characters expectation equal to truncateText's UTF-8 byte budget.
  const LONG_MESSAGE = "feat: a very long commit message body";
  const SHORT_MESSAGE = "fix: bug";

  function twoCommitClient() {
    //? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
    //! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
    return {
      api: vi.fn(async () => ({
        data: [
          {
            sha: "aaaaaaaaaa",
            html_url: "https://github.com/o/r/commit/aaaaaaaaaa",
            commit: {
              message: LONG_MESSAGE,
              author: { name: "A", email: "a@example.com", date: "2024-01-01T00:00:00Z" },
            },
            author: { login: "a" },
          },
          {
            sha: "bbbbbbbbbb",
            html_url: "https://github.com/o/r/commit/bbbbbbbbbb",
            commit: {
              message: SHORT_MESSAGE,
              author: { name: "B", email: "b@example.com", date: "2024-01-02T00:00:00Z" },
            },
            author: null,
          },
        ],
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
  }

  it("honors max_message_chars by clipping long messages and leaving short ones intact", async () => {
    const client = twoCommitClient();
    const output = await commitsTool.handler(
      { repo: "o/r", max_message_chars: 10 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const items = (output as { items: Array<{ message: string }> }).items;
    expect(items.map((item) => item.message)).toEqual(["feat: a ve", SHORT_MESSAGE]);
    expect(items[0]?.message).toHaveLength(10);
    //? The cap is applied client-side after the response, so the input must not
    //* leak into the GitHub query string.
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/commits?page=1&per_page=20", {
      fresh: undefined,
      cacheTtlMs: 120_000,
    });
  });

  it("returns full messages when max_message_chars is absent", async () => {
    const client = twoCommitClient();
    const output = await commitsTool.handler(
      { repo: "o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const items = (output as { items: Array<{ message: string }> }).items;
    expect(items.map((item) => item.message)).toEqual([LONG_MESSAGE, SHORT_MESSAGE]);
  });
});
