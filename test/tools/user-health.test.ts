import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { userHealthTool } from "../../src/tools/user-health.js";
import { makeConfig } from "../helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;

//? ISO timestamp the given number of days (fractions allowed) before the
//* current clock; the 90-day metrics read this field.
function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

//? Gather fixture in the raw REST shape; only the fields the metrics read are
//* meaningful, the rest keeps the payload realistic.
function repoFixture(options: {
  name: string;
  stars: number;
  fork?: boolean;
  language?: string | null;
  pushedAt?: string | null;
}) {
  return {
    name: options.name,
    full_name: `octocat/${options.name}`,
    private: false,
    fork: options.fork ?? false,
    stargazers_count: options.stars,
    watchers_count: options.stars,
    language: options.language ?? null,
    pushed_at: options.pushedAt ?? null,
    description: null,
    html_url: `https://github.com/octocat/${options.name}`,
  };
}

function userFixture() {
  return {
    login: "octocat",
    name: "The Octocat",
    type: "User",
    public_repos: 8,
    created_at: "2011-01-25T18:44:36Z",
    html_url: "https://github.com/octocat",
  };
}

interface PageReply {
  data: unknown;
  link?: string;
  quota?: { resource: string; remaining: number };
}

//* The rel="next" Link header GitHub sends while further pages exist; the URL
//* only has to carry a parseable page param for parseNextPage.
function nextLink(user: string, page: number): string {
  return `<https://api.github.com/users/${user}/repos?page=${page}&per_page=100>; rel="next"`;
}

