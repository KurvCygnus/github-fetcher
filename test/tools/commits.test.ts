import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { commitsTool } from "../../src/tools/commits.js";
import { clearPinnedRef, setPinnedRef } from "../../src/tools/pin.js";
import { makeClientWith, makeConfig } from "../helpers.js";

//? The pin map is module state shared by every test in this file; a leftover
//* entry from the pin cases would otherwise leak into the no-pin assertions.
beforeEach(() => {
  clearPinnedRef("o/r");
});

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
      meta: { cache: "miss", calls: 1 },
    });
  });

  //? One long ASCII message + one short one: the cap clips the long body to N
  //* characters and must leave the short one byte-identical. Pure ASCII keeps
  //* the N-characters expectation equal to truncateText's UTF-8 byte budget.
  const LONG_MESSAGE = "feat: a very long commit message body";
  const SHORT_MESSAGE = "fix: bug";

  const twoCommits = [
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
  ];

  it("honors max_message_chars by clipping long messages and leaving short ones intact", async () => {
    const client = makeClientWith(twoCommits);
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
    const client = makeClientWith(twoCommits);
    const output = await commitsTool.handler(
      { repo: "o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const items = (output as { items: Array<{ message: string }> }).items;
    expect(items.map((item) => item.message)).toEqual([LONG_MESSAGE, SHORT_MESSAGE]);
  });

  it("anchors a ref-less listing to the pinned sha and reports pinned_sha", async () => {
    //? Review focus: the commits request must carry the pinned SHA in its sha
    //* query parameter, not the branch the pin was created from; the pin adds
    //* no upstream call, so the listing stays a single request.
    const link = '<https://api.github.com/repos/o/r/commits?page=2>; rel="next"';
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
    setPinnedRef("o/r", "main", "abc123def456");
    const output = await commitsTool.handler(
      { repo: "o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith(
      "/repos/o/r/commits?sha=abc123def456&page=1&per_page=20",
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
      per_page: 20,
      has_more: true,
      next_page: 2,
      pinned_sha: "abc123def456",
      meta: { cache: "miss", calls: 1 },
    });
  });

  it("lets an explicit ref win over the pin and omits pinned_sha", async () => {
    const client = makeClientWith(twoCommits);
    setPinnedRef("o/r", "main", "abc123def456");
    const output = await commitsTool.handler(
      { repo: "o/r", ref: "main" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/commits?sha=main&page=1&per_page=20", {
      fresh: undefined,
      cacheTtlMs: 120_000,
    });
    expect("pinned_sha" in output).toBe(false);
  });
});
