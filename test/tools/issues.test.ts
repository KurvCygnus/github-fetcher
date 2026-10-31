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

function client() {
  return {
    api: vi.fn(async (url: string) => ({
      data: url.includes("/comments") ? [comment] : issue,
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
});

describe("github_issues", () => {
  it("maps the list shape", async () => {
    //? Same accommodation: the mock literal is asserted to GitHubApi for the
    //! generic api<T> signature; the assertion below inspects the same mock.
    const api = {
      api: vi.fn(async () => ({
        data: [issue, pr],
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const output = await issuesTool.handler(
      { repo: "o/r", state: "open", labels: "bug,help wanted" },
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
});
