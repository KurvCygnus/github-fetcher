import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { userEventsTool, userReposTool, userStarredTool, userTool } from "../../src/tools/user.js";
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
        fork: true,
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
          fork: true,
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
    });
  });
});
