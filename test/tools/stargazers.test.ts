import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { stargazersTool } from "../../src/tools/stargazers.js";
import { makeConfig } from "../helpers.js";

//? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
//! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
function clientWith(data: unknown, headers: Headers = new Headers()) {
  return {
    api: vi.fn(async () => ({ data, headers, status: 200, contentType: "application/json", cache: { state: "miss" } })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

describe("github_stargazers", () => {
  it("requests star+json and projects login and starred_at", async () => {
    const client = clientWith([
      //? Upstream star+json items wrap the user object beside the starred time;
      //* the projection flattens it to the two fields the timeline needs.
      { starred_at: "2026-03-04T05:06:07Z", user: { login: "octocat", id: 1 } },
      { starred_at: "2026-03-05T06:07:08Z", user: { login: "torvalds", id: 2 } },
      //? A deleted account answers with a null user; login degrades to null and
      //* the row keeps its place in the timeline.
      { starred_at: "2026-03-06T07:08:09Z", user: null },
    ]);
    const output = await stargazersTool.handler(
      { repo: "vercel/ai" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/repos/vercel/ai/stargazers?page=1&per_page=20", {
      fresh: undefined,
      cacheTtlMs: 300_000,
      accept: "application/vnd.github.star+json",
    });
    expect(output).toEqual({
      items: [
        { login: "octocat", starred_at: "2026-03-04T05:06:07Z" },
        { login: "torvalds", starred_at: "2026-03-05T06:07:08Z" },
        { login: null, starred_at: "2026-03-06T07:08:09Z" },
      ],
      page: 1,
      per_page: 20,
      has_more: false,
      next_page: null,
      meta: { cache: "miss", calls: 1 },
    });
  });

  it("forwards pagination and keeps the envelope Link-derived", async () => {
    const client = clientWith(
      [{ starred_at: "2026-01-01T00:00:00Z", user: { login: "octocat" } }],
      new Headers({ link: '<https://api.github.com/repos/vercel/ai/stargazers?page=2&per_page=5>; rel="next"' }),
    );
    const output = await stargazersTool.handler(
      { repo: "vercel/ai", page: 2, per_page: 5, fresh: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/repos/vercel/ai/stargazers?page=2&per_page=5", {
      fresh: true,
      cacheTtlMs: 300_000,
      accept: "application/vnd.github.star+json",
    });
    expect(output).toMatchObject({ page: 2, per_page: 5, has_more: true, next_page: 2 });
  });

  it("works anonymously because the endpoint has no token gate", async () => {
    const client = clientWith([]);
    const output = await stargazersTool.handler(
      { repo: "vercel/ai" },
      { client, config: makeConfig(), authFingerprint: "anonymous" },
    );
    expect(output.items).toEqual([]);
    expect(output).toMatchObject({ page: 1, per_page: 20, has_more: false, next_page: null });
  });

  it("rejects a malformed repo with invalid_params", async () => {
    const client = clientWith([]);
    await expect(
      stargazersTool.handler({ repo: "not-a-repo" }, { client, config: makeConfig(), authFingerprint: "abc" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    expect(client.api).not.toHaveBeenCalled();
  });
});
