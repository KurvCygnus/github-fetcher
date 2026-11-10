import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { issueTool, issuesTool } from "../../src/tools/issues.js";
import { makeConfig } from "../helpers.js";

const issue = {
  number: 7,
  title: "Bug",
  state: "open",
  user: { login: "alice" },
  labels: [{ name: "bug" }],
  assignees: [{ login: "bob" }],
  body: "details",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
  closed_at: null,
  comments: 1,
  html_url: "https://github.com/o/r/issues/7",
};

const comment = {
  user: { login: "carol" },
  body: "me too",
  created_at: "2024-01-03T00:00:00Z",
};

//? Same shape as the issue above plus the pull_request marker the API adds to
//? pull requests, so the list mapping pins both type values.
const pr = {
  ...issue,
  number: 8,
  title: "Fix",
  html_url: "https://github.com/o/r/pull/8",
  pull_request: {},
};

function client(comments: (typeof comment)[] = [comment]) {
  return {
    api: vi.fn(async (url: string) => ({
      data: url.includes("/comments") ? comments : issue,
      headers: new Headers(),
      status: 200,
      contentType: "application/json",
    })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  };
}

describe("github_issue", () => {
  it("includes the latest comments when requested", async () => {
    //? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
    //! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
    const api = client() as unknown as GitHubApi;
    const output = await issueTool.handler(
      { repo: "o/r", number: 7, include_comments: true },
      { client: api, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      number: 7,
      author: "alice",
      labels: ["bug"],
      assignees: ["bob"],
      comments: [{ author: "carol", body: "me too", created_at: "2024-01-03T00:00:00Z" }],
      comments_truncated: false,
    });
    expect(api.api).toHaveBeenCalledWith("/repos/o/r/issues/7", {
      fresh: undefined,
      cacheTtlMs: 120_000,
    });
  });

  it("fetches preceding comment pages when the last page cannot satisfy the limit", async () => {
    const all = Array.from({ length: 101 }, (_, index) => ({
      ...comment,
      body: `comment ${index + 1}`,
      created_at: `2024-01-03T00:00:${String(index % 60).padStart(2, "0")}Z`,
    }));
    const pageUrl = (page: number): string =>
      `https://api.test/repos/o/r/issues/7/comments?per_page=100&page=${page}`;
    const response = (data: typeof all, link: string) => ({
      data,
      headers: new Headers({ link }),
      status: 200,
      contentType: "application/json",
    });
    const apiClient = {
      api: vi.fn(async (url: string) => {
        if (url.includes("/issues/7/comments")) {
          if (url.includes("page=2")) {
            return response(all.slice(100), `<${pageUrl(1)}>; rel="prev"`);
          }
          return response(all.slice(0, 100), `<${pageUrl(2)}>; rel="last"`);
        }
        return {
          data: { ...issue, comments: 101 },
          headers: new Headers(),
          status: 200,
          contentType: "application/json",
        };
      }),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;

    const output = await issueTool.handler(
      { repo: "o/r", number: 7, include_comments: true },
      { client: apiClient, config: makeConfig(), authFingerprint: "abc" },
    );

    const comments = (output as { comments: Array<{ body: string }> }).comments;
    expect(comments).toHaveLength(20);
    expect(comments[0]?.body).toBe("comment 82");
    expect(comments[19]?.body).toBe("comment 101");
    expect(output.comments_truncated).toBe(true);
    expect(apiClient.api).toHaveBeenCalledWith(pageUrl(2), { fresh: undefined, cacheTtlMs: 120_000 });
    expect(apiClient.api).toHaveBeenCalledWith(pageUrl(1), { fresh: undefined, cacheTtlMs: 120_000 });
  });

  it("honors comment_limit and max_comment_chars", async () => {
    const many = client([
      { ...comment, body: "first comment body" },
      { ...comment, body: "second comment body" },
      { ...comment, body: "third comment body" },
    ]) as unknown as GitHubApi;
    const output = await issueTool.handler(
      { repo: "o/r", number: 7, include_comments: true, comment_limit: 2, max_comment_chars: 10 },
      { client: many, config: makeConfig(), authFingerprint: "abc" },
    );
    const comments = (output as { comments: Array<{ body: string }> }).comments;
    expect(comments).toHaveLength(2);
    expect(comments.map((item) => item.body)).toEqual(["second com", "third comm"]);
    expect(comments[0]?.body).toHaveLength(10);
  });
});

function listClient() {
  //? Same accommodation: the mock literal is asserted to GitHubApi for the
  //! generic api<T> signature; assertions still inspect the same mock.
  return {
    api: vi.fn(async () => ({
      data: [issue, pr],
      headers: new Headers(),
      status: 200,
      contentType: "application/json",
    })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

describe("github_issues", () => {
  it("maps the list shape", async () => {
    const api = listClient();
    const output = await issuesTool.handler(
      { repo: "o/r", state: "open", labels: "bug,help wanted", type: "all" },
      { client: api, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(api.api).toHaveBeenCalledWith(
      "/repos/o/r/issues?state=open&labels=bug%2Chelp+wanted&page=1&per_page=20",
      { fresh: undefined, cacheTtlMs: 120_000 },
    );
    expect(output).toMatchObject({
      items: [
        {
          number: 7,
          title: "Bug",
          state: "open",
          type: "issue",
          author: "alice",
          labels: ["bug"],
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
          html_url: "https://github.com/o/r/issues/7",
          comments_count: 1,
        },
        {
          number: 8,
          title: "Fix",
          state: "open",
          type: "pr",
          author: "alice",
          labels: ["bug"],
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
          html_url: "https://github.com/o/r/pull/8",
          comments_count: 1,
        },
      ],
    });
    //? Handler output is Record<string, unknown>, so indexing output.items cannot
    //? typecheck; the path form asserts the same item field from the top level.
    expect(output).toHaveProperty("items.0.created_at");
  });

  it("passes since through to the list endpoint", async () => {
    const api = listClient();
    await issuesTool.handler(
      { repo: "o/r", since: "2026-11-01T00:00:00Z" },
      { client: api, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(api.api).toHaveBeenCalledWith(
      "/repos/o/r/issues?since=2026-11-01T00%3A00%3A00Z&page=1&per_page=20",
      { fresh: undefined, cacheTtlMs: 120_000 },
    );
  });

  it("defaults to issues only, filtering PR noise", async () => {
    const api = listClient();
    const output = await issuesTool.handler(
      { repo: "o/r" },
      { client: api, config: makeConfig(), authFingerprint: "abc" },
    );
    expect((output as { items: Array<{ type: string }> }).items.map((item) => item.type)).toEqual(["issue"]);
  });

  it("type pr returns only pull requests", async () => {
    const api = listClient();
    const output = await issuesTool.handler(
      { repo: "o/r", type: "pr" },
      { client: api, config: makeConfig(), authFingerprint: "abc" },
    );
    expect((output as { items: Array<{ type: string }> }).items.map((item) => item.type)).toEqual(["pr"]);
  });
});
