import { z } from "zod";
import type { ToolContext } from "../core/context.js";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import type { MetaSource } from "./meta.js";
import { responseMeta, scarcestMeta } from "./meta.js";
import { listEnvelope, parseNextPage } from "./pagination.js";
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
    const result = await ctx.client.api<UserResponse>(`/users/${user}`, {
      cacheTtlMs: 300_000,
    });
    const { data } = result;
    const meta = responseMeta(result);
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
      //? meta is spread last so it trails the fixed keys and stays absent entirely
      //* when the client reported no cache outcome.
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});

//* Stars ranking cannot be expressed upstream, so the handler gathers the
//* repository window itself: upstream default order at 100 per page, capped at
//* 10 pages so one profiling call cannot spend unbounded core quota.
const GATHER_PER_PAGE = 100;
const MAX_GATHER_PAGES = 10;

//? Projects one REST repo payload into the house row; the fork and stars fields
//* it emits are exactly what the client-side filters act on.
function projectRepo(repo: RepoResponse) {
  return {
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
  };
}

type RepoItem = ReturnType<typeof projectRepo>;

//? Client-side filters shared by both modes: forks drop unless include_forks
//* opts back in (profiling use-case: forks are noise), and min_stars keeps only
//* rows at or above the star floor.
function applyRepoFilters(items: RepoItem[], includeForks: boolean | undefined, minStars: number | undefined): RepoItem[] {
  return items.filter(
    (item) => (includeForks === true || !item.fork) && (minStars === undefined || item.stars >= minStars),
  );
}

interface GatherResult {
  payloads: RepoResponse[];
  //* Every page response the gather issued, kept for the scarcest-meta report:
  //* the lowest remaining across pages is the honest worst case.
  results: MetaSource[];
  //* true only when the 10-page cap — not the data — stopped the walk.
  truncated: boolean;
}

//? Walks the repositories endpoint in upstream default order until the Link
//* envelope runs out or the page cap stops the walk; each page's Link-derived
//* next_page (the same parse listEnvelope reports) decides whether to continue,
//* so a truncated gather is a prefix of the user's repositories.
async function gatherRepos(
  ctx: ToolContext,
  user: string,
  type: string | undefined,
  fresh: boolean | undefined,
): Promise<GatherResult> {
  const payloads: RepoResponse[] = [];
  const results: MetaSource[] = [];
  //? The first fetch is unconditional; afterwards the previous page's Link
  //* envelope decides whether another page exists.
  let nextPage: number | null = 1;
  for (let page = 1; nextPage !== null && page <= MAX_GATHER_PAGES; page += 1) {
    const query = githubQuery({ type, page, per_page: GATHER_PER_PAGE });
    const result = await ctx.client.api<RepoResponse[]>(`/users/${user}/repos${query}`, {
      fresh,
      cacheTtlMs: 120_000,
    });
    results.push(result);
    payloads.push(...result.data);
    nextPage = parseNextPage(result.headers.get("link"));
  }
  return { payloads, results, truncated: nextPage !== null };
}

