import { beforeEach, describe, expect, it, vi } from "vitest";
import { GithubError } from "../../src/core/errors.js";
import type { ToolContext } from "../../src/core/context.js";
import { commitTool } from "../../src/tools/commit.js";
import { clearPinnedRef, setPinnedRef } from "../../src/tools/pin.js";
import { makeClientWith, makeConfig } from "../helpers.js";

const REPO = "o/r";

//? The pin map is module state shared by every test in this file; a leftover
//* entry from the pin cases would otherwise leak into the no-pin assertions.
beforeEach(() => {
  clearPinnedRef(REPO);
});

//? A commit payload shaped like the real REST response, with extra fields
//* (node_id, html_url, committer, tree, verification, parents, stats.total,
//* file.changes) the tool must NOT project; strict-equality assertions below
//* prove they never reach the output.
const commitPayload = {
  sha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
  node_id: "MDY6Q29tbWl0MTI5NjI2OTo3ZmQxYTYwYjAxZjkxYjMxNGY1OTk1NWE0ZTRkNGU4MGQ4ZWRmMTFk",
  html_url: "https://github.com/o/r/commit/7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
  commit: {
    message: "fix: widen the input guard\n\nAlso document the fallback.",
    author: { name: "The Octocat", email: "octocat@nowhere.com", date: "2012-03-06T23:06:50Z" },
    committer: { name: "The Octocat", email: "octocat@nowhere.com", date: "2012-03-06T23:07:00Z" },
    tree: { sha: "b4eecafa9be2f2006ce1b709d6857b07069b4608" },
    verification: { verified: false, reason: "unsigned" },
  },
  //? User-shaped author, not just a login string: the tool reads login off the
  //* user object and must flatten it with the commit.author name/email.
  author: { login: "octocat", id: 583231, type: "User" },
  committer: { login: "octocat", id: 583231, type: "User" },
  parents: [{ sha: "553c2077f0edc3d5dc5d17262f6aa498e69d6f8e" }],
  stats: { additions: 1, deletions: 1, total: 2 },
  files: [
    {
      filename: "src/guard.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: "@@ -1 +1 @@\n-old guard\n+new guard",
    },
    //? Binary and rename entries ship no patch, so the projection maps patch
    //* to null instead of leaving the key undefined.
    { filename: "logo.png", status: "added", additions: 0, deletions: 0, changes: 0 },
  ],
};

