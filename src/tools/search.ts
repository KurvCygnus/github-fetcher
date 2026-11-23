import { z } from "zod";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { listEnvelope, searchEnvelope } from "./pagination.js";
import { parseCodeQualifiers, parseSearchQualifiers } from "./search-qualifiers.js";
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
  created_at: string;
  pushed_at: string;
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
  created_at: string;
  updated_at: string;
  html_url: string;
  repository_url: string;
  pull_request?: unknown;
}

//* Both issue search paths return the same upstream issue shape, so one
//* projection keeps created_at and every other row field in lockstep across
//* the non-repo search envelope and the repo-scoped REST envelope.
function projectIssue(item: IssueItem) {
  return {
    repo: item.repository_url.replace(/^https:\/\/api\.github\.com\/repos\//, ""),
    number: item.number,
    title: item.title,
    state: item.state,
    type: item.pull_request === undefined ? "issue" : "pr",
    author: item.user?.login ?? null,
    created_at: item.created_at,
    updated_at: item.updated_at,
    html_url: item.html_url,
  };
}

interface UserItem {
  login: string;
  type: string;
  html_url: string;
}

export const searchReposTool = defineTool({
  name: "github_search_repos",
  title: "GitHub repository search",
  description:
    "Search repositories by GitHub search syntax. Supports stars, forks, help-wanted-issues, and updated sorting. public_only defaults to true; pass false to include private repositories the token can see. Returns {total_count, incomplete_results, filtered_count, items[{full_name, description, private, visibility, stars, forks, language, topics, license, updated_at, created_at, pushed_at, html_url}], page, per_page, has_more, next_page}.",
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
    const meta = responseMeta(result, 1);
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
      created_at: repo.created_at,
      pushed_at: repo.pushed_at,
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
    "Search code across GitHub. Requires a token; GitHub allows this endpoint only 10 requests/minute and caps results at 1000. The repo: and path: qualifiers are parsed from query and re-injected at the end. Returns {total_count, incomplete_results, items[{repo, path, sha, html_url, text_matches}], page, per_page, has_more, next_page}. GitHub's search index lags fresh pushes; recently changed symbols may be missing — cross-check with github_file_grep or github_file.",
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
    //* Recover repo:/path: from the free-form query and rebuild q in one stable
    //* order; every other token stays in the remainder with its original
    //* spelling and order, so non-repo queries keep their exact request bytes.
    const qualifiers = parseCodeQualifiers(input.query);
    const canonicalQuery = [
      qualifiers.remainder,
      ...(qualifiers.repo !== undefined ? [`repo:${qualifiers.repo}`] : []),
      ...(qualifiers.path !== undefined ? [`path:${qualifiers.path}`] : []),
    ].filter((part) => part !== "").join(" ");
    const query = githubQuery({ q: canonicalQuery, page, per_page: perPage });
    const result = await ctx.client.api<SearchResponse<CodeItem>>(
      `/search/code${query}`,
      {
        fresh: input.fresh,
        cacheTtlMs: 300_000,
        accept: "application/vnd.github.text-match+json",
      },
    );
    const { data, headers } = result;
    const meta = responseMeta(result, 1);
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
    "Search issues and pull requests with GitHub search syntax, such as is:issue, is:pr, state:open, or repo:owner/name; the repo:, path:, state:, and label: qualifiers are parsed from query. A repo: query reads the repository issues endpoint with total_count null and repo_scoped true, filtering pull requests into filtered_count; sort: reactions is unsupported on that path. For per-repository aggregate counts, use github_repo_health. Returns {total_count, incomplete_results, items[{repo, number, title, state, type, author, created_at, updated_at, html_url}], page, per_page, has_more, next_page, repo_scoped, filtered_count}.",
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
    const qualifiers = parseSearchQualifiers(input.query);
    //* A repo: qualifier makes GitHub's /search/issues endpoint answer 422, so
    //* repo-scoped reads use the REST issues endpoint. REST supplies no total,
    //* hence an explicit null plus repo_scoped instead of a guessed count.
    if (qualifiers.repo !== undefined) {
      if (input.sort === "reactions") {
        const error = new GithubError("invalid_params", "sort: reactions is unsupported for repo-scoped issue search", {
          hint: "Drop repo: from query or choose another sort.",
        });
        //* Direct callers read the rejection reason off error.hint without the
        //* MCP toResult() unwrapping that lifts details.hint into the envelope.
        Object.assign(error, { hint: error.message });
        throw error;
      }
      const query = githubQuery({
        state: qualifiers.state,
        labels: qualifiers.labels.length > 0 ? qualifiers.labels.join(",") : undefined,
        sort: input.sort,
        direction: input.order,
        page,
        per_page: perPage,
      });
      const result = await ctx.client.api<IssueItem[]>(
        `/repos/${qualifiers.repo}/issues${query}`,
        { fresh: input.fresh, cacheTtlMs: 300_000 },
      );
      const { data, headers } = result;
      const meta = responseMeta(result, 1);
      //* Pull requests share the issues endpoint, so drop them client-side by
      //* their pull_request field before projecting the remaining issue rows.
      const issues = data.filter((item) => item.pull_request === undefined);
      const items = issues.map(projectIssue);
      return {
        ...listEnvelope(items, page, perPage, headers.get("link")),
        total_count: null,
        incomplete_results: true,
        repo_scoped: true,
        filtered_count: data.length - issues.length,
        ...(meta !== undefined ? { meta } : {}),
      };
    }
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
    const meta = responseMeta(result, 1);
    const items = data.items.map(projectIssue);
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

export const searchUsersTool = defineTool({
  name: "github_search_users",
  title: "GitHub user search",
  description:
    "Search GitHub users by query syntax — location, language, followers:>=N, repositories:>=N, fullname: qualifiers. Costs 1 search call; the search quota is 30 requests per minute. Returns {total_count, incomplete_results, items[{login, type, html_url}], page, per_page, has_more, next_page}.",
  inputSchema: {
    query: z.string().describe("GitHub user search syntax, like location:china followers:>=10 repositories:>=8"),
    sort: z.enum(["followers", "repositories", "joined"]).optional().describe("Sort field: followers, repositories, or joined"),
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
    const result = await ctx.client.api<SearchResponse<UserItem>>(
      `/search/users${query}`,
      { fresh: input.fresh, cacheTtlMs: 300_000 },
    );
    const { data, headers } = result;
    const meta = responseMeta(result, 1);
    //* The lean cut is deliberate: upstream items also carry id, node_id,
    //* avatar_url, and score, but profile detail belongs to github_user, so the
    //* row keeps only the three keys an agent needs to pick and then fetch a user.
    const items = data.items.map((user) => ({
      login: user.login,
      type: user.type,
      html_url: user.html_url,
    }));
    //? /search/users works anonymously, unlike /search/code, so there is no
    //* token gate here; the description only warns about the search quota.
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
