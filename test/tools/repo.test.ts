import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { repoTool } from "../../src/tools/repo.js";
import { makeConfig } from "../helpers.js";

const fixture = {
  full_name: "octocat/Hello-World",
  description: "My first repository on GitHub!",
  private: false,
  html_url: "https://github.com/octocat/Hello-World",
  default_branch: "master",
  stargazers_count: 3875,
  forks_count: 7285,
  open_issues_count: 1500,
  has_issues: true,
  has_discussions: false,
  language: null,
  license: null,
  topics: ["octocat"],
  archived: false,
  pushed_at: "2024-01-02T00:00:00Z",
  created_at: "2011-01-26T19:01:12Z",
};

const result = { data: fixture, headers: new Headers(), status: 200, contentType: "application/json", cache: { state: "miss" } };

describe("github_repo", () => {
  it("maps the documented fields", async () => {
    //? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
    //! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
    const client = { api: vi.fn(async () => result), apiRaw: vi.fn(), raw: vi.fn() } as unknown as GitHubApi;
    const output = await repoTool.handler(
      { repo: "octocat/Hello-World" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/repos/octocat/Hello-World", {
      fresh: undefined,
      cacheTtlMs: 600_000,
    });
    expect(output).toEqual({
      full_name: "octocat/Hello-World",
      description: "My first repository on GitHub!",
      private: false,
      visibility: "public",
      html_url: "https://github.com/octocat/Hello-World",
      default_branch: "master",
      stars: 3875,
      forks: 7285,
      open_issues: 1500,
      has_issues: true,
      has_discussions: false,
      language: null,
      license: null,
      topics: ["octocat"],
      archived: false,
      pushed_at: "2024-01-02T00:00:00Z",
      created_at: "2011-01-26T19:01:12Z",
      meta: { cache: "miss" },
    });
  });

  it("passes GitHub's visibility through when present", async () => {
    //? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
    //! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
    const client = {
      api: vi.fn(async () => ({
        data: { ...fixture, private: true, visibility: "private" },
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const output = await repoTool.handler(
      { repo: "octocat/Hello-World" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({ private: true, visibility: "private" });
  });
});
