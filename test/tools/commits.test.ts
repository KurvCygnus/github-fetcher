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

//? Shared fixture builder: one commit per page, with a distinct sha so the
//? oldest-window assertions can prove which response's items were served.
function commit(sha: string, message = `message ${sha}`) {
  return {
    sha,
    html_url: `https://github.com/o/r/commit/${sha}`,
    commit: {
      message,
      author: { name: "A", email: "a@example.com", date: "2024-01-01T00:00:00Z" },
    },
    author: { login: "a" },
  };
}

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

  it("first: true serves the oldest page from the last rel in two calls", async () => {
    //? Page 1 advertises last=3; the tail is fetched directly (no intermediate
    //? walk) and the second response's items are what the caller receives.
    const client = {
      api: vi.fn(async (url: string) => {
        if (url.includes("page=3")) {
          return {
            data: [commit("ccccccc", "initial commit")],
            headers: new Headers({
              link: '<https://api.github.com/repos/o/r/commits?page=2>; rel="prev"',
            }),
            status: 200,
            contentType: "application/json",
            cache: { state: "miss" },
          };
        }
        return {
          data: [commit("aaaaaaa", "latest commit")],
          headers: new Headers({
            link: '<https://api.github.com/repos/o/r/commits?page=2>; rel="next", <https://api.github.com/repos/o/r/commits?page=3>; rel="last"',
          }),
          status: 200,
          contentType: "application/json",
          cache: { state: "miss" },
        };
      }),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const output = await commitsTool.handler(
      { repo: "o/r", first: true, per_page: 10 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledTimes(2);
    expect(client.api).toHaveBeenNthCalledWith(1, "/repos/o/r/commits?page=1&per_page=10", {
      fresh: undefined,
      cacheTtlMs: 120_000,
    });
    expect(client.api).toHaveBeenNthCalledWith(2, "/repos/o/r/commits?page=3&per_page=10", {
      fresh: undefined,
      cacheTtlMs: 120_000,
    });
    expect(output).toEqual({
      items: [
        {
          sha: "ccccccc",
          short_sha: "ccccccc",
          message: "initial commit",
          author: { name: "A", email: "a@example.com", login: "a" },
          date: "2024-01-01T00:00:00Z",
          url: "https://github.com/o/r/commit/ccccccc",
        },
      ],
      page: 3,
      per_page: 10,
      has_more: false,
      next_page: null,
      pages_in_history: 3,
      meta: { cache: "miss", calls: 2 },
    });
  });

  it("first: true on a single-page history serves page 1 with one call", async () => {
    //? No Link last rel means the whole history fits one page; there is no tail
    //? to fetch, so the tool must not issue a second request or loop.
    const client = {
      api: vi.fn(async () => ({
        data: [commit("aaaaaaa", "only commit")],
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
        cache: { state: "miss" },
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const output = await commitsTool.handler(
      { repo: "o/r", first: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(output).toEqual({
      items: [
        {
          sha: "aaaaaaa",
          short_sha: "aaaaaaa",
          message: "only commit",
          author: { name: "A", email: "a@example.com", login: "a" },
          date: "2024-01-01T00:00:00Z",
          url: "https://github.com/o/r/commit/aaaaaaa",
        },
      ],
      page: 1,
      per_page: 20,
      has_more: false,
      next_page: null,
      pages_in_history: 1,
      meta: { cache: "miss", calls: 1 },
    });
  });

  it("first absent keeps the 0.5.0 envelope byte-identical", async () => {
    //? Exact key order and values pin the default path: no pages_in_history,
    //? Link-derived has_more/next_page preserved, single call reported in meta.
    const client = {
      api: vi.fn(async () => ({
        data: [commit("aaaaaaa")],
        headers: new Headers({
          link: '<https://api.github.com/repos/o/r/commits?page=2>; rel="next"',
        }),
        status: 200,
        contentType: "application/json",
        cache: { state: "miss" },
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const output = await commitsTool.handler(
      { repo: "o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    ) as Record<string, unknown>;
    expect(Object.keys(output)).toEqual(["items", "page", "per_page", "has_more", "next_page", "meta"]);
    expect(output["has_more"]).toBe(true);
    expect(output["next_page"]).toBe(2);
    expect(output["meta"]).toEqual({ cache: "miss", calls: 1 });
    expect(client.api).toHaveBeenCalledTimes(1);
  });

  it("first: true with path forwards every filter to both calls without walking", async () => {
    //? Review focus: last=4 is resolved from the Link header directly, so the
    //? path/author filters ride both requests and no intermediate page is fetched.
    const client = {
      api: vi.fn(async (url: string) => {
        const page = new URL(`https://api.github.com${url}`).searchParams.get("page");
        return {
          data: [commit(page === "4" ? "oldestsha" : "newestsha")],
          headers: new Headers({
            link: '<https://api.github.com/repos/o/r/commits?page=2>; rel="next", <https://api.github.com/repos/o/r/commits?page=4>; rel="last"',
          }),
          status: 200,
          contentType: "application/json",
          cache: { state: "miss" },
        };
      }),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const output = await commitsTool.handler(
      {
        repo: "o/r",
        first: true,
        ref: "main",
        path: "src/lib",
        author: "octocat",
        since: "2024-01-01T00:00:00Z",
        until: "2024-06-01T00:00:00Z",
        per_page: 5,
        max_message_chars: 12,
      },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const urls = (client.api as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map((args) => args[0]);
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      const params = new URL(`https://api.github.com${url}`).searchParams;
      expect(params.get("sha")).toBe("main");
      expect(params.get("path")).toBe("src/lib");
      expect(params.get("author")).toBe("octocat");
      expect(params.get("since")).toBe("2024-01-01T00:00:00Z");
      expect(params.get("until")).toBe("2024-06-01T00:00:00Z");
      expect(params.get("per_page")).toBe("5");
      expect(params.get("max_message_chars")).toBeNull();
    }
    expect(new URL(`https://api.github.com${urls[0]}`).searchParams.get("page")).toBe("1");
    expect(new URL(`https://api.github.com${urls[1]}`).searchParams.get("page")).toBe("4");
    expect(output).toMatchObject({ page: 4, pages_in_history: 4, has_more: false, next_page: null });
  });
});