export const userReposTool = defineTool({
  name: "github_user_repos",
  title: "GitHub user repositories",
  description:
    "List a user's public repositories with the house projection: visibility, fork status, stars, watchers, language, push time, and description; type defaults to owner. Forks are dropped by default (include_forks: true keeps them) and min_stars keeps repositories at or above the star floor; both filters are client-side, so a filtered page can come back short. sort: stars gathers up to 10 pages of 100 client-side, ranks by stars descending, and reports has_more/next_page from the filtered window with gather_truncated when the cap stopped the gather. Costs 1 core call, up to 10 with sort: stars. Returns {items[{name, full_name, private, visibility, fork, stars, watchers, language, pushed_at, description, html_url}], page, per_page, has_more, next_page, gather_truncated}.",
  inputSchema: {
    user: z.string().regex(LOGIN_PATTERN).describe("GitHub user login, like octocat (alphanumerics and hyphens)"),
    type: z.enum(["all", "owner", "public", "private", "member"]).optional().describe("Filter by relationship to the user: all, owner, public, private, or member"),
    sort: z.enum(["created", "updated", "pushed", "full_name", "stars"]).optional().describe("Sort field: created, updated, pushed, full_name, or stars (stars ranks client-side)"),
    order: z.enum(["asc", "desc"]).optional().describe("Sort order: asc or desc"),
    min_stars: z.number().int().min(0).optional().describe("Keep repositories with at least this many stars (client-side filter)"),
    include_forks: z.boolean().optional().describe("Keep fork repositories in the results; defaults to false, pass true to include them"),
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

    //? In-gather mode: rank the filtered window in memory and slice the
    //* requested page out of it; has_more/next_page describe that window, so a
    //* cap-truncated gather still pages honestly through what was gathered.
    if (input.sort === "stars") {
      const gathered = await gatherRepos(ctx, user, input.type, input.fresh);
      const ranked = applyRepoFilters(gathered.payloads.map(projectRepo), input.include_forks, input.min_stars)
        //* filter() returns a fresh array, so the in-place stable sort is safe;
        //* ties keep the upstream order the gather saw.
        .sort((a, b) => b.stars - a.stars);
      const start = (page - 1) * perPage;
      const windowItems = ranked.slice(start, start + perPage);
      const hasMore = start + perPage < ranked.length;
      //? Multi-request mode: the scarcest observation across every gathered
      //* page (lowest remaining, tagged with its resource) is the honest worst
      //* case, undefined when nothing produced a result.
      const meta = scarcestMeta(gathered.results);
      return {
        items: windowItems,
        page,
        per_page: perPage,
        has_more: hasMore,
        next_page: hasMore ? page + 1 : null,
        //? gather_truncated appears only when the cap stopped the gather, the
        //* same conditional spread the meta key uses.
        ...(gathered.truncated ? { gather_truncated: true } : {}),
        ...(meta !== undefined ? { meta } : {}),
      };
    }

    const query = githubQuery({ type: input.type, sort: input.sort, order: input.order, page, per_page: perPage });
    const result = await ctx.client.api<RepoResponse[]>(`/users/${user}/repos${query}`, {
      fresh: input.fresh,
      cacheTtlMs: 120_000,
    });
    const { data, headers } = result;
    const meta = responseMeta(result);
    //? Passthrough mode: filters apply per page, so a filtered page can come
    //* back short while has_more/next_page stay Link-derived (the search
    //* public_only precedent, documented in the description).
    const items = applyRepoFilters(data.map(projectRepo), input.include_forks, input.min_stars);
    //? meta is spread after the list envelope so it stays the trailing key and
    //* stays absent entirely when the client reported no cache outcome.
    return {
      ...listEnvelope(items, page, perPage, headers.get("link")),
      ...(meta !== undefined ? { meta } : {}),
    };
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
    const result = await ctx.client.api<StarredResponse[]>(`/users/${user}/starred${query}`, {
      fresh: input.fresh,
      cacheTtlMs: 300_000,
      accept: "application/vnd.github.star+json",
    });
    const { data, headers } = result;
    const meta = responseMeta(result);
    const items = data.map((entry) => ({
      repo: entry.repo.full_name,
      stars: entry.repo.stargazers_count,
      language: entry.repo.language,
      starred_at: entry.starred_at,
      pushed_at: entry.repo.pushed_at,
    }));
    //? meta is spread after the list envelope so it stays the trailing key and
    //* stays absent entirely when the client reported no cache outcome.
    return {
      ...listEnvelope(items, page, perPage, headers.get("link")),
      ...(meta !== undefined ? { meta } : {}),
    };
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
    const result = await ctx.client.api<EventResponse[]>(`/users/${user}/events/public${query}`, {
      fresh: input.fresh,
      cacheTtlMs: 60_000,
    });
    const { data, headers } = result;
    const meta = responseMeta(result);
    const items = data.map((event) => ({
      type: event.type,
      repo: event.repo.name,
      created_at: event.created_at,
    }));
    //? meta is spread after the list envelope so it stays the trailing key and
    //* stays absent entirely when the client reported no cache outcome.
    return {
      ...listEnvelope(items, page, perPage, headers.get("link")),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
