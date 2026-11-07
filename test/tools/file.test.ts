import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { fileTool } from "../../src/tools/file.js";
import { makeConfig } from "../helpers.js";

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
    api: vi.fn(async () => ({ data, headers: new Headers(), status: 200, contentType: "application/json" })),
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
});
