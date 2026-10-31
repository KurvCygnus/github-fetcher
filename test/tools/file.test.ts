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
    });
  });
});
