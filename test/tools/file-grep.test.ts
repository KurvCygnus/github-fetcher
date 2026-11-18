import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCacheStore } from "../../src/core/cache.js";
import type { Config } from "../../src/core/config.js";
import { GithubClient } from "../../src/core/github.js";
import type { GitHubApi } from "../../src/core/github.js";
import type { HttpClient, HttpResponse } from "../../src/core/http.js";
import { fileGrepTool, matchFileLines } from "../../src/tools/file-grep.js";
import { clearPinnedRef, setPinnedRef } from "../../src/tools/pin.js";
import { makeConfig } from "../helpers.js";

const REPO = "octocat/Hello-World";

//? Shared with the module mock below; vi.hoisted guarantees the object exists
//* before the mock factory runs, and beforeEach resets both fields so tests
//* never observe each other's workers or sabotage flags.
const workerState = vi.hoisted(() => ({ sabotage: false, terminations: 0 }));

//? Every handler invocation in this file spawns the real eval worker; the mock
//* only wraps the class so (a) the worker-error test can force a worker whose
//* eval source throws at startup — a genuine worker_threads 'error' event, not
//* a fake emitter — and (b) tests can observe terminate() calls, since the
//* budget promise requires the worker to die on every exit path. All other
//* constructions pass through to the real Worker untouched.
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  class Worker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      if (workerState.sabotage) {
        super('throw new Error("worker bootstrap failed");', { eval: true });
        workerState.sabotage = false;
      } else {
        super(...args);
      }
    }
    override terminate() {
      workerState.terminations += 1;
      return super.terminate();
    }
  }
  return { ...actual, Worker };
});

//? The pin map is module state shared by every test in this file; a leftover
//* entry from the pin cases would otherwise leak into the no-pin assertions.
beforeEach(() => {
  clearPinnedRef(REPO);
  workerState.sabotage = false;
  workerState.terminations = 0;
});

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

function ctxFor(client: GitHubApi, overrides: Partial<Config> = {}) {
  return { client, config: makeConfig(overrides), authFingerprint: "abc" };
}

function httpResponse(status: number, body: string, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: new Headers(headers),
    body: new TextEncoder().encode(body),
    url: "https://api.github.com/repos/octocat/Hello-World",
  };
}

describe("matchFileLines", () => {
  it("reports line, column, and deduplicated context for each match", () => {
    //? Moved from the 0.4 handler fixture: the two matches sit four lines apart
    //* with a context of 2, so the ranges touch on line 5 — the earlier match
    //* keeps it and the later match's context starts after it (dedup merges
    //* forward). Match lines themselves stay outside the dedup set.
    const result = matchFileLines("find", TEN_LINES, 2, 50);
    expect(result).toEqual({
      total_lines: 10,
      matches_truncated: false,
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
    });
  });

  it("caps matches at max_matches and reports matches_truncated", () => {
    const result = matchFileLines("find", TEN_LINES, 2, 1);
    expect(result).toEqual({
      total_lines: 10,
      matches_truncated: true,
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
      ],
    });
  });

  it("advances past zero-length matches instead of looping", () => {
    //? /a*/ matches empty at every position and exec leaves lastIndex on an
    //* empty match, so the advance guard is what terminates the scan; the four
    //* expected columns prove the cursor moved forward one character at a time
    //* and that the "a" at column 3 was still reported normally.
    const result = matchFileLines("a*", "bab", 0, 50);
    expect(result).toEqual({
      total_lines: 1,
      matches_truncated: false,
      matches: [
        { line: 1, column: 1, line_text: "bab", context: [] },
        { line: 1, column: 2, line_text: "bab", context: [] },
        { line: 1, column: 3, line_text: "bab", context: [] },
        { line: 1, column: 4, line_text: "bab", context: [] },
      ],
    });
  });

  it("throws the raw RegExp message on an invalid pattern", () => {
    expect(() => matchFileLines("([", TEN_LINES, 2, 50)).toThrowError(/Invalid regular expression/);
  });
});