//? Routes switch on pathname and hand the parsed page number to the route, so a
//! gather can serve different content per page; an unrouted URL or page fails
//! loudly instead of silently returning a wrong-shaped page.
function clientWithRoutes(routes: Record<string, (page: number) => PageReply>) {
  return {
    api: vi.fn(async (url: string) => {
      const parsed = new URL(`https://api.github.com${url}`);
      const route = routes[parsed.pathname];
      if (route === undefined) throw new Error(`unexpected url ${url}`);
      const reply = route(Number(parsed.searchParams.get("page") ?? "1"));
      return {
        data: reply.data,
        headers: new Headers(reply.link === undefined ? {} : { link: reply.link }),
        status: 200,
        contentType: "application/json",
        cache: { state: "miss" },
        ...(reply.quota !== undefined ? { quota: reply.quota } : {}),
      };
    }),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

function ctxFor(client: GitHubApi) {
  return { client, config: makeConfig(), authFingerprint: "abc" };
}

function requestedUrls(client: GitHubApi): string[] {
  const api = (client as unknown as { api: { mock: { calls: Array<[string, unknown]> } } }).api;
  return api.mock.calls.map((call) => call[0]);
}

function fullNamesOf(items: unknown): string[] {
  return (items as Array<{ full_name: string }>).map((item) => item.full_name);
}

//* Mixed audit fixture: one heavily starred fork plus five originals with
//* distinct stars, languages, and push times — one outside the 90-day window,
//* one with no language, one tied on stars with alpha to pin the stable sort.
//* The pushed_at strings are captured so expectations reuse the exact values.
function auditFixture() {
  const pushed = {
    forkOfReact: daysAgo(3),
    alpha: daysAgo(5),
    beta: daysAgo(45.5),
    gamma: daysAgo(100),
    delta: daysAgo(10),
    epsilon: daysAgo(1),
  };
  const repos = [
    repoFixture({ name: "fork-of-react", stars: 900, fork: true, language: "TypeScript", pushedAt: pushed.forkOfReact }),
    repoFixture({ name: "alpha", stars: 50, language: "TypeScript", pushedAt: pushed.alpha }),
    repoFixture({ name: "beta", stars: 120, language: "Go", pushedAt: pushed.beta }),
    repoFixture({ name: "gamma", stars: 50, language: "Rust", pushedAt: pushed.gamma }),
    repoFixture({ name: "delta", stars: 7, language: null, pushedAt: pushed.delta }),
    repoFixture({ name: "epsilon", stars: 300, language: "Go", pushedAt: pushed.epsilon }),
  ];
  return { repos, pushed };
}

describe("user login validation", () => {
  it("rejects logins outside the GitHub charset with invalid_params", async () => {
    const ctx = ctxFor(clientWithRoutes({}));
    await expect(userHealthTool.handler({ user: "../octocat" }, ctx)).rejects.toMatchObject({
      code: "invalid_params",
    });
  });
});

describe("github_user_health", () => {
  it("projects the full audit from one profile fetch plus one repos page", async () => {
    const { repos, pushed } = auditFixture();
    const client = clientWithRoutes({
      "/users/octocat": () => ({ data: userFixture(), quota: { resource: "core", remaining: 50 } }),
      "/users/octocat/repos": () => ({ data: repos, quota: { resource: "core", remaining: 47 } }),
    });
    const output = await userHealthTool.handler({ user: "octocat" }, ctxFor(client));
    //? One profile fetch plus one gather page: the walk stops after page 1
    //* because the response carries no rel="next" link.
    expect(requestedUrls(client)).toEqual(["/users/octocat", "/users/octocat/repos?page=1&per_page=100"]);
    expect(output).toEqual({
      user: "octocat",
      name: "The Octocat",
      type: "User",
      public_repos: 8,
      //? 5 originals + 1 fork over all gathered payloads; 1/6 rounds to 0.17.
      originals: 5,
      forks: 1,
      fork_share: 0.17,
      //? Fork stars count toward the account total: 900+300+120+50+50+7.
      total_stars: 1427,
      //? Originals ranked by stars descending; alpha outranks gamma on the
      //* 50-star tie because the stable sort keeps gather order.
      top_repos: [
        { full_name: "octocat/epsilon", stars: 300, language: "Go", pushed_at: pushed.epsilon },
        { full_name: "octocat/beta", stars: 120, language: "Go", pushed_at: pushed.beta },
        { full_name: "octocat/alpha", stars: 50, language: "TypeScript", pushed_at: pushed.alpha },
        { full_name: "octocat/gamma", stars: 50, language: "Rust", pushed_at: pushed.gamma },
        { full_name: "octocat/delta", stars: 7, language: null, pushed_at: pushed.delta },
      ],
      //? Counts come from the originals only (forks are noise by default):
      //* Go twice, TypeScript once, Rust once; delta's null language is skipped.
      languages: { Go: 2, TypeScript: 1, Rust: 1 },
      //? epsilon, alpha, delta, beta pushed inside the window; gamma (100d) and
      //* the fork are outside the default pool.
      recent_pushes_90d: 4,
      //? beta is the oldest active push at 45.5 days, floored to whole days.
      oldest_push_90d_gap_days: 45,
      //? The single page gather was not cap-stopped, so the flag stays absent.
      meta: { cache: "miss", quota: { resource: "core", remaining: 47 }, calls: 2 },
    });
    //? Languages are ordered by count descending; ties keep first-seen order.
    expect(Object.keys(output.languages as Record<string, number>)).toEqual(["Go", "TypeScript", "Rust"]);
    expect("repos_truncated" in output).toBe(false);
  });

  it("zeroes every metric for a user with no public repositories", async () => {
    const client = clientWithRoutes({
      "/users/octocat": () => ({ data: { ...userFixture(), public_repos: 0 } }),
      "/users/octocat/repos": () => ({ data: [] }),
    });
    const output = await userHealthTool.handler({ user: "octocat" }, ctxFor(client));
    expect(output).toEqual({
      user: "octocat",
      name: "The Octocat",
      type: "User",
      public_repos: 0,
      originals: 0,
      forks: 0,
      fork_share: 0,
      total_stars: 0,
      top_repos: [],
      languages: {},
      recent_pushes_90d: 0,
      oldest_push_90d_gap_days: null,
      //? The walk still spends its one repos page, so the batch costs 2 calls.
      meta: { cache: "miss", calls: 2 },
    });
    expect("repos_truncated" in output).toBe(false);
  });

  it("flags repos_truncated when the gather walks into the ten-page cap", async () => {
    const client = clientWithRoutes({
      "/users/octocat": () => ({ data: userFixture(), quota: { resource: "core", remaining: 60 } }),
      "/users/octocat/repos": (page) => ({
        data: [repoFixture({ name: `repo-${page}`, stars: page, language: "Go", pushedAt: daysAgo(page) })],
        //? Every page advertises a next page, so only the 10-page cap stops the walk.
        link: nextLink("octocat", page + 1),
        quota: { resource: "core", remaining: 56 - page },
      }),
    });
    const output = await userHealthTool.handler({ user: "octocat" }, ctxFor(client));
    expect(requestedUrls(client)).toEqual([
      "/users/octocat",
      ...Array.from({ length: 10 }, (_, index) => `/users/octocat/repos?page=${index + 1}&per_page=100`),
    ]);
    expect(output.originals).toBe(10);
    expect(output.forks).toBe(0);
    expect(output.repos_truncated).toBe(true);
    //? One profile fetch + ten gather pages = 11 calls; the scarcest remaining
    //* is page 10's 46.
    expect(output.meta).toEqual({ cache: "miss", quota: { resource: "core", remaining: 46 }, calls: 11 });
  });

  it("keeps forks out of the detail metrics by default and folds them back in with include_forks", async () => {
    const { repos } = auditFixture();
    const routes = {
      "/users/octocat": () => ({ data: userFixture() }),
      "/users/octocat/repos": () => ({ data: repos }),
    };
    const withoutForks = await userHealthTool.handler({ user: "octocat" }, ctxFor(clientWithRoutes(routes)));
    const withForks = await userHealthTool.handler({ user: "octocat", include_forks: true }, ctxFor(clientWithRoutes(routes)));
    //? The split and the star total cover every gathered repository either way;
    //* include_forks only reshapes the detail metrics.
    expect(withoutForks).toMatchObject({ originals: 5, forks: 1, fork_share: 0.17, total_stars: 1427 });
    expect(withForks).toMatchObject({ originals: 5, forks: 1, fork_share: 0.17, total_stars: 1427 });
    //? Default: originals only. Included: the 900-star fork tops the list and
    //* pushes delta (7 stars) out of the top 5.
    expect(fullNamesOf(withoutForks.top_repos)).toEqual([
      "octocat/epsilon",
      "octocat/beta",
      "octocat/alpha",
      "octocat/gamma",
      "octocat/delta",
    ]);
    expect(fullNamesOf(withForks.top_repos)).toEqual([
      "octocat/fork-of-react",
      "octocat/epsilon",
      "octocat/beta",
      "octocat/alpha",
      "octocat/gamma",
    ]);
    expect(withoutForks.languages).toEqual({ Go: 2, TypeScript: 1, Rust: 1 });
    expect(withForks.languages).toEqual({ TypeScript: 2, Go: 2, Rust: 1 });
    expect(Object.keys(withForks.languages as Record<string, number>)).toEqual(["TypeScript", "Go", "Rust"]);
    expect(withoutForks.recent_pushes_90d).toBe(4);
    //? The fork was pushed 3 days ago, so it joins the active set when included.
    expect(withForks.recent_pushes_90d).toBe(5);
    expect(withForks.oldest_push_90d_gap_days).toBe(withoutForks.oldest_push_90d_gap_days);
  });

  it("reports the scarcest quota across the profile fetch and both gathered pages", async () => {
    const client = clientWithRoutes({
      "/users/octocat": () => ({ data: userFixture(), quota: { resource: "core", remaining: 30 } }),
      "/users/octocat/repos": (page) => {
        if (page === 1) {
          return {
            data: [repoFixture({ name: "one", stars: 1, language: "Go", pushedAt: daysAgo(1) })],
            link: nextLink("octocat", 2),
            quota: { resource: "core", remaining: 60 },
          };
        }
        return { data: [repoFixture({ name: "two", stars: 2, language: "Go", pushedAt: daysAgo(2) })], quota: { resource: "core", remaining: 45 } };
      },
    });
    const output = await userHealthTool.handler({ user: "octocat" }, ctxFor(client));
    //? The profile fetch itself is the scarcest observation (30 < 45 < 60) and
    //* the batch spent exactly three upstream calls.
    expect(output.meta).toEqual({ cache: "miss", quota: { resource: "core", remaining: 30 }, calls: 3 });
    //? Stars and ranking span both pages: 1 + 2 stars, ranked by stars.
    expect(output.total_stars).toBe(3);
    expect(fullNamesOf(output.top_repos)).toEqual(["octocat/two", "octocat/one"]);
  });

  it("forwards fresh to both the profile fetch and the gather", async () => {
    const client = clientWithRoutes({
      "/users/octocat": () => ({ data: userFixture() }),
      "/users/octocat/repos": () => ({ data: [] }),
    });
    await userHealthTool.handler({ user: "octocat", fresh: true }, ctxFor(client));
    expect(client.api).toHaveBeenNthCalledWith(1, "/users/octocat", { fresh: true, cacheTtlMs: 300_000 });
    expect(client.api).toHaveBeenNthCalledWith(2, "/users/octocat/repos?page=1&per_page=100", {
      fresh: true,
      cacheTtlMs: 120_000,
    });
  });
});

describe("github_user_health 90-day window", () => {
  //* The fake clock pins Date.now() inside the handler to the fixture reference,
  //* so exact-cutoff pushes are assertable instead of racing the real clock.
  const frozen = new Date("2026-11-16T12:00:00Z");
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(frozen);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function routedClient(repos: unknown[]) {
    return clientWithRoutes({
      "/users/octocat": () => ({ data: userFixture() }),
      "/users/octocat/repos": () => ({ data: repos }),
    });
  }

  it("counts a push exactly at the 90-day cutoff and drops one millisecond older", async () => {
    const client = routedClient([
      repoFixture({ name: "at-cutoff", stars: 1, language: "Go", pushedAt: new Date(frozen.getTime() - 90 * DAY_MS).toISOString() }),
      repoFixture({ name: "one-ms-older", stars: 2, language: "Go", pushedAt: new Date(frozen.getTime() - 90 * DAY_MS - 1).toISOString() }),
      repoFixture({ name: "never-pushed", stars: 3, language: "Go", pushedAt: null }),
    ]);
    const output = await userHealthTool.handler({ user: "octocat" }, ctxFor(client));
    expect(output.recent_pushes_90d).toBe(1);
    //? Exactly 90 whole days have elapsed, so the floored gap reads 90; the
    //* excluded one-millisecond-older neighbor proves the cutoff is inclusive.
    expect(output.oldest_push_90d_gap_days).toBe(90);
  });

  it("floors the oldest gap across the active pushes", async () => {
    const client = routedClient([
      repoFixture({ name: "recent", stars: 1, language: "Go", pushedAt: new Date(frozen.getTime() - 5 * DAY_MS).toISOString() }),
      repoFixture({ name: "oldest-active", stars: 2, language: "Go", pushedAt: new Date(frozen.getTime() - 40.5 * DAY_MS).toISOString() }),
    ]);
    const output = await userHealthTool.handler({ user: "octocat" }, ctxFor(client));
    expect(output.recent_pushes_90d).toBe(2);
    //? 40.5 elapsed days floor to 40; a rounding implementation would answer 41.
    expect(output.oldest_push_90d_gap_days).toBe(40);
  });

  it("clamps a clock-skewed future push to a zero-day gap", async () => {
    const client = routedClient([
      repoFixture({ name: "skewed", stars: 1, language: "Go", pushedAt: new Date(frozen.getTime() + 5_000).toISOString() }),
    ]);
    const output = await userHealthTool.handler({ user: "octocat" }, ctxFor(client));
    expect(output.recent_pushes_90d).toBe(1);
    //? A few seconds of skew must read as a 0-day gap, not floor to -1.
    expect(output.oldest_push_90d_gap_days).toBe(0);
  });
});
