import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/core/context.js";
import { GithubError } from "../../src/core/errors.js";
import { compareRefsTool } from "../../src/tools/compare-refs.js";
import { makeConfig } from "../helpers.js";

const basePayload = {
  status: "ahead",
  ahead_by: 2,
  behind_by: 0,
  total_commits: 5,
  files: [
    { filename: "src/a.ts", status: "modified", additions: 10, deletions: 2, patch: "@@ -1,2 +1,3 @@" },
    { filename: "src/b.ts", status: "added", additions: 5, deletions: 0 },
  ],
};

function clientFor(payload: unknown) {
  return {
    api: vi.fn(async () => ({
      data: payload,
      headers: new Headers(),
      status: 200,
      contentType: "application/json",
      cache: { state: "miss" },
    })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  };
}

function failingClient() {
  return {
    api: vi.fn(async () => {
      throw new GithubError("not_found", "Not Found");
    }),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  };
}

function ctxFor(client: unknown): ToolContext {
  return { client: client as ToolContext["client"], config: makeConfig(), authFingerprint: "abc" };
}

describe("github_compare_refs", () => {
  it("projects the compare summary and per-file rows", async () => {
    const client = clientFor(basePayload);
    const output = await compareRefsTool.handler(
      { repo: "o/r", base: "main", head: "feature" },
      ctxFor(client),
    );
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/compare/main...feature", {
      fresh: undefined,
      cacheTtlMs: 120_000,
    });
    //? Strict equality pins the whole envelope: a missing patch maps to null,
    //* no files_truncated key exists when nothing was capped, and the networked
    //* response carries the meta entry trailing the fixed keys.
    expect(output).toStrictEqual({
      status: "ahead",
      ahead_by: 2,
      behind_by: 0,
      total_commits: 5,
      files: [
        { filename: "src/a.ts", status: "modified", additions: 10, deletions: 2, patch: "@@ -1,2 +1,3 @@" },
        { filename: "src/b.ts", status: "added", additions: 5, deletions: 0, patch: null },
      ],
      meta: { cache: "miss" },
    });
  });

  it("URI-encodes each ref component in the path", async () => {
    const client = clientFor(basePayload);
    await compareRefsTool.handler(
      { repo: "o/r", base: "main", head: "feature/x" },
      ctxFor(client),
    );
    expect(client.api).toHaveBeenCalledWith(
      "/repos/o/r/compare/main...feature%2Fx",
      expect.anything(),
    );
  });

  it("caps files at 100 and sets files_truncated only when capped", async () => {
    const files = Array.from({ length: 105 }, (_, index) => ({
      filename: `f${index}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: `@@ f${index} @@`,
    }));
    const client = clientFor({ ...basePayload, files });
    const output = await compareRefsTool.handler(
      { repo: "o/r", base: "main", head: "feature" },
      ctxFor(client),
    );
    const list = output.files as Array<unknown>;
    expect(list).toHaveLength(100);
    expect(list[99]).toEqual({ filename: "f99.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ f99 @@" });
    expect(output.files_truncated).toBe(true);

    const exactClient = clientFor({ ...basePayload, files: files.slice(0, 100) });
    const exact = await compareRefsTool.handler(
      { repo: "o/r", base: "main", head: "feature" },
      ctxFor(exactClient),
    );
    expect((exact.files as Array<unknown>)).toHaveLength(100);
    expect("files_truncated" in exact).toBe(false);
  });

  it("truncates each patch to the 4000-character cap", async () => {
    const longPatch = "a".repeat(5000);
    const client = clientFor({
      ...basePayload,
      files: [{ filename: "big.ts", status: "modified", additions: 5000, deletions: 0, patch: longPatch }],
    });
    const output = await compareRefsTool.handler(
      { repo: "o/r", base: "main", head: "feature" },
      ctxFor(client),
    );
    const files = output.files as Array<{ patch: string | null }>;
    expect(files[0]?.patch).toHaveLength(4000);
    expect(files[0]?.patch).not.toBe(longPatch);
  });

  it("propagates the 404 for unknown refs as a standard error", async () => {
    const client = failingClient();
    await expect(
      compareRefsTool.handler({ repo: "o/r", base: "ghost", head: "main" }, ctxFor(client)),
    ).rejects.toMatchObject({ code: "not_found", message: "Not Found" });
  });
});
