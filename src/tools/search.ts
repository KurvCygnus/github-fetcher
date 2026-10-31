import { z } from "zod";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
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
  stargazers_count: number;
  forks_count: number;
  language: string | null;
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
    "Search repositories by GitHub search syntax. Supports stars, forks, help-wanted-issues, and updated sorting.",
  inputSchema: {
    query: z.string().describe("GitHub repository search query"),
    sort: z.enum(["stars", "forks", "help-wanted-issues", "updated"]).optional().describe("Sort field"),
    order: z.enum(["asc", "desc"]).optional().describe("Sort order"),
    page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
    per_page: z.number().int().min(1).max(100).optional().describe("Items per page, default 20"),
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
    const { data, headers } = await ctx.client.api<SearchResponse<RepoItem>>(
      `/search/repositories${query}`,
      { fresh: input.fresh, cacheTtlMs: 300_000 },
    );
    const items = data.items.map((repo) => ({
      full_name: repo.full_name,
      description: repo.description,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      language: repo.language,
      updated_at: repo.updated_at,
      html_url: repo.html_url,
    }));
    return searchEnvelope(
      items,
      data.total_count,
      data.incomplete_results,
      page,
      perPage,
      headers.get("link"),
    );
  },
});

export const searchCodeTool = defineTool({
  name: "github_search_code",
  title: "GitHub code search",
  description:
    "Search code across GitHub. Requires a token; GitHub allows this endpoint only 10 requests/minute and caps results at 1000.",
  inputSchema: {
    query: z.string().describe("GitHub code search query"),
    page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
    per_page: z.number().int().min(1).max(100).optional().describe("Items per page, default 20"),
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
    const { data, headers } = await ctx.client.api<SearchResponse<CodeItem>>(
      `/search/code${query}`,
      {
        fresh: input.fresh,
        cacheTtlMs: 300_000,
        accept: "application/vnd.github.text-match+json",
      },
    );
    const items = data.items.map((item) => ({
      repo: item.repository.full_name,
      path: item.path,
      sha: item.sha,
      html_url: item.html_url,
      text_matches: item.text_matches ?? [],
    }));
    return searchEnvelope(
      items,
      data.total_count,
      data.incomplete_results,
      page,
      perPage,
      headers.get("link"),
    );
  },
});

export const searchIssuesTool = defineTool({
  name: "github_search_issues",
  title: "GitHub issue and pull request search",
  description:
    "Search issues and pull requests with GitHub search syntax, such as is:issue, is:pr, state:open, or repo:owner/name. For per-repository aggregate counts, use github_repo_health.",
  inputSchema: {
    query: z.string().describe("GitHub issue search query"),
    sort: z.enum(["comments", "reactions", "created", "updated"]).optional().describe("Sort field"),
    order: z.enum(["asc", "desc"]).optional().describe("Sort order"),
    page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
    per_page: z.number().int().min(1).max(100).optional().describe("Items per page, default 20"),
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
    const { data, headers } = await ctx.client.api<SearchResponse<IssueItem>>(
      `/search/issues${query}`,
      { fresh: input.fresh, cacheTtlMs: 300_000 },
    );
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
    return searchEnvelope(
      items,
      data.total_count,
      data.incomplete_results,
      page,
      perPage,
      headers.get("link"),
    );
  },
});