describe("github_file_grep", () => {
  it("returns the identical shape through the worker path as the direct call", async () => {
    //? Worker result parity: the handler must not reshape what matchFileLines
    //* produced as it crosses the worker boundary — the envelope keys wrap the
    //* exact matches/total_lines the pure function returned over postMessage.
    const direct = matchFileLines("find", TEN_LINES, 2, 50);
    expect(direct.matches.length).toBeGreaterThan(0);
    const client = clientFor(contents("docs/notes.txt", TEN_LINES));
    const output = await fileGrepTool.handler(
      { repo: "octocat/Hello-World", path: "docs/notes.txt", pattern: "find", ref: "main" },
      ctxFor(client),
    );
    expect(output).toEqual({
      repo: "octocat/Hello-World",
      path: "docs/notes.txt",
      ref: "main",
      pattern: "find",
      total_lines: direct.total_lines,
      matches: direct.matches,
      ...(direct.matches_truncated ? { matches_truncated: true } : {}),
      meta: { cache: "miss", calls: 1 },
    });
    //? The success path also terminates the worker — no live worker may linger.
    expect(workerState.terminations).toBe(1);
  });

  it("degrades to the overrun shape when matching exceeds the time budget", async () => {
    //? FLIPPED from 0.4's "completes on a pathological backtracking pattern":
    //* the owner-decided mitigation (worker + budget) changes that behavior —
    //* the same pattern now blows the budget and the handler degrades to
    //* matches_truncated with a hint instead of blocking the session.
    //* (a+)+$ against a run of a's ending in b is the classic catastrophic
    //* backtracking shape; 26 a's measure ~850 ms per exec on the dev machine
    //* (17x the 50 ms budget), and the test stays fast because terminate()
    //* kills the runaway exec at the budget instead of waiting for it.
    const text = `${"a".repeat(26)}b\nnext\n`;
    const client = clientFor(contents("big.txt", text));
    const output = await fileGrepTool.handler(
      { repo: "octocat/Hello-World", path: "big.txt", pattern: "(a+)+$", ref: "main" },
      ctxFor(client, { grepTimeoutMs: 50 }),
    );
    expect(output).toEqual({
      repo: "octocat/Hello-World",
      path: "big.txt",
      ref: "main",
      pattern: "(a+)+$",
      total_lines: 3,
      matches: [],
      matches_truncated: true,
      hint: "pattern execution exceeded the time budget (50 ms); narrow the pattern or read the file in windows",
      meta: { cache: "miss", calls: 1 },
    });
    //? The timeout path must terminate the runaway worker.
    expect(workerState.terminations).toBe(1);
  });

  it("maps a worker error event to invalid_params and terminates the worker", async () => {
    //? The sabotage flag swaps exactly one Worker construction for a real
    //* worker whose eval source throws at startup, so the handler sees a
    //* genuine 'error' event from worker_threads and must answer invalid_params.
    workerState.sabotage = true;
    const client = clientFor(contents("docs/notes.txt", TEN_LINES));
    await expect(
      fileGrepTool.handler(
        { repo: "octocat/Hello-World", path: "docs/notes.txt", pattern: "find", ref: "main" },
        ctxFor(client),
      ),
    ).rejects.toMatchObject({ code: "invalid_params", message: "worker bootstrap failed" });
    expect(workerState.terminations).toBe(1);
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

  it("anchors a ref-less search to the pinned sha and reports pinned_sha", async () => {
    //? Review focus: the contents request URL must carry the pinned SHA, not the
    //* branch the pin was created from; the sha also short-circuits the
    //* default-branch lookup, so exactly one upstream call happens.
    const client = clientForRoutes();
    setPinnedRef(REPO, "main", "abc123def456");
    const output = await fileGrepTool.handler(
      { repo: REPO, path: "notes.txt", pattern: "find" },
      ctxFor(client),
    );
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(client.api).toHaveBeenCalledWith(
      `/repos/${REPO}/contents/notes.txt?ref=abc123def456`,
      { fresh: undefined, cacheTtlMs: 300_000 },
    );
    expect(output).toEqual({
      repo: REPO,
      path: "notes.txt",
      ref: "abc123def456",
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
      pinned_sha: "abc123def456",
      meta: { cache: "miss", calls: 1 },
    });
  });

  it("lets an explicit ref win over the pin and omits pinned_sha", async () => {
    const client = clientForRoutes();
    setPinnedRef(REPO, "main", "abc123def456");
    const output = await fileGrepTool.handler(
      { repo: REPO, path: "notes.txt", pattern: "find", ref: "main" },
      ctxFor(client),
    );
    expect(client.api).toHaveBeenCalledWith(
      `/repos/${REPO}/contents/notes.txt?ref=main`,
      { fresh: undefined, cacheTtlMs: 300_000 },
    );
    expect("pinned_sha" in output).toBe(false);
  });
});
