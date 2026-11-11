import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { branchesTool } from "../../src/tools/branches.js";
import { makeConfig } from "../helpers.js";

describe("github_branches", () => {
  it("maps branch protection and sha", async () => {
    //? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
    //! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
    const client = {
      api: vi.fn(async () => ({
        data: [{ name: "main", commit: { sha: "abc" }, protected: true }],
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
        cache: { state: "miss" },
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const output = await branchesTool.handler(
      { repo: "o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      items: [{ name: "main", sha: "abc", protected: true }],
      page: 1,
      per_page: 20,
      has_more: false,
      next_page: null,
      meta: { cache: "miss" },
    });
  });
});
