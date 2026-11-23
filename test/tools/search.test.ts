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
          created_at: "2010-06-01T00:00:00Z",
          pushed_at: "2024-01-01T00:00:00Z",
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
          created_at: "2010-06-01T00:00:00Z",
          pushed_at: "2024-01-01T00:00:00Z",
        },
      ],
    });
  });

  const mixed = {
    total_count: 4,
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
        created_at: "2020-01-01T00:00:00Z",
        pushed_at: "2026-11-01T00:00:00Z",
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
        created_at: "2021-02-01T00:00:00Z",
        pushed_at: "2026-11-01T00:00:00Z",
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
        topics: ["mcp"],
        license: { spdx_id: "MIT" },
        created_at: "2022-03-02T00:00:00Z",
        pushed_at: "2026-11-02T00:00:00Z",
        updated_at: "2026-11-02T00:00:00Z",
        html_url: "https://github.com/o/inner",
      },
      {
        full_name: "o/plain",
        description: null,
        private: false,
        visibility: "public",
        stargazers_count: 3,
        forks_count: 2,
        language: "Go",
        created_at: "2023-04-03T00:00:00Z",
        pushed_at: "2026-11-03T00:00:00Z",
        updated_at: "2026-11-03T00:00:00Z",
        html_url: "https://github.com/o/plain",
      },
    ],
  };

  it("filters private items by default and reports them", async () => {
    const client = clientWith(mixed);
    const output = await searchReposTool.handler(
      { query: "x" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output.total_count).toBe(4);
    expect(output.filtered_count).toBe(1);
    const items = output.items as Array<{ full_name: string }>;
    expect(items.map((item) => item.full_name)).toEqual(["o/public", "o/inner", "o/plain"]);
  });

  it("keeps every item when public_only is false", async () => {
    const client = clientWith(mixed);
    const output = await searchReposTool.handler(
      { query: "x", public_only: false },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output.total_count).toBe(4);
    expect(output.filtered_count).toBe(0);
    const items = output.items as Array<{ full_name: string; private: boolean; visibility: string }>;
    expect(items.map((item) => [item.full_name, item.private, item.visibility])).toEqual([
      ["o/public", false, "public"],
      ["o/private", true, "private"],
      ["o/inner", false, "internal"],
      ["o/plain", false, "public"],
    ]);
  });

  it("filters private items when public_only is true explicitly", async () => {
    const client = clientWith(mixed);
    const output = await searchReposTool.handler(
      { query: "x", public_only: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output.filtered_count).toBe(1);
  });

  it("carries topics and license in repository items", async () => {
    const client = clientWith(mixed);
    const output = await searchReposTool.handler(
      { query: "x" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const items = output.items as Array<{ full_name: string; topics: string[]; license: string | null }>;
    const inner = items.find((item) => item.full_name === "o/inner");
    expect(inner?.topics).toEqual(["mcp"]);
    expect(inner?.license).toBe("MIT");
    const plain = items.find((item) => item.full_name === "o/plain");
    expect(plain?.topics).toEqual([]);
    expect(plain?.license).toBeNull();
  });

  it("carries created_at and pushed_at in repository items", async () => {
    const client = clientWith(mixed);
    const output = await searchReposTool.handler(
      { query: "x", public_only: false },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const items = output.items as Array<{ full_name: string; created_at: string; pushed_at: string }>;
    expect(items.map((item) => [item.full_name, item.created_at, item.pushed_at])).toEqual([
      ["o/public", "2020-01-01T00:00:00Z", "2026-11-01T00:00:00Z"],
      ["o/private", "2021-02-01T00:00:00Z", "2026-11-01T00:00:00Z"],
      ["o/inner", "2022-03-02T00:00:00Z", "2026-11-02T00:00:00Z"],
      ["o/plain", "2023-04-03T00:00:00Z", "2026-11-03T00:00:00Z"],
    ]);
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

  it("keeps non-repo code query tokens in their original order", async () => {
    const client = clientWith({ total_count: 0, incomplete_results: false, items: [] });
    const ctx = { client, config: makeConfig(), authFingerprint: "abc" };
    await searchCodeTool.handler({ query: "label:bug hello" }, ctx);
    expect(client.api).toHaveBeenCalledWith(
      "/search/code?q=label%3Abug+hello&page=1&per_page=20",
      {
        fresh: undefined,
        cacheTtlMs: 300_000,
        accept: "application/vnd.github.text-match+json",
      },
    );
  });

  it("canonicalizes only repo:/path: and leaves state: in its original position", async () => {
    const client = clientWith({ total_count: 0, incomplete_results: false, items: [] });
    const ctx = { client, config: makeConfig(), authFingerprint: "abc" };
    await searchCodeTool.handler({ query: "path:src state:open repo:o/r hello" }, ctx);
    expect(client.api).toHaveBeenCalledWith(
      "/search/code?q=state%3Aopen+hello+repo%3Ao%2Fr+path%3Asrc&page=1&per_page=20",
      {
        fresh: undefined,
        cacheTtlMs: 300_000,
        accept: "application/vnd.github.text-match+json",
      },
    );
  });
});

describe("github_search_issues", () => {
  it("keeps non-repo issue search on /search/issues with its original envelope", async () => {
    const client = clientWith({
      total_count: 1,
      incomplete_results: false,
      items: [
        {
          number: 3,
          title: "Bug",
          state: "open",
          user: { login: "alice" },
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          html_url: "https://github.com/o/r/issues/3",
          repository_url: "https://api.github.com/repos/o/r",
        },
      ],
    });
    const output = await searchIssuesTool.handler(
      { query: "is:issue" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith(
      "/search/issues?q=is%3Aissue&page=1&per_page=20",
      { fresh: undefined, cacheTtlMs: 300_000 },
    );
    expect(output).toMatchObject({
      total_count: 1,
      incomplete_results: false,
      items: [
        {
          repo: "o/r",
          number: 3,
          title: "Bug",
          state: "open",
          type: "issue",
          author: "alice",
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
      page: 1,
      per_page: 20,
      has_more: false,
      next_page: null,
    });
  });

  it("repo-scoped issue search uses the REST issues endpoint with an honest null total", async () => {
    const client = clientWith([
      {
        number: 38322,
        title: "Regression on render",
        state: "open",
        user: { login: "alice" },
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-02T00:00:00Z",
        html_url: "https://github.com/facebook/react/issues/38322",
        repository_url: "https://api.github.com/repos/facebook/react",
      },
      {
        number: 38323,
        title: "A pull request",
        state: "open",
        user: { login: "bob" },
        created_at: "2026-10-03T00:00:00Z",
        updated_at: "2026-10-04T00:00:00Z",
        html_url: "https://github.com/facebook/react/pull/38323",
        repository_url: "https://api.github.com/repos/facebook/react",
        pull_request: { url: "https://api.github.com/repos/facebook/react/pulls/38323" },
      },
    ]);
    const ctx = { client, config: makeConfig(), authFingerprint: "abc" };
    const result = await searchIssuesTool.handler(
      { query: 'repo:facebook/react label:"Type: Regression" state:open', sort: "created", order: "desc", page: 1, per_page: 5 },
      ctx,
    );
    expect(client.api).toHaveBeenCalledWith(
      "/repos/facebook/react/issues?state=open&labels=Type%3A+Regression&sort=created&direction=desc&page=1&per_page=5",
      { fresh: undefined, cacheTtlMs: 300_000 },
    );
    expect(result).toMatchObject({
      total_count: null,
      incomplete_results: true,
      repo_scoped: true,
      filtered_count: 1,
      has_more: false,
      next_page: null,
    });
    expect(result.items).toEqual([expect.objectContaining({ number: 38322, created_at: "2026-10-01T00:00:00Z" })]);
    //? Handlers return Record<string, unknown>, so the array is narrowed at the
    //* assertion boundary using the same cast pattern as the other list suites.
    const items = result.items as Array<{ pull_request?: unknown }>;
    expect(items.some((item) => item.pull_request !== undefined)).toBe(false);
  });

  it("repo-scoped issue search rejects sort: reactions with a hint", async () => {
    const client = clientWith({});
    const ctx = { client, config: makeConfig(), authFingerprint: "abc" };
    await expect(searchIssuesTool.handler({ query: "repo:facebook/react", sort: "reactions" }, ctx)).rejects.toMatchObject({
      code: "invalid_params",
      hint: expect.stringContaining("sort: reactions"),
    });
    expect(client.api).not.toHaveBeenCalled();
  });

  //? The repo branch builds its REST query only from parsed repo/state/label
  //* qualifiers, so any leftover token would be silently discarded and the
  //* caller would believe a text filter was applied. Both cases must reject.
  const unsupportedHint =
    "Repo-scoped issue search supports only repo:, state:, and label: qualifiers plus sort/order/page/per_page. Remove free text and other qualifiers, or drop repo: to use full-text search.";

  it("repo-scoped issue search rejects free-text terms with a self-correcting hint", async () => {
    const client = clientWith({});
    const ctx = { client, config: makeConfig(), authFingerprint: "abc" };
    await expect(
      searchIssuesTool.handler({ query: 'repo:facebook/react "login bug"' }, ctx),
    ).rejects.toMatchObject({
      code: "invalid_params",
      message: "Unsupported terms in a repo-scoped issue query.",
      details: { hint: unsupportedHint },
    });
    expect(client.api).not.toHaveBeenCalled();
  });

  it("repo-scoped issue search rejects other qualifiers with a self-correcting hint", async () => {
    const client = clientWith({});
    const ctx = { client, config: makeConfig(), authFingerprint: "abc" };
    await expect(
      searchIssuesTool.handler({ query: "repo:facebook/react is:pr" }, ctx),
    ).rejects.toMatchObject({
      code: "invalid_params",
      message: "Unsupported terms in a repo-scoped issue query.",
      details: { hint: unsupportedHint },
    });
    expect(client.api).not.toHaveBeenCalled();
  });
});
