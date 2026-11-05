import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { searchCodeTool, searchIssuesTool, searchReposTool } from "../../src/tools/search.js";
import { makeConfig } from "../helpers.js";

//? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
//! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
function clientWith(data: unknown) {
  return {
    api: vi.fn(async () => ({ data, headers: new Headers(), status: 200, contentType: "application/json" })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

describe("github_search_repos", () => {
  it("maps repository results", async () => {
    const client = clientWith({
      total_count: 2,
      incomplete_results: false,
      items: [
        {
          full_name: "rust-lang/rust",
          description: "Empowering everyone",
          stargazers_count: 100,
          forks_count: 10,
          language: "Rust",
          updated_at: "2024-01-01T00:00:00Z",
          html_url: "https://github.com/rust-lang/rust",
        },
      ],
    });
    const output = await searchReposTool.handler(
      { query: "rust", sort: "stars", per_page: 1 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith(
      "/search/repositories?q=rust&sort=stars&page=1&per_page=1",
      { fresh: undefined, cacheTtlMs: 300_000 },
    );
    expect(output).toMatchObject({
      total_count: 2,
      incomplete_results: false,
      items: [
        {
          full_name: "rust-lang/rust",
          stars: 100,
          forks: 10,
          language: "Rust",
        },
      ],
    });
  });

  const mixed = {
    total_count: 3,
    incomplete_results: false,
    items: [
      {
        full_name: "o/public",
        description: null,
        private: false,
        visibility: "public",
        stargazers_count: 1,
        forks_count: 0,
        language: null,
        updated_at: "2026-11-01T00:00:00Z",
        html_url: "https://github.com/o/public",
      },
      {
        full_name: "o/private",
        description: null,
        private: true,
        stargazers_count: 0,
        forks_count: 0,
        language: null,
        updated_at: "2026-11-01T00:00:00Z",
        html_url: "https://github.com/o/private",
      },
      {
        full_name: "o/inner",
        description: null,
        private: false,
        visibility: "internal",
        stargazers_count: 2,
        forks_count: 1,
        language: "TypeScript",
        updated_at: "2026-11-02T00:00:00Z",
        html_url: "https://github.com/o/inner",
      },
    ],
  };

  it("keeps every item by default and projects visibility", async () => {
    const client = clientWith(mixed);
    const output = await searchReposTool.handler(
      { query: "x" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output.total_count).toBe(3);
    expect(output.filtered_count).toBe(0);
    const items = output.items as Array<{ full_name: string; private: boolean; visibility: string }>;
    expect(items.map((item) => [item.full_name, item.private, item.visibility])).toEqual([
      ["o/public", false, "public"],
      ["o/private", true, "private"],
      ["o/inner", false, "internal"],
    ]);
  });

  it("drops private items and counts them when public_only is true", async () => {
    const client = clientWith(mixed);
    const output = await searchReposTool.handler(
      { query: "x", public_only: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output.total_count).toBe(3);
    expect(output.filtered_count).toBe(1);
    const items = output.items as Array<{ full_name: string }>;
    expect(items.map((item) => item.full_name)).toEqual(["o/public", "o/inner"]);
  });
});

describe("github_search_code", () => {
  it("requests text matches and requires a token", async () => {
    const client = clientWith({
      total_count: 1,
      incomplete_results: false,
      items: [
        {
          repository: { full_name: "o/r" },
          path: "src/a.ts",
          sha: "abc",
          html_url: "https://github.com/o/r/blob/main/src/a.ts",
          text_matches: [{ fragment: "hello", matches: [{ text: "hello", indices: [0, 5] }] }],
        },
      ],
    });
    const output = await searchCodeTool.handler(
      { query: "hello repo:o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith(
      "/search/code?q=hello+repo%3Ao%2Fr&page=1&per_page=20",
      {
        fresh: undefined,
        cacheTtlMs: 300_000,
        accept: "application/vnd.github.text-match+json",
      },
    );
    expect(output).toMatchObject({
      items: [
        {
          repo: "o/r",
          path: "src/a.ts",
          sha: "abc",
          text_matches: [{ fragment: "hello", matches: [{ text: "hello", indices: [0, 5] }] }],
        },
      ],
    });
  });

  it("rejects anonymous access with auth_missing", async () => {
    await expect(
      searchCodeTool.handler(
        { query: "hello" },
        { client: clientWith({}), config: makeConfig(), authFingerprint: "anonymous" },
      ),
    ).rejects.toMatchObject({ code: "auth_missing" });
  });
});

describe("github_search_issues", () => {
  it("maps issue and pull request results", async () => {
    const client = clientWith({
      total_count: 1,
      incomplete_results: false,
      items: [
        {
          number: 3,
          title: "Bug",
          state: "open",
          user: { login: "alice" },
          updated_at: "2024-01-01T00:00:00Z",
          html_url: "https://github.com/o/r/issues/3",
          repository_url: "https://api.github.com/repos/o/r",
        },
      ],
    });
    const output = await searchIssuesTool.handler(
      { query: "is:issue repo:o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      items: [
        {
          repo: "o/r",
          number: 3,
          title: "Bug",
          state: "open",
          type: "issue",
          author: "alice",
        },
      ],
    });
  });
});
