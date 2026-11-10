import { z } from "zod";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { listEnvelope } from "./pagination.js";
import { githubQuery } from "./util.js";

//? Only the fields this tool reads are typed; the REST payload carries more.
interface UserResponse {
  login: string;
  name: string | null;
  type: string;
  bio: string | null;
  company: string | null;
  location: string | null;
  blog: string | null;
  public_repos: number;
  followers: number;
  following: number;
  created_at: string;
  html_url: string;
}

interface RepoResponse {
  name: string;
  full_name: string;
  private: boolean;
  visibility?: string;
  fork: boolean;
  stargazers_count: number;
  watchers_count: number;
  language: string | null;
  pushed_at: string | null;
  description: string | null;
  html_url: string;
}

//* With the star+json media type each starred item wraps its repository payload
//* beside the time the star was given; without it the wrapper is absent.
interface StarredResponse {
  starred_at: string | null;
  repo: {
    full_name: string;
    stargazers_count: number;
    language: string | null;
    pushed_at: string | null;
  };
}

interface EventResponse {
  type: string;
  repo: { name: string };
  created_at: string | null;
}

//* GitHub logins are alphanumerics and hyphens, at most 39 characters; the same
//* pattern guards the schema and the handler so ?/#/../ in a login can never
//* reshape the request path (query, truncation, WHATWG normalization).
const LOGIN_PATTERN = /^[A-Za-z0-9-]{1,39}$/;

//? parseRepo house pattern: reject a malformed component early with
//* invalid_params rather than encoding it into a wrong-but-silent read.
function parseUser(login: string): string {
  if (!LOGIN_PATTERN.test(login)) {
    throw new GithubError("invalid_params", "user must be a GitHub login (alphanumerics and hyphens, 1-39 characters)");
  }
  return login;
}

export const userTool = defineTool({
  name: "github_user",
  title: "GitHub user profile",
  description:
    "Read a GitHub user's profile: name, type, bio, company, location, blog, public repository count, and follower counts. Costs 1 core call. Returns {login, name, type, bio, company, location, blog, public_repos, followers, following, created_at, html_url}.",
  inputSchema: {
    user: z.string().regex(LOGIN_PATTERN).describe("GitHub user login, like octocat (alphanumerics and hyphens)"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const user = parseUser(input.user);
    const { data } = await ctx.client.api<UserResponse>(`/users/${user}`, {
      cacheTtlMs: 300_000,
    });
    return {
      login: data.login,
      name: data.name ?? null,
      type: data.type,
      bio: data.bio ?? null,
      company: data.company ?? null,
      location: data.location ?? null,
      blog: data.blog ?? null,
      public_repos: data.public_repos,
      followers: data.followers,
      following: data.following,
      created_at: data.created_at,
      html_url: data.html_url,
    };
  },
});

export const userReposTool = defineTool({
  name: "github_user_repos",
  title: "GitHub user repositories",
  description:
    "List a user's public repositories with the house projection: visibility, fork status, stars, watchers, language, push time, and description; type defaults to owner. Costs 1 core call. Returns {items[{name, full_name, private, visibility, fork, stars, watchers, language, pushed_at, description, html_url}], page, per_page, has_more, next_page}.",
  inputSchema: {
    user: z.string().regex(LOGIN_PATTERN).describe("GitHub user login, like octocat (alphanumerics and hyphens)"),
    type: z.enum(["all", "owner", "public", "private", "member"]).optional().describe("Filter by relationship to the user: all, owner, public, private, or member"),
    sort: z.enum(["created", "updated", "pushed", "full_name"]).optional().describe("Sort field: created, updated, pushed, or full_name"),
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
    const user = parseUser(input.user);
    const page = input.page ?? 1;
    const perPage = input.per_page ?? 20;
    const query = githubQuery({ type: input.type, sort: input.sort, order: input.order, page, per_page: perPage });
    const { data, headers } = await ctx.client.api<RepoResponse[]>(`/users/${user}/repos${query}`, {
      fresh: input.fresh,
      cacheTtlMs: 120_000,
    });
    const items = data.map((repo) => ({
      name: repo.name,
      full_name: repo.full_name,
      private: repo.private,
      visibility: repo.visibility ?? (repo.private ? "private" : "public"),
      fork: repo.fork,
      stars: repo.stargazers_count,
      watchers: repo.watchers_count,
      language: repo.language,
      pushed_at: repo.pushed_at,
      description: repo.description,
      html_url: repo.html_url,
    }));
    return listEnvelope(items, page, perPage, headers.get("link"));
  },
});

export const userStarredTool = defineTool({
  name: "github_user_starred",
  title: "GitHub user stars",
  description:
    "List the repositories a user has starred with the time each star was given; the star+json media type supplies starred_at. Costs 1 core call. Returns {items[{repo, stars, language, starred_at, pushed_at}], page, per_page, has_more, next_page}.",
  inputSchema: {
    user: z.string().regex(LOGIN_PATTERN).describe("GitHub user login, like octocat (alphanumerics and hyphens)"),
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
    const user = parseUser(input.user);
    const page = input.page ?? 1;
    const perPage = input.per_page ?? 20;
    const query = githubQuery({ page, per_page: perPage });
    const { data, headers } = await ctx.client.api<StarredResponse[]>(`/users/${user}/starred${query}`, {
      fresh: input.fresh,
      cacheTtlMs: 300_000,
      accept: "application/vnd.github.star+json",
    });
    const items = data.map((entry) => ({
      repo: entry.repo.full_name,
      stars: entry.repo.stargazers_count,
      language: entry.repo.language,
      starred_at: entry.starred_at,
      pushed_at: entry.repo.pushed_at,
    }));
    return listEnvelope(items, page, perPage, headers.get("link"));
  },
});

export const userEventsTool = defineTool({
  name: "github_user_events",
  title: "GitHub user events",
  description:
    "List a user's public events with the event type, repository, and time; private events are never included, only the public feed. Costs 1 core call. Returns {items[{type, repo, created_at}], page, per_page, has_more, next_page}.",
  inputSchema: {
    user: z.string().regex(LOGIN_PATTERN).describe("GitHub user login, like octocat (alphanumerics and hyphens)"),
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
    const user = parseUser(input.user);
    const page = input.page ?? 1;
    const perPage = input.per_page ?? 20;
    const query = githubQuery({ page, per_page: perPage });
    const { data, headers } = await ctx.client.api<EventResponse[]>(`/users/${user}/events/public${query}`, {
      fresh: input.fresh,
      cacheTtlMs: 60_000,
    });
    const items = data.map((event) => ({
      type: event.type,
      repo: event.repo.name,
      created_at: event.created_at,
    }));
    return listEnvelope(items, page, perPage, headers.get("link"));
  },
});
