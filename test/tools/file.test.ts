import { beforeEach, describe, expect, it, vi } from "vitest";
import { GithubError } from "../../src/core/errors.js";
import type { GitHubApi } from "../../src/core/github.js";
import { fileTool } from "../../src/tools/file.js";
import { clearPinnedRef, setPinnedRef } from "../../src/tools/pin.js";
import { makeConfig, memoryCacheStore, seedCacheTree } from "../helpers.js";

const REPO = "octocat/Hello-World";

//? The pin map is module state shared by every test in this file; a leftover
//* entry from the pin cases would otherwise leak into the no-pin assertions.
beforeEach(() => {
  clearPinnedRef(REPO);
});

function contents(content: string) {
  return {
    type: "file",
    encoding: "base64",
    size: Buffer.byteLength(content),
    name: "README.md",
    path: "README.md",
    sha: "sha1",
    content: Buffer.from(content).toString("base64"),
    download_url: null,
  };
}

//? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
//! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
function clientFor(data: unknown): GitHubApi {
  return {
    api: vi.fn(async () => ({ data, headers: new Headers(), status: 200, contentType: "application/json", cache: { state: "miss" } })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

describe("github_file", () => {
  it("decodes base64 text and reports sha and size", async () => {
    const client = clientFor(contents("Hello World!\n"));
    const output = await fileTool.handler(
      { repo: "octocat/Hello-World", path: "README.md", ref: "main" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      repo: "octocat/Hello-World",
      path: "README.md",
      ref: "main",
      sha: "sha1",
      size: 13,
      encoding: "utf-8",
      content: "Hello World!\n",
      binary: false,
      truncated: false,
      start_line: 1,
      end_line: 2,
      total_lines: 2,
      meta: { cache: "miss", calls: 1 },
    });
  });

  it("never returns binary bytes as text", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const client = clientFor({
      type: "file",
      encoding: "base64",
      size: png.length,
      name: "logo.png",
      path: "logo.png",
      sha: "sha2",
      content: png.toString("base64"),
      download_url: null,
    });
    const output = await fileTool.handler(
      { repo: "octocat/Hello-World", path: "logo.png", ref: "main" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      binary: true,
      encoding: null,
      content: null,
      size: png.length,
      start_line: null,
      end_line: null,
      total_lines: null,
    });
  });

  it("returns the selected line range with resolved metadata", async () => {
    const client = clientFor(contents("one\ntwo\nthree\n"));
    const output = await fileTool.handler(
      { repo: "octocat/Hello-World", path: "README.md", ref: "main", start_line: 2, end_line: 2 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      content: "two\n",
      start_line: 2,
      end_line: 2,
      total_lines: 4,
      truncated: false,
    });
  });

  it("clamps end_line to the last line", async () => {
    const client = clientFor(contents("one\ntwo\nthree"));
    const output = await fileTool.handler(
      { repo: "octocat/Hello-World", path: "README.md", ref: "main", start_line: 2, end_line: 99 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      content: "two\nthree",
      start_line: 2,
      end_line: 3,
      total_lines: 3,
    });
  });

  it("rejects start_line beyond the end of the file", async () => {
    const client = clientFor(contents("one\ntwo\nthree"));
    await expect(
      fileTool.handler(
        { repo: "octocat/Hello-World", path: "README.md", ref: "main", start_line: 4 },
        { client, config: makeConfig(), authFingerprint: "abc" },
      ),
    ).rejects.toMatchObject({ code: "invalid_params", message: expect.stringContaining("3 lines") });
  });

  it("rejects end_line before start_line", async () => {
    const client = clientFor(contents("one\ntwo\nthree"));
    await expect(
      fileTool.handler(
        { repo: "octocat/Hello-World", path: "README.md", ref: "main", start_line: 3, end_line: 2 },
        { client, config: makeConfig(), authFingerprint: "abc" },
      ),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("clips the selected range by bytes and reports truncated", async () => {
    const client = clientFor(contents("aaaa\nbbbb\n"));
    const output = await fileTool.handler(
      { repo: "octocat/Hello-World", path: "README.md", ref: "main", start_line: 1 },
      { client, config: makeConfig({ maxFileBytes: 6 }), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      content: "aaaa\nb",
      truncated: true,
      size: 10,
      start_line: 1,
      end_line: 3,
      total_lines: 3,
    });
  });

  it("returns the whole empty file", async () => {
    const client = clientFor(contents(""));
    const output = await fileTool.handler(
      { repo: "octocat/Hello-World", path: "README.md", ref: "main" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      content: "",
      truncated: false,
      start_line: 1,
      end_line: 1,
      total_lines: 1,
    });
  });

  it("clips the selected range to the per-call byte budget", async () => {
    const client = clientFor(contents("aaaa\nbbbb\n"));
    const output = await fileTool.handler(
      { repo: "octocat/Hello-World", path: "README.md", ref: "main", max_bytes: 3 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({ content: "aaa", truncated: true, size: 10 });
  });

  it("caps max_bytes at the configured global budget", async () => {
    const client = clientFor(contents("aaaa\nbbbb\n"));
    const output = await fileTool.handler(
      { repo: "octocat/Hello-World", path: "README.md", ref: "main", max_bytes: 1_000_000 },
      { client, config: makeConfig({ maxFileBytes: 4 }), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({ content: "aaaa", truncated: true });
  });

  it("anchors a ref-less read to the pinned sha and reports pinned_sha", async () => {
    //? Review focus: the contents request URL must carry the pinned SHA, not the
    //* branch the pin was created from; the sha also short-circuits the
    //* default-branch lookup, so exactly one upstream call happens.
    const client = clientFor(contents("Hello World!\n"));
    setPinnedRef(REPO, "main", "abc123def456");
    const output = await fileTool.handler(
      { repo: REPO, path: "README.md" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(client.api).toHaveBeenCalledWith(
      `/repos/${REPO}/contents/README.md?ref=abc123def456`,
      { fresh: undefined, cacheTtlMs: 300_000 },
    );
    expect(output).toEqual({
      repo: REPO,
      path: "README.md",
      ref: "abc123def456",
      sha: "sha1",
      size: 13,
      encoding: "utf-8",
      content: "Hello World!\n",
      binary: false,
      truncated: false,
      start_line: 1,
      end_line: 2,
      total_lines: 2,
      pinned_sha: "abc123def456",
      meta: { cache: "miss", calls: 1 },
    });
  });

  it("lets an explicit ref win over the pin and omits pinned_sha", async () => {
    const client = clientFor(contents("Hello World!\n"));
    setPinnedRef(REPO, "main", "abc123def456");
    const output = await fileTool.handler(
      { repo: REPO, path: "README.md", ref: "main" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith(
      `/repos/${REPO}/contents/README.md?ref=main`,
      { fresh: undefined, cacheTtlMs: 300_000 },
    );
    expect("pinned_sha" in output).toBe(false);
  });

  it("keeps the output free of pinned_sha when no pin exists", async () => {
    const client = clientFor(contents("Hello World!\n"));
    const output = await fileTool.handler(
      { repo: REPO, path: "README.md", ref: "main" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect("pinned_sha" in output).toBe(false);
    expect(client.api).toHaveBeenCalledTimes(1);
  });
});

describe("github_file 404 recovery hints", () => {
  function failingClient(error: GithubError): GitHubApi {
    return {
      api: vi.fn(async () => {
        throw error;
      }),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
  }

  it("decorates a path 404 with cached root siblings and makes no extra upstream calls", async () => {
    //? The hint must come from the local cache only: the failing contents read
    //* is the whole upstream cost, so exactly one api call is allowed here.
    const store = memoryCacheStore();
    await seedCacheTree(store, "abc", "https://api.github.com/repos/octocat/Hello-World/git/trees/main", {
      tree: [{ path: "README.md" }, { path: "src" }, { path: "docs" }],
    });
    const client = failingClient(new GithubError("not_found", "Not Found", { status: 404 }));
    const error = (await fileTool
      .handler(
        { repo: REPO, path: "gone.md", ref: "main" },
        { client, config: makeConfig(), authFingerprint: "abc", cache: store },
      )
      .catch((caught: unknown) => caught)) as GithubError;
    expect(error).toBeInstanceOf(GithubError);
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("Not Found");
    expect(error.details.status).toBe(404);
    expect(error.details.hint).toBe(
      'path "gone.md" not found at ref main; entries in repo root: README.md, src, docs',
    );
    expect(client.api).toHaveBeenCalledTimes(1);
  });

  it("returns the untouched 404 when no tree listing is cached", async () => {
    const notFound = new GithubError("not_found", "Not Found", { status: 404 });
    const client = failingClient(notFound);
    await expect(
      fileTool.handler(
        { repo: REPO, path: "gone.md", ref: "main" },
        { client, config: makeConfig(), authFingerprint: "abc" },
      ),
    ).rejects.toBe(notFound);
  });
});
