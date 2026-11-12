import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { searchUsersTool } from "../../src/tools/search.js";
import { makeConfig } from "../helpers.js";

//? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
//! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
function clientWith(data: unknown, headers: Headers = new Headers()) {
  return {
    api: vi.fn(async () => ({ data, headers, status: 200, contentType: "application/json" })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

describe("github_search_users", () => {
  //? Upstream user search items carry login, id, node_id, avatar_url, html_url,
  //* type, and score; the tool projects the lean three-key row because profile
  //* detail belongs to github_user, so the fixture items carry every extra field
  //* and the assertion below proves the cut.
  it("projects the lean {login, type, html_url} row", async () => {
    const client = clientWith({
      total_count: 2,
      incomplete_results: false,
      items: [
        {
          login: "octocat",
          id: 583231,
          node_id: "MDQ6VXNlcjU4MzIzMQ==",
          avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
          html_url: "https://github.com/octocat",
          type: "User",
          score: 1.0,
        },
        {
          login: "github",
          id: 9919,
          node_id: "MDEyOk9yZ2FuaXphdGlvbjk5MTk=",
          avatar_url: "https://avatars.githubusercontent.com/u/9919?v=4",
          html_url: "https://github.com/github",
          type: "Organization",
          score: 0.9,
        },
      ],
    });
    const output = await searchUsersTool.handler(
      { query: "location:china followers:>=10 repositories:>=8", sort: "followers", order: "asc", page: 2, per_page: 5 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith(
      "/search/users?q=location%3Achina+followers%3A%3E%3D10+repositories%3A%3E%3D8&sort=followers&order=asc&page=2&per_page=5",
      { fresh: undefined, cacheTtlMs: 300_000 },
    );
    expect(output.items).toEqual([
      { login: "octocat", type: "User", html_url: "https://github.com/octocat" },
      { login: "github", type: "Organization", html_url: "https://github.com/github" },
    ]);
  });

  it("returns the search envelope shape with pagination", async () => {
    const headers = new Headers({ link: '<https://api.github.com/search/users?q=x&page=2>; rel="next"' });
    const client = clientWith(
      { total_count: 7, incomplete_results: true, items: [{ login: "octocat", html_url: "https://github.com/octocat", type: "User" }] },
      headers,
    );
    const output = await searchUsersTool.handler(
      { query: "fullname:linus" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      total_count: 7,
      incomplete_results: true,
      items: [{ login: "octocat", type: "User", html_url: "https://github.com/octocat" }],
      page: 1,
      per_page: 20,
      has_more: true,
      next_page: 2,
    });
  });

  it("costs one search call and forwards fresh to the client", async () => {
    const client = clientWith({ total_count: 0, incomplete_results: false, items: [] });
    const output = await searchUsersTool.handler(
      { query: "type:org", fresh: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(client.api).toHaveBeenCalledWith("/search/users?q=type%3Aorg&page=1&per_page=20", {
      fresh: true,
      cacheTtlMs: 300_000,
    });
    expect(output).toMatchObject({ total_count: 0, items: [], has_more: false, next_page: null });
  });

  //? /search/users works anonymously, unlike /search/code which gates on the
  //* token: the anonymous fingerprint must reach the endpoint, not throw.
  it("serves anonymous access without a token gate", async () => {
    const client = clientWith({
      total_count: 1,
      incomplete_results: false,
      items: [{ login: "octocat", html_url: "https://github.com/octocat", type: "User" }],
    });
    const output = await searchUsersTool.handler(
      { query: "octocat" },
      { client, config: makeConfig(), authFingerprint: "anonymous" },
    );
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({ total_count: 1, items: [{ login: "octocat" }] });
  });
});
