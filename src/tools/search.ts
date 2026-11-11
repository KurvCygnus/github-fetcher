import { z } from "zod";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { searchEnvelope } from "./pagination.js";
import { githubQuery } from "./util.js";

interface SearchResponse<T> {
  total_count: number;
  incomplete_results: boolean;
  items: T[];
}

interface RepoItem {
  full_name: string;
  description: string | null;
  private: boolean;
  visibility?: string;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  topics?: string[];
  license?: { spdx_id: string | null } | null;
  updated_at: string;
  html_url: string;
}

interface CodeItem {
  repository: { full_name: string };
  path: string;
  sha: string;
  html_url: string;
  text_matches?: unknown[];
}

interface IssueItem {
  number: number;
  title: string;
  state: string;
  user: { login: string } | null;
  updated_at: string;
  html_url: string;
  repository_url: string;
  pull_request?: unknown;
}

export const searchReposTool = defineTool({
  name: "github_search_repos",
  title: "GitHub repository search",
  description:
    "Search repositories by GitHub search syntax. Supports stars, forks, help-wanted-issues, and updated sorting. public_only defaults to true; pass false to include private repositories the token can see. Returns {total_count, incomplete_results, filtered_count, items[{full_name, description, private, visibility, stars, forks, language, topics, license, updated_at, html_url}], page, per_page, has_more, next_page}.",
  inputSchema: {
    query: z.string().describe("GitHub repository search syntax, like stars:>100 language:rust"),
    sort: z.enum(["stars", "forks", "help-wanted-issues", "updated"]).optional().describe("Sort field: stars, forks, help-wanted-issues, or updated"),
    order: z.enum(["asc", "desc"]).optional().describe("Sort order: asc or desc"),
    page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
    per_page: z.number().int().min(1).max(100).optional().describe("Items per page, 1-100, default 20"),
    public_only: z.boolean().optional().describe("Drop private repositories from the results; defaults to true, pass false to include private items the token can see"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const page = input.page ?? 1;
    const perPage = input.per_page ?? 20;
    const query = githubQuery({
      q: input.query,
      sort: input.sort,
      order: input.order,
      page,
      per_page: perPage,
    });
    const result = await ctx.client.api<SearchResponse<RepoItem>>(
      `/search/repositories${query}`,
      { fresh: input.fresh, cacheTtlMs: 300_000 },
    );
    const { data, headers } = result;
    const meta = responseMeta(result);
    const items = data.items.map((repo) => ({
      full_name: repo.full_name,
      description: repo.description,
      private: repo.private,
      visibility: repo.visibility ?? (repo.private ? "private" : "public"),
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      language: repo.language,
      topics: repo.topics ?? [],
      license: repo.license?.spdx_id ?? null,
      updated_at: repo.updated_at,
      html_url: repo.html_url,
    }));
    //* Private repositories the token can see enter raw GitHub search results;
    //* the default view drops them so an agent's report stays public-scoped,
    //* and public_only: false is the explicit way back to the full view.
    const publicOnly = input.public_only ?? true;
    const visible = publicOnly ? items.filter((repo) => !repo.private) : items;
    //? meta is spread after the search envelope so it stays the trailing key and
    //* stays absent entirely when the client reported no cache outcome.
    return {
      ...searchEnvelope(
        visible,
        data.total_count,
        data.incomplete_results,
        page,
        perPage,
        headers.get("link"),
      ),
      filtered_count: items.length - visible.length,
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});

export const searchCodeTool = defineTool({
  name: "github_search_code",
  title: "GitHub code search",
  description:
    "Search code across GitHub. Requires a token; GitHub allows this endpoint only 10 requests/minute and caps results at 1000. Returns {total_count, incomplete_results, items[{repo, path, sha, html_url, text_matches}], page, per_page, has_more, next_page}.",
  inputSchema: {
    query: z.string().describe("GitHub code search query"),
    page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
    per_page: z.number().int().min(1).max(100).optional().describe("Items per page, 1-100, default 20"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    if (ctx.authFingerprint === "anonymous") {
      throw new GithubError("auth_missing", "github_search_code requires GITHUB_TOKEN or a git credential");
    }
    const page = input.page ?? 1;
    const perPage = input.per_page ?? 20;
    const query = githubQuery({ q: input.query, page, per_page: perPage });
    const result = await ctx.client.api<SearchResponse<CodeItem>>(
      `/search/code${query}`,
      {
        fresh: input.fresh,
        cacheTtlMs: 300_000,
        accept: "application/vnd.github.text-match+json",
      },
    );
    const { data, headers } = result;
    const meta = responseMeta(result);
    const items = data.items.map((item) => ({
      repo: item.repository.full_name,
      path: item.path,
      sha: item.sha,
      html_url: item.html_url,
      text_matches: item.text_matches ?? [],
    }));
    //? meta is spread after the search envelope so it stays the trailing key and
    //* stays absent entirely when the client reported no cache outcome.
    return {
      ...searchEnvelope(
        items,
        data.total_count,
        data.incomplete_results,
        page,
        perPage,
        headers.get("link"),
      ),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});

export const searchIssuesTool = defineTool({
  name: "github_search_issues",
  title: "GitHub issue and pull request search",
  description:
    "Search issues and pull requests with GitHub search syntax, such as is:issue, is:pr, state:open, or repo:owner/name. For per-repository aggregate counts, use github_repo_health. Returns {total_count, incomplete_results, items[{repo, number, title, state, type, author, updated_at, html_url}], page, per_page, has_more, next_page}.",
  inputSchema: {
    query: z.string().describe("GitHub issue search query"),
    sort: z.enum(["comments", "reactions", "created", "updated"]).optional().describe("Sort field: comments, reactions, created, or updated"),
    order: z.enum(["asc", "desc"]).optional().describe("Sort order: asc or desc"),
    page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
    per_page: z.number().int().min(1).max(100).optional().describe("Items per page, 1-100, default 20"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const page = input.page ?? 1;
    const perPage = input.per_page ?? 20;
    const query = githubQuery({
      q: input.query,
      sort: input.sort,
      order: input.order,
      page,
      per_page: perPage,
    });
    const result = await ctx.client.api<SearchResponse<IssueItem>>(
      `/search/issues${query}`,
      { fresh: input.fresh, cacheTtlMs: 300_000 },
    );
    const { data, headers } = result;
    const meta = responseMeta(result);
    const items = data.items.map((item) => ({
      repo: item.repository_url.replace(/^https:\/\/api\.github\.com\/repos\//, ""),
      number: item.number,
      title: item.title,
      state: item.state,
      type: item.pull_request === undefined ? "issue" : "pr",
      author: item.user?.login ?? null,
      updated_at: item.updated_at,
      html_url: item.html_url,
    }));
    //? meta is spread after the search envelope so it stays the trailing key and
    //* stays absent entirely when the client reported no cache outcome.
    return {
      ...searchEnvelope(
        items,
        data.total_count,
        data.incomplete_results,
        page,
        perPage,
        headers.get("link"),
      ),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
