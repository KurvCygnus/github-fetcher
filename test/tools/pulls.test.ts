import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/github.js";
import { prTool, prsTool } from "../../src/tools/pulls.js";
import { makeConfig } from "../helpers.js";

const pull = {
  number: 12,
  title: "Add feature",
  state: "open",
  draft: false,
  merged_at: null,
  user: { login: "alice" },
  base: { ref: "main" },
  head: { ref: "feature" },
  body: "body",
  additions: 10,
  deletions: 2,
  changed_files: 1,
  mergeable: true,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-02T00:00:00Z",
  html_url: "https://github.com/o/r/pull/12",
};

describe("github_pr", () => {
  it("maps a pull request and its files", async () => {
    const client = {
      api: vi.fn(async (url: string) => ({
        data: url.endsWith("/files?per_page=100")
          ? [{ filename: "src/a.ts", status: "modified", additions: 3, deletions: 1, changes: 4, patch: "@@ patch" }]
          : pull,
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    };
    //? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
    //! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
    const api = client as unknown as GitHubApi;
    const output = await prTool.handler(
      { repo: "o/r", number: 12, include_files: true },
      { client: api, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      number: 12,
      state: "open",
      draft: false,
      merged: false,
      author: "alice",
      base: "main",
      head: "feature",
      additions: 10,
      deletions: 2,
      changed_files: 1,
      mergeable: true,
      files: [{ filename: "src/a.ts", status: "modified", additions: 3, deletions: 1, changes: 4, patch: "@@ patch" }],
      files_truncated: false,
    });
  });
});

describe("github_prs", () => {
  it("maps the list shape", async () => {
    const client = {
      api: vi.fn(async () => ({
        data: [pull],
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    };
    //? Same accommodation: the mock literal is asserted to GitHubApi for the
    //! generic api<T> signature; the assertion below inspects the same mock.
    const api = client as unknown as GitHubApi;
    const output = await prsTool.handler(
      { repo: "o/r", state: "open", base: "main" },
      { client: api, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      items: [
        {
          number: 12,
          title: "Add feature",
          state: "open",
          draft: false,
          author: "alice",
          base: "main",
          head: "feature",
          updated_at: "2024-01-02T00:00:00Z",
          html_url: "https://github.com/o/r/pull/12",
        },
      ],
    });
  });
});
