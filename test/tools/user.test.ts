import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { userEventsTool, userReposTool, userStarredTool, userTool } from "../../src/tools/user.js";
import { makeConfig } from "../helpers.js";

//? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
//! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
function clientWith(data: unknown) {
  return {
    api: vi.fn(async () => ({ data, headers: new Headers(), status: 200, contentType: "application/json", cache: { state: "miss" } })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

//* Repo fixture carrying exactly the fields the projection reads; the stars
//* count and fork flag drive every filter and ranking test.
function repoFixture(name: string, stars: number, fork = false) {
  return {
    name,
    full_name: `octocat/${name}`,
    private: false,
    fork,
    stargazers_count: stars,
    watchers_count: stars,
    language: "TypeScript",
    pushed_at: "2026-01-02T03:04:05Z",
    description: null,
    html_url: `https://github.com/octocat/${name}`,
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

function requestedUrls(client: GitHubApi, prefix: string): string[] {
  const api = (client as unknown as { api: { mock: { calls: Array<[string, unknown]> } } }).api;
  return api.mock.calls.map((call) => call[0]).filter((url) => url.startsWith(prefix));
}

function namesOf(items: unknown): string[] {
  return (items as Array<{ name: string }>).map((item) => item.name);
}

describe("user login validation", () => {
  it("rejects logins outside the GitHub charset with invalid_params", async () => {
    const ctx = { client: clientWith({}), config: makeConfig(), authFingerprint: "abc" };
    for (const tool of [userTool, userReposTool, userStarredTool, userEventsTool]) {
      await expect(
        tool.handler({ user: "../octocat" }, ctx),
      ).rejects.toMatchObject({ code: "invalid_params" });
    }
  });
});

describe("github_user", () => {
  it("projects the profile fields", async () => {
    const client = clientWith({
      login: "octocat",
      name: "The Octocat",
      type: "User",
      bio: null,
      company: "@github",
      location: "San Francisco",
      blog: "https://github.blog",
      public_repos: 8,
      followers: 1000,
      following: 9,
      created_at: "2011-01-25T18:44:36Z",
      html_url: "https://github.com/octocat",
    });
    const output = await userTool.handler(
      { user: "octocat" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/users/octocat", { cacheTtlMs: 300_000 });
    expect(output).toEqual({
      login: "octocat",
      name: "The Octocat",
      type: "User",
      bio: null,
      company: "@github",
      location: "San Francisco",
      blog: "https://github.blog",
      public_repos: 8,
      followers: 1000,
      following: 9,
      created_at: "2011-01-25T18:44:36Z",
      html_url: "https://github.com/octocat",
      meta: { cache: "miss" },
    });
  });

  it("maps absent profile fields to null", async () => {
    const client = clientWith({
      login: "octocat",
      type: "Organization",
      public_repos: 0,
      followers: 0,
      following: 0,
      created_at: "2011-01-25T18:44:36Z",
      html_url: "https://github.com/octocat",
    });
    const output = await userTool.handler(
      { user: "octocat" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      login: "octocat",
      name: null,
      type: "Organization",
      bio: null,
      company: null,
      location: null,
      blog: null,
      public_repos: 0,
      followers: 0,
      following: 0,
      created_at: "2011-01-25T18:44:36Z",
      html_url: "https://github.com/octocat",
      meta: { cache: "miss" },
    });
  });
});

describe("github_user_repos", () => {
  it("projects repository items with the visibility fallback", async () => {
    const client = clientWith([
      {
        name: "hello-world",
        full_name: "octocat/hello-world",
        private: false,
        fork: false,
        stargazers_count: 1,
        watchers_count: 1,
        language: "TypeScript",
        pushed_at: "2026-01-02T03:04:05Z",
        description: "First repo",
        html_url: "https://github.com/octocat/hello-world",
      },
      {
        name: "private-repo",
        full_name: "octocat/private-repo",
        private: true,
        //* fork: false keeps this item visible under the default fork filter;
        //* fork filtering itself has its own suite below.
        fork: false,
        stargazers_count: 0,
        watchers_count: 0,
        language: null,
        pushed_at: "2026-02-03T04:05:06Z",
        description: null,
        html_url: "https://github.com/octocat/private-repo",
      },
    ]);
    const output = await userReposTool.handler(
      { user: "octocat" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/users/octocat/repos?page=1&per_page=20", {
      fresh: undefined,
      cacheTtlMs: 120_000,
    });
    expect(output).toEqual({
      items: [
        {
          name: "hello-world",
          full_name: "octocat/hello-world",
          private: false,
          visibility: "public",
          fork: false,
          stars: 1,
          watchers: 1,
          language: "TypeScript",
          pushed_at: "2026-01-02T03:04:05Z",
          description: "First repo",
          html_url: "https://github.com/octocat/hello-world",
        },
        {
          name: "private-repo",
          full_name: "octocat/private-repo",
          private: true,
          visibility: "private",
          fork: false,
          stars: 0,
          watchers: 0,
          language: null,
          pushed_at: "2026-02-03T04:05:06Z",
          description: null,
          html_url: "https://github.com/octocat/private-repo",
        },
      ],
      page: 1,
      per_page: 20,
      has_more: false,
      next_page: null,
      meta: { cache: "miss" },
    });
  });

  it("passes visibility through when the payload carries it", async () => {
    const client = clientWith([
      {
        name: "inner",
        full_name: "octocat/inner",
        private: false,
        visibility: "internal",
        fork: false,
        stargazers_count: 2,
        watchers_count: 2,
        language: "Go",
        pushed_at: "2026-03-04T05:06:07Z",
        description: null,
        html_url: "https://github.com/octocat/inner",
      },
    ]);
    const output = await userReposTool.handler(
      { user: "octocat" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const items = output.items as Array<{ visibility: string }>;
    expect(items[0]?.visibility).toBe("internal");
  });

  it("forwards type, sort, order, and pagination to the endpoint", async () => {
    const client = clientWith([]);
    await userReposTool.handler(
      { user: "octocat", type: "owner", sort: "pushed", order: "desc", page: 2, per_page: 5, fresh: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith(
      "/users/octocat/repos?type=owner&sort=pushed&order=desc&page=2&per_page=5",
      { fresh: true, cacheTtlMs: 120_000 },
    );
  });
});

describe("github_user_repos filters", () => {
  it("drops forks by default and keeps them with include_forks", async () => {
    const client = clientWith([repoFixture("hello-world", 1), repoFixture("forked-lab", 3, true)]);
    const filtered = await userReposTool.handler(
      { user: "octocat" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    //? The fork filter is client-side, so the upstream request stays the plain
    //* paginated read no matter how the filters are set.
    expect(client.api).toHaveBeenCalledWith("/users/octocat/repos?page=1&per_page=20", {
      fresh: undefined,
      cacheTtlMs: 120_000,
    });
    expect(namesOf(filtered.items)).toEqual(["hello-world"]);

    const kept = await userReposTool.handler(
      { user: "octocat", include_forks: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(namesOf(kept.items)).toEqual(["hello-world", "forked-lab"]);
  });

  it("applies min_stars per page and keeps the envelope Link-derived", async () => {
    const client = clientWithRoutes({
      "/users/octocat/repos": () => ({
        data: [repoFixture("five", 5), repoFixture("zero", 0), repoFixture("two", 2)],
        link: nextLink("octocat", 2),
      }),
    });
    const output = await userReposTool.handler(
      { user: "octocat", min_stars: 1 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(namesOf(output.items)).toEqual(["five", "two"]);
    //? Passthrough mode: filtering can leave the page short but the Link header
    //* still decides has_more/next_page (the search public_only precedent).
    expect(output.has_more).toBe(true);
    expect(output.next_page).toBe(2);
    expect(requestedUrls(client, "/users/octocat/repos")).toEqual(["/users/octocat/repos?page=1&per_page=20"]);
  });

  it("ranks a two-page gather by stars and reports the scarcest meta", async () => {
    const client = clientWithRoutes({
      "/users/octocat/repos": (page) => {
        if (page === 1) {
          return {
            data: [repoFixture("ten", 10), repoFixture("forty", 40)],
            link: nextLink("octocat", 2),
            quota: { resource: "core", remaining: 48 },
          };
        }
        if (page === 2) {
          return { data: [repoFixture("twenty-five", 25), repoFixture("seven", 7)], quota: { resource: "core", remaining: 47 } };
        }
        throw new Error(`unexpected gather page ${page}`);
      },
    });
    const page1 = await userReposTool.handler(
      { user: "octocat", sort: "stars", per_page: 2 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    //? The gather walks pages 1-2 at per_page 100 in upstream order and the
    //* ranked window is [40, 25, 10, 7], so page 1 of the window is [40, 25].
    expect(namesOf(page1.items)).toEqual(["forty", "twenty-five"]);
    expect(page1).toMatchObject({ page: 1, per_page: 2, has_more: true, next_page: 2 });
    expect(page1.meta).toEqual({ cache: "miss", quota: { resource: "core", remaining: 47 } });
    expect("gather_truncated" in page1).toBe(false);

    const page2 = await userReposTool.handler(
      { user: "octocat", sort: "stars", page: 2, per_page: 2 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(namesOf(page2.items)).toEqual(["ten", "seven"]);
    expect(page2).toMatchObject({ page: 2, per_page: 2, has_more: false, next_page: null });

    //? Each windowed request re-gathers the whole ranking, so both requests
    //* walk pages 1-2 at per_page 100 with no sort forwarded upstream.
    expect(requestedUrls(client, "/users/octocat/repos")).toEqual([
      "/users/octocat/repos?page=1&per_page=100",
      "/users/octocat/repos?page=2&per_page=100",
      "/users/octocat/repos?page=1&per_page=100",
      "/users/octocat/repos?page=2&per_page=100",
    ]);
  });

  it("caps the stars gather at ten pages and flags gather_truncated", async () => {
    const client = clientWithRoutes({
      "/users/octocat/repos": (page) => {
        if (page > 12) throw new Error(`unexpected gather page ${page}`);
        const stars = (page - 1) * 100;
        return {
          data: Array.from({ length: 100 }, (_, index) => repoFixture(`repo-${stars + index}`, stars + index)),
          //* Every page advertises a next page, so only the 10-page cap can
          //* stop the gather.
          link: nextLink("octocat", page + 1),
        };
      },
    });
    const output = await userReposTool.handler(
      { user: "octocat", sort: "stars" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(requestedUrls(client, "/users/octocat/repos")).toEqual(
      Array.from({ length: 10 }, (_, index) => `/users/octocat/repos?page=${index + 1}&per_page=100`),
    );
    expect(output.gather_truncated).toBe(true);
    //? The gathered window holds stars 0-999, so the top 20 run repo-999 down
    //* to repo-980.
    expect(namesOf(output.items)).toEqual(Array.from({ length: 20 }, (_, index) => `repo-${999 - index}`));
    expect(output.has_more).toBe(true);
    expect(output.next_page).toBe(2);
  });

  it("drops forks from the stars-sorted window and ranks them back in with include_forks", async () => {
    const client = clientWithRoutes({
      "/users/octocat/repos": (page) => {
        if (page === 1) {
          return { data: [repoFixture("giant-fork", 500, true), repoFixture("small", 30)], link: nextLink("octocat", 2) };
        }
        return { data: [repoFixture("tiny", 10)] };
      },
    });
    const filtered = await userReposTool.handler(
      { user: "octocat", sort: "stars" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(namesOf(filtered.items)).toEqual(["small", "tiny"]);

    const kept = await userReposTool.handler(
      { user: "octocat", sort: "stars", include_forks: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(namesOf(kept.items)).toEqual(["giant-fork", "small", "tiny"]);
  });

  it("returns an empty envelope for a user whose repositories are all forks", async () => {
    const client = clientWith([repoFixture("fork-a", 4, true), repoFixture("fork-b", 0, true)]);
    const output = await userReposTool.handler(
      { user: "octocat" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output.items).toEqual([]);
    expect(output).toMatchObject({ page: 1, per_page: 20, has_more: false, next_page: null });
  });
});

describe("github_user_starred", () => {
  it("requests star+json and projects the starred repo fields", async () => {
    const client = clientWith([
      {
        starred_at: "2026-03-04T05:06:07Z",
        repo: {
          full_name: "vercel/ai",
          stargazers_count: 12,
          language: "TypeScript",
          pushed_at: "2026-03-01T00:00:00Z",
        },
      },
    ]);
    const output = await userStarredTool.handler(
      { user: "octocat", page: 1, per_page: 20 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/users/octocat/starred?page=1&per_page=20", {
      fresh: undefined,
      cacheTtlMs: 300_000,
      accept: "application/vnd.github.star+json",
    });
    expect(output).toEqual({
      items: [
        {
          repo: "vercel/ai",
          stars: 12,
          language: "TypeScript",
          starred_at: "2026-03-04T05:06:07Z",
          pushed_at: "2026-03-01T00:00:00Z",
        },
      ],
      page: 1,
      per_page: 20,
      has_more: false,
      next_page: null,
      meta: { cache: "miss" },
    });
  });
});

describe("github_user_events", () => {
  it("projects event items with the repository name", async () => {
    const client = clientWith([
      {
        type: "PushEvent",
        repo: { id: 1, name: "octocat/hello-world" },
        created_at: "2026-04-05T06:07:08Z",
      },
      {
        type: "WatchEvent",
        repo: { id: 2, name: "octocat/private-repo" },
        created_at: "2026-04-06T07:08:09Z",
      },
    ]);
    const output = await userEventsTool.handler(
      { user: "octocat" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/users/octocat/events/public?page=1&per_page=20", {
      fresh: undefined,
      cacheTtlMs: 60_000,
    });
    expect(output).toEqual({
      items: [
        { type: "PushEvent", repo: "octocat/hello-world", created_at: "2026-04-05T06:07:08Z" },
        { type: "WatchEvent", repo: "octocat/private-repo", created_at: "2026-04-06T07:08:09Z" },
      ],
      page: 1,
      per_page: 20,
      has_more: false,
      next_page: null,
      meta: { cache: "miss" },
    });
  });

  it("returns an empty envelope for a page with no events", async () => {
    const client = clientWith([]);
    const output = await userEventsTool.handler(
      { user: "octocat" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      items: [],
      page: 1,
      per_page: 20,
      has_more: false,
      next_page: null,
      meta: { cache: "miss" },
    });
  });
});
