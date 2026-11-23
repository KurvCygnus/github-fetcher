import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/core/context.js";
import { releaseDiffTool } from "../../src/tools/release-diff.js";
import { makeConfig } from "../helpers.js";

//? ahead_by deliberately disagrees with upstream total_commits so that a tool
//* which copies the wrong field cannot pass: both total_commits and the
//* truncation flag must come from ahead_by.
const basePayload = {
  status: "ahead",
  ahead_by: 2,
  behind_by: 0,
  total_commits: 5,
  commits: [
    {
      sha: "abcdef1234567890",
      html_url: "https://github.com/o/r/commit/abcdef1234567890",
      commit: {
        message: "fix: thing",
        author: { name: "Ada", email: "ada@example.com", date: "2026-01-01T00:00:00Z" },
      },
      author: { login: "ada" },
    },
  ],
  files: [
    { sha: "f1", filename: "src/a.ts", status: "modified", additions: 10, deletions: 2, changes: 12, patch: "@@ -1,2 +1,3 @@" },
    { sha: "f2", filename: "src/b.ts", status: "added", additions: 5, deletions: 0, changes: 5 },
  ],
};

function clientFor(payload: unknown) {
  return {
    api: vi.fn(async (_url: string, _options?: unknown) => ({
      data: payload,
      headers: new Headers(),
      status: 200,
      contentType: "application/json",
      cache: { state: "miss" as const },
    })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  };
}

function ctxFor(client: unknown): ToolContext {
  return { client: client as ToolContext["client"], config: makeConfig(), authFingerprint: "abc" };
}

function commitsOf(length: number): Array<Record<string, unknown>> {
  return Array.from({ length }, (_, index) => ({
    sha: `sha${index}`,
    html_url: `https://github.com/o/r/commit/sha${index}`,
    commit: {
      message: `m${index}`,
      author: { name: "A", email: "a@example.com", date: "2026-01-01T00:00:00Z" },
    },
    author: { login: "a" },
  }));
}

function filesOf(length: number): Array<Record<string, unknown>> {
  return Array.from({ length }, (_, index) => ({
    sha: `f${index}`,
    filename: `f${index}.ts`,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: `@@ f${index} @@`,
  }));
}

describe("github_release_diff", () => {
  it("GETs the compare path once, takes total_commits from ahead_by, and trails meta", async () => {
    const client = clientFor(basePayload);
    const output = await releaseDiffTool.handler(
      { repo: "o/r", from: "v1", to: "v2" },
      ctxFor(client),
    );
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(client.api.mock.calls[0]?.[0]).toBe("/repos/o/r/compare/v1...v2");
    expect(client.api.mock.calls[0]?.[1]).toEqual({ fresh: undefined, cacheTtlMs: 120_000 });
    expect(output).toStrictEqual({
      repo: "o/r",
      from: "v1",
      to: "v2",
      status: "ahead",
      ahead_by: 2,
      behind_by: 0,
      total_commits: 2,
      commits: [
        {
          sha: "abcdef1234567890",
          short_sha: "abcdef1",
          message: "fix: thing",
          author: { name: "Ada", email: "ada@example.com", login: "ada" },
          date: "2026-01-01T00:00:00Z",
          url: "https://github.com/o/r/commit/abcdef1234567890",
        },
      ],
      commits_truncated: false,
      total_files: 2,
      files: [
        { sha: "f1", filename: "src/a.ts", status: "modified", additions: 10, deletions: 2, changes: 12, patch: "@@ -1,2 +1,3 @@", patch_truncated: false },
        { sha: "f2", filename: "src/b.ts", status: "added", additions: 5, deletions: 0, changes: 5, patch: null, patch_truncated: false },
      ],
      files_truncated: false,
      meta: { cache: "miss", calls: 1 },
    });
    expect(Object.keys(output).at(-1)).toBe("meta");
  });

  it("URI-encodes each ref component in the compare path", async () => {
    const client = clientFor(basePayload);
    await releaseDiffTool.handler(
      { repo: "o/r", from: "release/v1", to: "feature/x y" },
      ctxFor(client),
    );
    expect(client.api.mock.calls[0]?.[0]).toBe(
      "/repos/o/r/compare/release%2Fv1...feature%2Fx%20y",
    );
  });

  it("honors fresh and keeps meta.calls at 1", async () => {
    const client = clientFor(basePayload);
    const output = await releaseDiffTool.handler(
      { repo: "o/r", from: "v1", to: "v2", fresh: true },
      ctxFor(client),
    );
    expect(client.api.mock.calls[0]?.[1]).toEqual({ fresh: true, cacheTtlMs: 120_000 });
    expect(output.meta).toEqual({ cache: "miss", calls: 1 });
  });

  it("caps commits at 100 and sets commits_truncated from ahead_by", async () => {
    const client = clientFor({
      ...basePayload,
      ahead_by: 105,
      commits: commitsOf(105),
    });
    const output = await releaseDiffTool.handler(
      { repo: "o/r", from: "v1", to: "v2" },
      ctxFor(client),
    );
    expect(output.commits).toHaveLength(100);
    expect((output.commits as Array<{ sha: string }>)[99]?.sha).toBe("sha99");
    expect(output.total_commits).toBe(105);
    expect(output.commits_truncated).toBe(true);

    const exactClient = clientFor({ ...basePayload, ahead_by: 100, commits: commitsOf(100) });
    const exact = await releaseDiffTool.handler(
      { repo: "o/r", from: "v1", to: "v2" },
      ctxFor(exactClient),
    );
    expect(exact.commits).toHaveLength(100);
    expect(exact.commits_truncated).toBe(false);
  });

  it("omits commits when include_commits is false but keeps commits_truncated", async () => {
    const client = clientFor({ ...basePayload, ahead_by: 150, commits: commitsOf(150) });
    const output = await releaseDiffTool.handler(
      { repo: "o/r", from: "v1", to: "v2", include_commits: false },
      ctxFor(client),
    );
    expect("commits" in output).toBe(false);
    expect(output.commits_truncated).toBe(true);
    expect(output.total_commits).toBe(150);
    expect(Object.keys(output).at(-1)).toBe("meta");
  });

  it("caps each patch at 4000 bytes and flags only a real cut", async () => {
    const client = clientFor({
      ...basePayload,
      files: [
        { sha: "x", filename: "exact.ts", status: "modified", additions: 4000, deletions: 0, changes: 4000, patch: "a".repeat(4000) },
        { sha: "y", filename: "over.ts", status: "modified", additions: 5000, deletions: 0, changes: 5000, patch: "a".repeat(5000) },
        //? Each ideographic character is 3 UTF-8 bytes, so 2000 of them are
        //* 6000 bytes and the 4000-byte clip must land on a whole character.
        { sha: "z", filename: "wide.ts", status: "modified", additions: 2000, deletions: 0, changes: 2000, patch: "界".repeat(2000) },
      ],
    });
    const output = await releaseDiffTool.handler(
      { repo: "o/r", from: "v1", to: "v2" },
      ctxFor(client),
    );
    const files = output.files as Array<{ filename: string; patch: string | null; patch_truncated: boolean }>;
    expect(files.map((file) => [file.filename, file.patch_truncated])).toEqual([
      ["exact.ts", false],
      ["over.ts", true],
      ["wide.ts", true],
    ]);
    expect(files[0]?.patch).toHaveLength(4000);
    expect(files[1]?.patch).toHaveLength(4000);
    expect(files[2]?.patch).toHaveLength(1333);
    expect(Buffer.byteLength(files[2]?.patch ?? "", "utf8")).toBeLessThanOrEqual(4000);
    expect(files[2]?.patch?.endsWith("界")).toBe(true);
  });

  it("sets files_truncated from local clipping and from the upstream 300-file cap", async () => {
    const localClient = clientFor({ ...basePayload, files: filesOf(105) });
    const local = await releaseDiffTool.handler(
      { repo: "o/r", from: "v1", to: "v2" },
      ctxFor(localClient),
    );
    expect(local.files).toHaveLength(100);
    expect(local.total_files).toBe(105);
    expect(local.files_truncated).toBe(true);

    const upstreamClient = clientFor({ ...basePayload, files: filesOf(300) });
    const upstream = await releaseDiffTool.handler(
      { repo: "o/r", from: "v1", to: "v2" },
      ctxFor(upstreamClient),
    );
    expect(upstream.files).toHaveLength(100);
    expect(upstream.total_files).toBe(300);
    expect(upstream.files_truncated).toBe(true);

    const exactClient = clientFor({ ...basePayload, files: filesOf(100) });
    const exact = await releaseDiffTool.handler(
      { repo: "o/r", from: "v1", to: "v2" },
      ctxFor(exactClient),
    );
    expect(exact.files_truncated).toBe(false);
  });
});
