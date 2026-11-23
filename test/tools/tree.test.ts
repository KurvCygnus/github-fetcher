import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GitHubApi } from "../../src/core/github.js";
import { GithubError } from "../../src/core/errors.js";
import { clearPinnedRef, setPinnedRef } from "../../src/tools/pin.js";
import { treeTool } from "../../src/tools/tree.js";
import { makeConfig, memoryCacheStore, seedCacheTree } from "../helpers.js";

const REPO = "octocat/Hello-World";

//? The pin map is module state shared by every test in this file; a leftover
//* entry from the pin cases would otherwise leak into the no-pin assertions.
beforeEach(() => {
  clearPinnedRef(REPO);
});

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

//* Every tree fetch now reads raw bytes; the shared fake encodes a fixture into
//* that shape. api stays a resolver stub for the ref-less cases, where resolveRef
//* still issues its own repo request.
function rawOk(data: unknown, state: "hit" | "revalidated" | "miss" = "miss") {
  return {
    bytes: new TextEncoder().encode(JSON.stringify(data)),
    headers: new Headers(),
    status: 200,
    contentType: "application/json",
    cache: { state },
  };
}

function rawClient(data: unknown, state: "hit" | "revalidated" | "miss" = "miss"): GitHubApi {
  return {
    api: vi.fn(async () => ({
      data: { default_branch: "main" },
      headers: new Headers(),
      status: 200,
      contentType: "application/json",
      cache: { state: "miss" },
    })),
    apiRaw: vi.fn(async () => rawOk(data, state)),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

//* Recursive-timeout degrade fixtures: the first apiRaw call rejects with the
//* timeout GithubError a real aborted request carries, then the non-recursive
//* retry serves the given bytes.
function degradedClient(retryData: unknown) {
  return {
    api: vi.fn(async () => ({
      data: { default_branch: "main" },
      headers: new Headers(),
      status: 200,
      contentType: "application/json",
      cache: { state: "miss" },
    })),
    apiRaw: vi
      .fn()
      .mockRejectedValueOnce(new GithubError("network", "The operation was aborted due to timeout"))
      .mockResolvedValueOnce(rawOk(retryData)),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

describe("github_tree", () => {
  it("lists entries with normalized types and a recursive query", async () => {
    //? A concrete vi.fn return cannot satisfy the generic apiRaw signature, so the
    //! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
    const client = rawClient(fixture);
    const output = await treeTool.handler(
      { repo: "octocat/Hello-World", ref: "main", recursive: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.apiRaw).toHaveBeenCalledWith(
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
      total_entries: 4,
      returned_entries: 4,
      summary: { files: 1, dirs: 1, symlinks: 1, submodules: 1 },
      api_truncated: false,
      meta: { cache: "miss", calls: 1 },
    });
  });

  function blobTree(count: number, truncated = false) {
    return {
      sha: "abc",
      truncated,
      tree: Array.from({ length: count }, (_, index) => ({
        path: `f${index}`,
        mode: "100644",
        type: "blob",
        size: 1,
        sha: `s${index}`,
      })),
    };
  }

  it("caps the default 1000 entries and summarizes the full tree", async () => {
    const client = rawClient(blobTree(1001));
    const output = await treeTool.handler(
      { repo: "octocat/Hello-World" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const snapshot = output as {
      entries: unknown[];
      total_entries: number;
      returned_entries: number;
      summary: { files: number; dirs: number; symlinks: number; submodules: number };
      truncated: boolean;
      api_truncated: boolean;
      hint?: string;
    };
    expect(snapshot.entries).toHaveLength(1000);
    expect(snapshot.total_entries).toBe(1001);
    expect(snapshot.returned_entries).toBe(1000);
    expect(snapshot.summary).toEqual({ files: 1001, dirs: 0, symlinks: 0, submodules: 0 });
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.api_truncated).toBe(false);
    expect(snapshot.hint).toBe("increase max_entries or narrow path/ref");
  });

  it("honors a custom cap below the entry count", async () => {
    const client = rawClient(fixture);
    const output = await treeTool.handler(
      { repo: "octocat/Hello-World", max_entries: 2 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const snapshot = output as { entries: unknown[]; returned_entries: number; total_entries: number };
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.returned_entries).toBe(2);
    expect(snapshot.total_entries).toBe(4);
  });

  it("distinguishes GitHub's own truncation from the local cap", async () => {
    const client = rawClient(blobTree(3, true));
    const output = await treeTool.handler(
      { repo: "octocat/Hello-World" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const snapshot = output as { truncated: boolean; api_truncated: boolean; total_entries: number; hint?: string };
    expect(snapshot.api_truncated).toBe(true);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.total_entries).toBe(3);
    expect(snapshot.hint).toBe("narrow path/ref; GitHub truncated the tree");

    //* Repair (spec section 7): when the local cap and GitHub truncation both
    //* apply, the GitHub-side hint wins over the local increase-max_entries one.
    const combined = rawClient(blobTree(1001, true));
    const combinedOutput = await treeTool.handler(
      { repo: "octocat/Hello-World" },
      { client: combined, config: makeConfig(), authFingerprint: "abc" },
    );
    const combinedSnapshot = combinedOutput as {
      total_entries: number;
      truncated: boolean;
      api_truncated: boolean;
      hint?: string;
    };
    expect(combinedSnapshot.total_entries).toBe(1001);
    expect(combinedSnapshot.truncated).toBe(true);
    expect(combinedSnapshot.api_truncated).toBe(true);
    expect(combinedSnapshot.hint).toBe("narrow path/ref; GitHub truncated the tree");
  });

  it("degrades a recursive timeout into one non-recursive retry", async () => {
    const client = degradedClient(fixture);
    const output = await treeTool.handler(
      { repo: "octocat/Hello-World", ref: "main", recursive: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.apiRaw).toHaveBeenCalledTimes(2);
    expect(client.apiRaw).toHaveBeenNthCalledWith(
      1,
      "/repos/octocat/Hello-World/git/trees/main?recursive=1",
      { fresh: undefined, cacheTtlMs: 600_000 },
    );
    expect(client.apiRaw).toHaveBeenNthCalledWith(2, "/repos/octocat/Hello-World/git/trees/main", {
      fresh: undefined,
      cacheTtlMs: 600_000,
    });
    const snapshot = output as {
      entries: Array<{ path: string; type: string; size: number | null; sha: string }>;
      total_entries: number;
      degraded?: boolean;
      hint?: string;
    };
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.hint).toBe("recursive listing timed out; returning top-level entries");
    expect(snapshot.entries).toEqual([
      { path: "src", type: "dir", size: null, sha: "t1" },
      { path: "src/index.ts", type: "file", size: 42, sha: "f1" },
      { path: "link", type: "symlink", size: 10, sha: "l1" },
      { path: "sub", type: "submodule", size: null, sha: "s1" },
    ]);
    expect(snapshot.total_entries).toBe(4);

    //? When the retry response is also GitHub-truncated, the degraded hint wins
    //? over the Task 6 cause-specific truncation hint.
    const truncatedClient = degradedClient(blobTree(3, true));
    const truncatedOutput = await treeTool.handler(
      { repo: "octocat/Hello-World", ref: "main", recursive: true },
      { client: truncatedClient, config: makeConfig(), authFingerprint: "abc" },
    );
    const truncatedSnapshot = truncatedOutput as {
      truncated: boolean;
      api_truncated: boolean;
      degraded?: boolean;
      hint?: string;
    };
    expect(truncatedSnapshot.degraded).toBe(true);
    expect(truncatedSnapshot.truncated).toBe(true);
    expect(truncatedSnapshot.api_truncated).toBe(true);
    expect(truncatedSnapshot.hint).toBe("recursive listing timed out; returning top-level entries");
  });

  it("propagates non-timeout failures and a timing-out retry untouched", async () => {
    const refused = new GithubError("network", "connection refused");
    const refusedClient = {
      api: vi.fn(async () => ({ data: { default_branch: "main" } })),
      apiRaw: vi.fn(async () => {
        throw refused;
      }),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    await expect(
      treeTool.handler(
        { repo: "octocat/Hello-World", ref: "main", recursive: true },
        { client: refusedClient, config: makeConfig(), authFingerprint: "abc" },
      ),
    ).rejects.toBe(refused);
    expect(refusedClient.apiRaw).toHaveBeenCalledTimes(1);

    const timeoutError = new GithubError("network", "The operation was aborted due to timeout");
    const alwaysTimeout = {
      api: vi.fn(async () => ({ data: { default_branch: "main" } })),
      apiRaw: vi.fn(async () => {
        throw timeoutError;
      }),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    await expect(
      treeTool.handler(
        { repo: "octocat/Hello-World", ref: "main", recursive: true },
        { client: alwaysTimeout, config: makeConfig(), authFingerprint: "abc" },
      ),
    ).rejects.toBe(timeoutError);
    expect(alwaysTimeout.apiRaw).toHaveBeenCalledTimes(2);
  });

  it("replaces entries with totals and top dirs in summary_only mode", async () => {
    const client = rawClient(fixture);
    const output = await treeTool.handler(
      { repo: "octocat/Hello-World", ref: "main", summary_only: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      ref: "main",
      path: null,
      total_entries: 4,
      summary: { files: 1, dirs: 1, symlinks: 1, submodules: 1 },
      total_bytes: 52,
      top_dirs: [{ path: "src", files: 1, bytes: 42 }],
      truncated: false,
      api_truncated: false,
      meta: { cache: "miss", calls: 1 },
    });
    expect("entries" in output).toBe(false);
    expect("returned_entries" in output).toBe(false);

    //? summary_only totals describe the full API tree, so max_entries neither
    //? caps nor locally truncates them.
    const capped = await treeTool.handler(
      { repo: "octocat/Hello-World", ref: "main", summary_only: true, max_entries: 2 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const cappedSnapshot = capped as { total_entries: number; truncated: boolean };
    expect(cappedSnapshot.total_entries).toBe(4);
    expect(cappedSnapshot.truncated).toBe(false);
    expect("hint" in cappedSnapshot).toBe(false);
    expect("entries" in cappedSnapshot).toBe(false);
    expect("returned_entries" in cappedSnapshot).toBe(false);
  });

  it("enforces the max_entries bounds through the schema", () => {
    const schema = z.object(treeTool.inputSchema);
    expect(schema.safeParse({ repo: "o/r", max_entries: 0 }).success).toBe(false);
    expect(schema.safeParse({ repo: "o/r", max_entries: 10001 }).success).toBe(false);
    expect(schema.safeParse({ repo: "o/r", max_entries: 10000 }).success).toBe(true);
  });

  it("anchors a ref-less listing to the pinned sha and reports pinned_sha", async () => {
    //? Review focus: the tree request URL must carry the pinned SHA, not the
    //* branch the pin was created from; the sha also short-circuits the
    //* default-branch lookup, so exactly one upstream call happens.
    const client = rawClient(fixture);
    setPinnedRef(REPO, "main", "abc123def456");
    const output = await treeTool.handler(
      { repo: REPO, recursive: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.apiRaw).toHaveBeenCalledTimes(1);
    expect(client.apiRaw).toHaveBeenCalledWith(
      `/repos/${REPO}/git/trees/abc123def456?recursive=1`,
      { fresh: undefined, cacheTtlMs: 600_000 },
    );
    const snapshot = output as { ref: string; pinned_sha?: string; meta?: { calls: number } };
    expect(snapshot.ref).toBe("abc123def456");
    expect(snapshot.pinned_sha).toBe("abc123def456");
    expect(snapshot.meta).toEqual({ cache: "miss", calls: 1 });
  });

  it("lets an explicit ref win over the pin and omits pinned_sha", async () => {
    const client = rawClient(fixture);
    setPinnedRef(REPO, "main", "abc123def456");
    const output = await treeTool.handler(
      { repo: REPO, ref: "main", recursive: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.apiRaw).toHaveBeenCalledWith(
      `/repos/${REPO}/git/trees/main?recursive=1`,
      { fresh: undefined, cacheTtlMs: 600_000 },
    );
    expect("pinned_sha" in output).toBe(false);
  });
});

describe("github_tree 404 recovery hints", () => {
  function failingClient(error: GithubError): GitHubApi {
    return {
      api: vi.fn(async () => ({ data: { default_branch: "main" } })),
      apiRaw: vi.fn(async () => {
        throw error;
      }),
      raw: vi.fn(),
    } as unknown as GitHubApi;
  }

  it("suggests checking the ref when the tree itself 404s at the ref", async () => {
    const client = failingClient(new GithubError("not_found", "Not Found", { status: 404 }));
    const error = (await treeTool
      .handler(
        { repo: REPO, ref: "nope" },
        { client, config: makeConfig(), authFingerprint: "abc", cache: memoryCacheStore() },
      )
      .catch((caught: unknown) => caught)) as GithubError;
    expect(error.code).toBe("not_found");
    expect(error.details.hint).toBe("ref nope not found; check the branch or tag name");
    //? The ref-level hint needs no cache read, so still exactly one upstream call.
    expect(client.apiRaw).toHaveBeenCalledTimes(1);
  });

  it("decorates a path-scoped tree 404 with parent-directory siblings", async () => {
    const store = memoryCacheStore();
    await seedCacheTree(store, "abc", "https://api.github.com/repos/octocat/Hello-World/git/trees/main:src", {
      tree: [{ path: "index.ts" }, { path: "util.ts" }],
    });
    const client = failingClient(new GithubError("not_found", "Not Found", { status: 404 }));
    const error = (await treeTool
      .handler(
        { repo: REPO, ref: "main", path: "src/missing.ts" },
        { client, config: makeConfig(), authFingerprint: "abc", cache: store },
      )
      .catch((caught: unknown) => caught)) as GithubError;
    expect(error.details.hint).toBe(
      'path "src/missing.ts" not found at ref main; entries in src: index.ts, util.ts',
    );
    expect(client.apiRaw).toHaveBeenCalledTimes(1);
  });

  it("returns the untouched 404 for a path miss with an empty cache", async () => {
    const notFound = new GithubError("not_found", "Not Found", { status: 404 });
    const client = failingClient(notFound);
    await expect(
      treeTool.handler(
        { repo: REPO, ref: "main", path: "src/missing.ts" },
        { client, config: makeConfig(), authFingerprint: "abc", cache: memoryCacheStore() },
      ),
    ).rejects.toBe(notFound);
  });
});

describe("github_tree path normalization", () => {
  it("normalizes a dot path to the root listing with path-less counting", async () => {
    //? "." means the repo root: the request URL carries no path segment and the
    //* call behaves like a path-less read, so meta.calls keeps the same logic.
    const client = rawClient(fixture);
    const output = await treeTool.handler(
      { repo: REPO, ref: "main", path: "." },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.apiRaw).toHaveBeenCalledWith("/repos/octocat/Hello-World/git/trees/main", {
      fresh: undefined,
      cacheTtlMs: 600_000,
    });
    const snapshot = output as { path: string | null; meta?: { calls?: number } };
    expect(snapshot.path).toBe(null);
    expect(snapshot.meta).toEqual({ cache: "miss", calls: 1 });
  });

  it("normalizes a dot-slash path the same way", async () => {
    const client = rawClient(fixture);
    const output = await treeTool.handler(
      { repo: REPO, ref: "main", path: "./" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.apiRaw).toHaveBeenCalledWith("/repos/octocat/Hello-World/git/trees/main", {
      fresh: undefined,
      cacheTtlMs: 600_000,
    });
    expect((output as { path: string | null }).path).toBe(null);
  });

  it("still rejects parent traversal paths before any upstream call", async () => {
    const client = rawClient(fixture);
    await expect(
      treeTool.handler(
        { repo: REPO, ref: "main", path: ".." },
        { client, config: makeConfig(), authFingerprint: "abc" },
      ),
    ).rejects.toMatchObject({ code: "invalid_params" });
    expect(client.apiRaw).not.toHaveBeenCalled();
  });
});

describe("github_tree glob filtering", () => {
  const mixed = {
    sha: "abc",
    truncated: false,
    tree: [
      { path: "docs/a.md", mode: "100644", type: "blob", size: 1, sha: "d1" },
      { path: "docs/b.md", mode: "100644", type: "blob", size: 1, sha: "d2" },
      { path: "src/a.ts", mode: "100644", type: "blob", size: 2, sha: "f1" },
      { path: "src/b.ts", mode: "100644", type: "blob", size: 2, sha: "f2" },
      { path: "src/c.ts", mode: "100644", type: "blob", size: 2, sha: "f3" },
    ],
  };

  it("filters the mapped entries before the cap and reports post-glob totals", async () => {
    const client = rawClient(mixed);
    const output = await treeTool.handler(
      { repo: REPO, ref: "main", glob: "src/*", max_entries: 2 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.apiRaw).toHaveBeenCalledTimes(1);
    const snapshot = output as {
      entries: Array<{ path: string; type: string; size: number | null; sha: string }>;
      total_entries: number;
      returned_entries: number;
      summary: { files: number; dirs: number; symlinks: number; submodules: number };
      truncated: boolean;
      api_truncated: boolean;
      hint?: string;
    };
    //? The first two API entries are docs/* and fail the glob; a cap applied
    //* before filtering would return an empty list instead of these two.
    expect(snapshot.entries).toEqual([
      { path: "src/a.ts", type: "file", size: 2, sha: "f1" },
      { path: "src/b.ts", type: "file", size: 2, sha: "f2" },
    ]);
    expect(snapshot.total_entries).toBe(3);
    expect(snapshot.returned_entries).toBe(2);
    expect(snapshot.summary).toEqual({ files: 5, dirs: 0, symlinks: 0, submodules: 0 });
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.api_truncated).toBe(false);
    expect(snapshot.hint).toBe("increase max_entries or narrow path/ref");
  });

  it("reports zero matches without truncating", async () => {
    const client = rawClient(mixed);
    const output = await treeTool.handler(
      { repo: REPO, ref: "main", glob: "nope/*" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const snapshot = output as {
      entries: unknown[];
      total_entries: number;
      returned_entries: number;
      truncated: boolean;
    };
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.total_entries).toBe(0);
    expect(snapshot.returned_entries).toBe(0);
    expect(snapshot.truncated).toBe(false);
  });

  it("keeps the GitHub-truncation hint when a post-glob cap also applies", async () => {
    const client = rawClient({ sha: "abc", truncated: true, tree: mixed.tree });
    const output = await treeTool.handler(
      { repo: REPO, ref: "main", glob: "src/*", max_entries: 1 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const snapshot = output as {
      total_entries: number;
      returned_entries: number;
      truncated: boolean;
      api_truncated: boolean;
      hint?: string;
    };
    expect(snapshot.total_entries).toBe(3);
    expect(snapshot.returned_entries).toBe(1);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.api_truncated).toBe(true);
    expect(snapshot.hint).toBe("narrow path/ref; GitHub truncated the tree");
  });

  it("leaves summary_only full-tree and ignores the glob there", async () => {
    const client = rawClient(mixed);
    const plain = await treeTool.handler(
      { repo: REPO, ref: "main", summary_only: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const globbed = await treeTool.handler(
      { repo: REPO, ref: "main", summary_only: true, glob: "src/*", max_entries: 1 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    //? summary_only has no entry list to filter: its totals describe the whole
    //* API tree, so the glob and max_entries leave the answer byte-identical.
    expect(globbed).toEqual(plain);
    const snapshot = globbed as {
      total_entries: number;
      summary: { files: number; dirs: number; symlinks: number; submodules: number };
      total_bytes: number;
      top_dirs: unknown[];
      truncated: boolean;
    };
    expect(snapshot.total_entries).toBe(5);
    expect(snapshot.summary).toEqual({ files: 5, dirs: 0, symlinks: 0, submodules: 0 });
    expect(snapshot.total_bytes).toBe(8);
    expect(snapshot.top_dirs).toEqual([
      { path: "src", files: 3, bytes: 6 },
      { path: "docs", files: 2, bytes: 2 },
    ]);
    expect(snapshot.truncated).toBe(false);
    expect("entries" in globbed).toBe(false);
    expect("returned_entries" in globbed).toBe(false);
  });

  it("enforces the glob bounds through the schema", () => {
    const schema = z.object(treeTool.inputSchema);
    expect(schema.safeParse({ repo: "o/r", glob: "" }).success).toBe(false);
    expect(schema.safeParse({ repo: "o/r", glob: "a".repeat(201) }).success).toBe(false);
    expect(schema.safeParse({ repo: "o/r", glob: "*.ts" }).success).toBe(true);
  });
});

describe("github_tree raw bytes, filters, and envelopes", () => {
  //* Short entries keep at least one complete object inside a 64-byte clip: the
  //* response-level sha/truncated keys follow the tree array, so a clipped body
  //* carries a complete first object and a partial second one.
  const bigTree = {
    tree: Array.from({ length: 20 }, (_, index) => ({
      path: `f${index}`,
      mode: "1",
      type: "blob",
      sha: `s${index}`,
    })),
    sha: "abc",
    truncated: false,
  };

  it("reads a large recursive tree from raw bytes and clips locally", async () => {
    const client = {
      api: vi.fn(),
      apiRaw: vi.fn(async () => rawOk(bigTree)),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    //? An explicit ref keeps the single tree fetch the only counted call; the
    //* documented activity counter adds one for a ref-less resolveRef instead.
    const result = await treeTool.handler(
      { repo: "o/r", ref: "main", recursive: true, max_bytes: 64 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const snapshot = result as {
      truncated: boolean;
      api_truncated: boolean;
      entries: unknown[];
      meta?: { calls: number };
      hint?: string;
    };
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.api_truncated).toBe(false);
    expect(snapshot.entries.length).toBeGreaterThan(0);
    expect(snapshot.meta?.calls).toBe(1);
    expect(snapshot.hint).toContain("max_bytes");
    expect(snapshot.hint).not.toContain("GITHUB_MCP_MAX_FILE_BYTES");
  });

  it("path_prefix and glob filter entries before max_entries", async () => {
    const client = rawClient({
      sha: "abc",
      truncated: false,
      tree: [
        { path: "docs/a.md", mode: "100644", type: "blob", size: 1, sha: "d1" },
        { path: "docs/b.md", mode: "100644", type: "blob", size: 1, sha: "d2" },
        { path: "src/a.ts", mode: "100644", type: "blob", size: 2, sha: "f1" },
      ],
    });
    const result = await treeTool.handler(
      { repo: "o/r", ref: "main", glob: "**/*.md", path_prefix: "docs/", max_entries: 1 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const snapshot = result as {
      entries: Array<{ path: string }>;
      returned_entries: number;
      total_entries: number;
    };
    expect(snapshot.entries.every((entry) => entry.path.startsWith("docs/") && entry.path.endsWith(".md"))).toBe(true);
    expect(snapshot.returned_entries).toBe(1);
    expect(snapshot.total_entries).toBeGreaterThan(1);
  });

  it("glob with a separator implies recursion unless recursive is explicitly false", async () => {
    const implied = rawClient(fixture);
    await treeTool.handler(
      { repo: "o/r", ref: "main", glob: "src/*.ts" },
      { client: implied, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(implied.apiRaw).toHaveBeenCalledWith(
      "/repos/o/r/git/trees/main?recursive=1",
      { fresh: undefined, cacheTtlMs: 600_000 },
    );

    const explicit = rawClient(fixture);
    await treeTool.handler(
      { repo: "o/r", ref: "main", glob: "src/*.ts", recursive: false },
      { client: explicit, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(explicit.apiRaw).toHaveBeenCalledWith(
      "/repos/o/r/git/trees/main",
      { fresh: undefined, cacheTtlMs: 600_000 },
    );
  });

  it("keeps the degraded timeout envelope", async () => {
    const client = degradedClient(fixture);
    const result = await treeTool.handler(
      { repo: "o/r", recursive: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    const snapshot = result as { degraded?: boolean; hint?: string };
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.hint).toContain("recursive listing timed out");
  });

  it("enforces the max_bytes bounds through the schema", () => {
    const schema = z.object(treeTool.inputSchema);
    expect(schema.safeParse({ repo: "o/r", max_bytes: 0 }).success).toBe(false);
    expect(schema.safeParse({ repo: "o/r", max_bytes: 16 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(schema.safeParse({ repo: "o/r", max_bytes: 2 * 1024 * 1024 }).success).toBe(true);
    expect(schema.safeParse({ repo: "o/r", path_prefix: "docs/" }).success).toBe(true);
  });
});
