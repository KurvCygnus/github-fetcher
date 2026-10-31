import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { treeTool } from "../../src/tools/tree.js";
import { makeConfig } from "../helpers.js";

const fixture = {
  sha: "abc",
  truncated: false,
  tree: [
    { path: "src", mode: "040000", type: "tree", sha: "t1" },
    { path: "src/index.ts", mode: "100644", type: "blob", size: 42, sha: "f1" },
    { path: "link", mode: "120000", type: "blob", size: 10, sha: "l1" },
    { path: "sub", mode: "160000", type: "commit", sha: "s1" },
  ],
};

describe("github_tree", () => {
  it("lists entries with normalized types and a recursive query", async () => {
    //? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
    //! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
    const client = {
      api: vi.fn(async () => ({ data: fixture, headers: new Headers(), status: 200, contentType: "application/json" })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const output = await treeTool.handler(
      { repo: "octocat/Hello-World", ref: "main", recursive: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith(
      "/repos/octocat/Hello-World/git/trees/main?recursive=1",
      { fresh: undefined, cacheTtlMs: 600_000 },
    );
    expect(output).toEqual({
      ref: "main",
      path: null,
      entries: [
        { path: "src", type: "dir", size: null, sha: "t1" },
        { path: "src/index.ts", type: "file", size: 42, sha: "f1" },
        { path: "link", type: "symlink", size: 10, sha: "l1" },
        { path: "sub", type: "submodule", size: null, sha: "s1" },
      ],
      truncated: false,
    });
  });
});
