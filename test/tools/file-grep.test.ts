import { describe, expect, it, vi } from "vitest";
import { createCacheStore } from "../../src/core/cache.js";
import { GithubClient } from "../../src/core/github.js";
import type { GitHubApi } from "../../src/core/github.js";
import type { HttpClient, HttpResponse } from "../../src/core/http.js";
import { fileGrepTool } from "../../src/tools/file-grep.js";
import { makeConfig } from "../helpers.js";

function contents(path: string, text: string) {
  return {
    type: "file",
    encoding: "base64",
    size: Buffer.byteLength(text),
    name: path,
    path,
    sha: "sha1",
    content: Buffer.from(text).toString("base64"),
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

//? resolveRef must still work when no explicit ref is passed, so this mock routes
//* by path shape: repo lookups answer a default branch, contents answer the file.
function clientForRoutes(): GitHubApi {
  return {
    api: vi.fn(async (path: string) => ({
      data: path.includes("/contents/") ? contents("notes.txt", TEN_LINES) : { default_branch: "main" },
      headers: new Headers(),
      status: 200,
      contentType: "application/json",
      cache: { state: "miss" },
    })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

const TEN_LINES = [
  "one",
  "two",
  "find me here",
  "four",
  "five",
  "six",
  "also find me",
  "eight",
  "nine",
  "ten",
].join("\n");

function ctxFor(client: GitHubApi) {
  return { client, config: makeConfig(), authFingerprint: "abc" };
}

function httpResponse(status: number, body: string, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: new Headers(headers),
    body: new TextEncoder().encode(body),
    url: "https://api.github.com/repos/octocat/Hello-World",
  };
}

describe("github_file_grep", () => {
  it("reports line, column, and deduplicated context for each match", async () => {
    const client = clientFor(contents("docs/notes.txt", TEN_LINES));
    const output = await fileGrepTool.handler(
      { repo: "octocat/Hello-World", path: "docs/notes.txt", pattern: "find", ref: "main" },
      ctxFor(client),
    );
    //? The two matches sit four lines apart with the default context of 2, so the
    //* ranges touch on line 5: the earlier match keeps it and the later match's
    //* context starts after it (dedup merges forward).
    expect(output).toEqual({
      repo: "octocat/Hello-World",
      path: "docs/notes.txt",
      ref: "main",
      pattern: "find",
      total_lines: 10,
      matches: [
        {
          line: 3,
          column: 1,
          line_text: "find me here",
          context: [
            { line: 1, text: "one" },
            { line: 2, text: "two" },
            { line: 4, text: "four" },
            { line: 5, text: "five" },
          ],
        },
        {
          line: 7,
          column: 6,
          line_text: "also find me",
          context: [
            { line: 6, text: "six" },
            { line: 8, text: "eight" },
            { line: 9, text: "nine" },
          ],
        },
      ],
      meta: { cache: "miss", calls: 1 },
    });
  });

  it("caps matches at max_matches and reports matches_truncated", async () => {
    const client = clientFor(contents("docs/notes.txt", TEN_LINES));
    const output = await fileGrepTool.handler(
      { repo: "octocat/Hello-World", path: "docs/notes.txt", pattern: "find", ref: "main", max_matches: 1 },
      ctxFor(client),
    );
    expect(output).toMatchObject({ matches_truncated: true, total_lines: 10 });
    expect(output.matches).toHaveLength(1);
    expect(output).toMatchObject({ matches: [{ line: 3, column: 1 }] });
  });

  it("completes on a pathological backtracking pattern", async () => {
    //? (a+)+$ against a line of a's ending in b is the classic catastrophic
    //* backtracking shape. The caps bound input size and result count, but a
    //* pathological pattern can still take exponential time inside a single
    //* exec — accepted exposure, see the tool description. The assertion is
    //* completion, not timing; the run length stays modest so the worst case
    //* holds well under the default test timeout.
    const text = `${"a".repeat(18)}b\nnext\n`;
    const client = clientFor(contents("big.txt", text));
    const output = await fileGrepTool.handler(
      { repo: "octocat/Hello-World", path: "big.txt", pattern: "(a+)+$", ref: "main" },
      ctxFor(client),
    );
    expect(output).toMatchObject({ total_lines: 3, matches: [] });
    expect("matches_truncated" in output).toBe(false);
  });

  it("rejects an invalid pattern with the RegExp syntax message and zero upstream calls", async () => {
    const client = clientFor(contents("docs/notes.txt", TEN_LINES));
    await expect(
      fileGrepTool.handler(
        { repo: "octocat/Hello-World", path: "docs/notes.txt", pattern: "([", ref: "main" },
        ctxFor(client),
      ),
    ).rejects.toMatchObject({
      code: "invalid_params",
      message: expect.stringContaining("Invalid regular expression"),
    });
    expect(client.api).not.toHaveBeenCalled();
  });

  it("rejects binary content as invalid_params", async () => {
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
    await expect(
      fileGrepTool.handler(
        { repo: "octocat/Hello-World", path: "logo.png", pattern: "anything", ref: "main" },
        ctxFor(client),
      ),
    ).rejects.toMatchObject({ code: "invalid_params", message: "binary file; grep needs text" });
  });

  it("counts the resolveRef request in meta.calls when no explicit ref is passed", async () => {
    const client = clientForRoutes();
    const output = await fileGrepTool.handler(
      { repo: "octocat/Hello-World", path: "notes.txt", pattern: "find" },
      ctxFor(client),
    );
    expect(client.api).toHaveBeenCalledTimes(2);
    expect(output).toMatchObject({ ref: "main" });
    expect(output.meta).toEqual({ cache: "miss", calls: 2 });
  });

  it("serves a repeated call from the cache with zero additional upstream calls", async () => {
    //? A real GithubClient with an in-memory store proves the cache-first claim:
    //* the HTTP mock is the upstream, so one HTTP call across two handler runs is
    //* the zero-additional-calls guarantee, and meta reports miss then hit.
    const get = vi.fn(async () =>
      httpResponse(200, JSON.stringify(contents("notes.txt", TEN_LINES)), { "content-type": "application/json" }),
    );
    const client = new GithubClient({
      //? Same posture as test/core/github.test.ts: a concrete vi.fn cannot satisfy
      //! HttpClient under exactOptionalPropertyTypes, so the literal is asserted.
      http: { get } as unknown as HttpClient,
      cache: createCacheStore({ mode: "memory", dir: "" }),
      config: makeConfig(),
      authFingerprint: "abc",
    });
    const ctx = ctxFor(client);
    const input = { repo: "octocat/Hello-World", path: "notes.txt", pattern: "find", ref: "main" };
    const first = await fileGrepTool.handler(input, ctx);
    const second = await fileGrepTool.handler(input, ctx);
    expect(get).toHaveBeenCalledTimes(1);
    expect(first.meta).toMatchObject({ cache: "miss", calls: 1 });
    expect(second.meta).toMatchObject({ cache: "hit", calls: 1 });
    expect(second.matches).toEqual(first.matches);
  });
});
