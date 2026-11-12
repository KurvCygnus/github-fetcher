import { describe, expect, it, vi } from "vitest";
import { GithubError } from "../../src/core/errors.js";
import type { GitHubApi } from "../../src/core/github.js";
import { readmeTool } from "../../src/tools/readme.js";
import { makeConfig } from "../helpers.js";

function readme(content: string) {
  return {
    encoding: "base64",
    size: Buffer.byteLength(content),
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

function clientWithoutReadme(): GitHubApi {
  return {
    api: vi.fn(async () => {
      //? The client surfaces a 404 as GithubError("not_found"); the mock throws
      //? that directly so the handler's pass-through is exercised offline.
      throw new GithubError("not_found", "Not Found");
    }),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

describe("github_readme", () => {
  it("decodes the base64 readme and projects sha, size, and path", async () => {
    const client = clientFor(readme("Hello World!\n"));
    const output = await readmeTool.handler(
      { repo: "octocat/Hello-World" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/repos/octocat/Hello-World/readme", {
      fresh: undefined,
      cacheTtlMs: 300_000,
    });
    expect(output).toEqual({
      repo: "octocat/Hello-World",
      path: "README.md",
      sha: "sha1",
      size: 13,
      encoding: "utf-8",
      content: "Hello World!\n",
      binary: false,
      truncated: false,
      meta: { cache: "miss" },
    });
  });

  it("forwards the fresh flag to bypass the cache", async () => {
    const client = clientFor(readme("Hello World!\n"));
    await readmeTool.handler(
      { repo: "octocat/Hello-World", fresh: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/repos/octocat/Hello-World/readme", {
      fresh: true,
      cacheTtlMs: 300_000,
    });
  });

  it("never returns binary bytes as text", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const client = clientFor({
      encoding: "base64",
      size: png.length,
      path: "README.png",
      sha: "sha2",
      content: png.toString("base64"),
      download_url: null,
    });
    const output = await readmeTool.handler(
      { repo: "octocat/Hello-World" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      repo: "octocat/Hello-World",
      path: "README.png",
      size: png.length,
      encoding: null,
      content: null,
      binary: true,
      truncated: false,
    });
  });

  it("clips long content by bytes and reports truncated", async () => {
    const client = clientFor(readme("aaaa\nbbbb\n"));
    const output = await readmeTool.handler(
      { repo: "octocat/Hello-World" },
      { client, config: makeConfig({ maxFileBytes: 6 }), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      content: "aaaa\nb",
      truncated: true,
      size: 10,
      binary: false,
    });
  });

  it("propagates not_found when the repository has no readme", async () => {
    await expect(
      readmeTool.handler(
        { repo: "octocat/Hello-World" },
        { client: clientWithoutReadme(), config: makeConfig(), authFingerprint: "abc" },
      ),
    ).rejects.toMatchObject({ code: "not_found", message: "Not Found" });
  });

  it("rejects a repo outside owner/name form with invalid_params", async () => {
    const client = clientFor(readme("Hello World!\n"));
    await expect(
      readmeTool.handler(
        { repo: "no-slash" },
        { client, config: makeConfig(), authFingerprint: "abc" },
      ),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});