//? makeClientWith cannot express cache outcomes (the shared factory returns a
//* result without `cache`), so meta-pinning assertions keep a local factory,
//* matching the house precedent from the factory-adoption adjudication.
function clientFor(data: unknown): ToolContext["client"] {
  return {
    api: vi.fn(async () => ({
      data,
      headers: new Headers(),
      status: 200,
      contentType: "application/json",
      cache: { state: "miss" },
    })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as ToolContext["client"];
}

function ctxFor(client: ToolContext["client"]): ToolContext {
  return { client, config: makeConfig(), authFingerprint: "abc" };
}

describe("github_commit", () => {
  it("projects the full commit envelope and never leaks unprojected fields", async () => {
    const client = clientFor(commitPayload);
    const output = await commitTool.handler(
      { repo: REPO, ref: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d" },
      ctxFor(client),
    );
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/commits/7fd1a60b01f91b314f59955a4e4d4e80d8edf11d", {
      fresh: undefined,
      cacheTtlMs: 300_000,
    });
    expect(client.api).toHaveBeenCalledTimes(1);
    //? Strict equality pins the whole envelope: the author flattens
    //* commit.author (name/email) with author.login, a patch-less file maps to
    //* patch null, no files_truncated key exists when nothing was capped, and
    //* parents/committer/html_url/tree/verification/node_id stay out.
    expect(output).toStrictEqual({
      repo: REPO,
      sha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
      author: { name: "The Octocat", email: "octocat@nowhere.com", login: "octocat" },
      date: "2012-03-06T23:06:50Z",
      message: "fix: widen the input guard\n\nAlso document the fallback.",
      additions: 1,
      deletions: 1,
      files: [
        {
          filename: "src/guard.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-old guard\n+new guard",
        },
        { filename: "logo.png", status: "added", additions: 0, deletions: 0, patch: null },
      ],
      meta: { cache: "miss", calls: 1 },
    });
  });

  it("caps files at 100 and sets files_truncated only when capped", async () => {
    const files = Array.from({ length: 101 }, (_, index) => ({
      filename: `f${index}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: `@@ f${index} @@`,
    }));
    const client = makeClientWith({ ...commitPayload, files });
    const output = await commitTool.handler({ repo: REPO, ref: "main" }, ctxFor(client));
    const list = (output.files as Array<unknown>);
    expect(list).toHaveLength(100);
    expect(list[99]).toEqual({ filename: "f99.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ f99 @@" });
    expect(output.files_truncated).toBe(true);

    const exactClient = makeClientWith({ ...commitPayload, files: files.slice(0, 100) });
    const exact = await commitTool.handler({ repo: REPO, ref: "main" }, ctxFor(exactClient));
    expect(exact.files as Array<unknown>).toHaveLength(100);
    expect("files_truncated" in exact).toBe(false);
  });

  it("truncates each patch to the 4000-character cap", async () => {
    const longPatch = "a".repeat(5000);
    const client = makeClientWith({
      ...commitPayload,
      files: [{ filename: "big.ts", status: "modified", additions: 5000, deletions: 0, patch: longPatch }],
    });
    const output = await commitTool.handler({ repo: REPO, ref: "main" }, ctxFor(client));
    const files = output.files as Array<{ patch: string | null }>;
    expect(files[0]?.patch).toHaveLength(4000);
    expect(files[0]?.patch).not.toBe(longPatch);
  });

  it("treats a missing files array as an empty diff", async () => {
    const client = makeClientWith({ ...commitPayload, files: undefined });
    const output = await commitTool.handler({ repo: REPO, ref: "main" }, ctxFor(client));
    expect(output.files).toStrictEqual([]);
    expect("files_truncated" in output).toBe(false);
  });

  it("ignores merge parents and reports null login for ghost users", async () => {
    const mergePayload = {
      ...commitPayload,
      sha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
      author: null,
      parents: [
        { sha: "553c2077f0edc3d5dc5d17262f6aa498e69d6f8e" },
        { sha: "762941318ee16e59dabbacb1b4049eec22f0d303" },
      ],
    };
    const client = clientFor(mergePayload);
    const output = await commitTool.handler({ repo: REPO, ref: "main" }, ctxFor(client));
    //? Strict equality again: the two-parent merge payload produces the same
    //* envelope shape, the ghost author (null user object) maps login to null,
    //* and parents never appear in the output at all.
    expect(output).toStrictEqual({
      repo: REPO,
      sha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
      author: { name: "The Octocat", email: "octocat@nowhere.com", login: null },
      date: "2012-03-06T23:06:50Z",
      message: "fix: widen the input guard\n\nAlso document the fallback.",
      additions: 1,
      deletions: 1,
      files: [
        {
          filename: "src/guard.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-old guard\n+new guard",
        },
        { filename: "logo.png", status: "added", additions: 0, deletions: 0, patch: null },
      ],
      meta: { cache: "miss", calls: 1 },
    });
  });

  it("propagates the 404 for an unknown ref as a standard error", async () => {
    const notFound = new GithubError("not_found", "Not Found", { status: 404 });
    const client = {
      api: vi.fn(async () => {
        throw notFound;
      }),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as ToolContext["client"];
    await expect(
      commitTool.handler({ repo: REPO, ref: "ghost" }, ctxFor(client)),
    ).rejects.toBe(notFound);
  });

  it("anchors a ref-less read to the pinned sha and reports pinned_sha", async () => {
    //? Review focus: the request URL must carry the pinned SHA, not the branch
    //* the pin was created from; the endpoint accepts a sha in the ref segment
    //* directly, so the pin adds no upstream call and the read stays at one.
    const client = clientFor(commitPayload);
    setPinnedRef(REPO, "main", "abc123def456");
    const output = await commitTool.handler({ repo: REPO }, ctxFor(client));
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/commits/abc123def456", {
      fresh: undefined,
      cacheTtlMs: 300_000,
    });
    expect(output).toStrictEqual({
      repo: REPO,
      sha: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
      author: { name: "The Octocat", email: "octocat@nowhere.com", login: "octocat" },
      date: "2012-03-06T23:06:50Z",
      message: "fix: widen the input guard\n\nAlso document the fallback.",
      additions: 1,
      deletions: 1,
      files: [
        {
          filename: "src/guard.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-old guard\n+new guard",
        },
        { filename: "logo.png", status: "added", additions: 0, deletions: 0, patch: null },
      ],
      pinned_sha: "abc123def456",
      meta: { cache: "miss", calls: 1 },
    });
  });

  it("lets an explicit ref win over the pin and omits pinned_sha", async () => {
    const client = clientFor(commitPayload);
    setPinnedRef(REPO, "main", "abc123def456");
    const output = await commitTool.handler({ repo: REPO, ref: "main" }, ctxFor(client));
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/commits/main", {
      fresh: undefined,
      cacheTtlMs: 300_000,
    });
    expect("pinned_sha" in output).toBe(false);
  });

  it("falls back to HEAD and stays a single call when no ref and no pin exist", async () => {
    //? The endpoint accepts HEAD directly (the default branch tip), so a
    //* ref-less, pin-less read honors the description's "Costs 1 core call"
    //* without any repo-lookup round trip.
    const client = clientFor(commitPayload);
    const output = await commitTool.handler({ repo: REPO }, ctxFor(client));
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/commits/HEAD", {
      fresh: undefined,
      cacheTtlMs: 300_000,
    });
    expect("pinned_sha" in output).toBe(false);
    expect(output.repo).toBe(REPO);
  });

  it("URI-encodes the ref in the path", async () => {
    const client = makeClientWith(commitPayload);
    await commitTool.handler({ repo: REPO, ref: "feature/x" }, ctxFor(client));
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/commits/feature%2Fx", expect.anything());
  });
});
