import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCacheStore } from "../../src/core/cache.js";
import type { GitHubApi } from "../../src/core/github.js";
import { GithubClient } from "../../src/core/github.js";
import type { HttpClient, HttpResponse } from "../../src/core/http.js";
import { filesBatchTool } from "../../src/tools/files-batch.js";
import { GithubError } from "../../src/core/errors.js";
import { clearPinnedRef, setPinnedRef } from "../../src/tools/pin.js";
import { makeClientWith, makeConfig } from "../helpers.js";

const REPO = "octocat/Hello-World";

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

//? Routing mock: repo lookups answer a default branch and contents lookups are
//* served from a table keyed by the requested path; a path missing from the
//* table 404s, so one mock drives the mixed ok/not-found/malformed batch.
function clientForRoutes(files: Record<string, unknown>): GitHubApi {
  return {
    api: vi.fn(async (path: string) => {
      const prefix = `/repos/${REPO}/contents/`;
      if (path.startsWith(prefix)) {
        const requested = decodeURIComponent(path.slice(prefix.length).split("?")[0] ?? "");
        if (!(requested in files)) throw new GithubError("not_found", "Not Found");
        return {
          data: files[requested],
          headers: new Headers(),
          status: 200,
          contentType: "application/json",
          cache: { state: "miss" },
          quota: { resource: "core", remaining: 12 },
        };
      }
      if (path === `/repos/${REPO}`) {
        return {
          data: { default_branch: "main" },
          headers: new Headers(),
          status: 200,
          contentType: "application/json",
          cache: { state: "miss" },
          quota: { resource: "core", remaining: 12 },
        };
      }
      throw new Error(`unexpected path ${path}`);
    }),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

function ctxFor(client: GitHubApi, overrides: Parameters<typeof makeConfig>[0] = {}) {
  return { client, config: makeConfig(overrides), authFingerprint: "abc" };
}

function httpResponse(status: number, body: string, headers: Record<string, string> = {}): HttpResponse {
  return {
    status,
    headers: new Headers(headers),
    body: new TextEncoder().encode(body),
    url: `https://api.github.com/repos/${REPO}`,
  };
}

describe("github_files", () => {
  //? The pin map is module state shared by every test in this file; a leftover
  //* entry from the pin cases would otherwise leak into the no-pin assertions.
  beforeEach(() => {
    clearPinnedRef(REPO);
  });

  it("reports per-item ok and error for a mixed batch without rejecting", async () => {
    const client = clientForRoutes({ "docs/notes.txt": contents("docs/notes.txt", "alpha\n") });
    const output = await filesBatchTool.handler(
      { repo: REPO, paths: ["docs/notes.txt", "missing.txt", ".."], ref: "main" },
      ctxFor(client),
    );
    const items = output.results as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      path: "docs/notes.txt",
      ok: true,
      data: {
        path: "docs/notes.txt",
        sha: "sha1",
        size: 6,
        encoding: "utf-8",
        content: "alpha\n",
        binary: false,
        truncated: false,
        total_lines: 2,
      },
    });
    expect(items[1]).toEqual({
      path: "missing.txt",
      ok: false,
      error: { code: "not_found", message: "Not Found" },
    });
    //? The malformed entry dies in encodePath before any request, so it costs
    //* zero upstream calls and carries invalid_params per item.
    expect(items[2]).toEqual({
      path: "..",
      ok: false,
      error: { code: "invalid_params", message: "path must not contain empty, . or .. segments" },
    });
    expect(client.api).toHaveBeenCalledTimes(2);
    expect(output.elapsed_ms).toEqual(expect.any(Number));
    expect(output.meta).toEqual({ cache: "miss", quota: { resource: "core", remaining: 12 }, calls: 2 });
  });

  it("projects every ok item with the github_file fields plus total_lines", async () => {
    const client = clientForRoutes({
      "a.txt": contents("a.txt", "alpha\n"),
      "b.txt": contents("b.txt", "beta\n"),
      "c.txt": contents("c.txt", "gamma\n"),
    });
    const output = await filesBatchTool.handler(
      { repo: REPO, paths: ["a.txt", "b.txt", "c.txt"], ref: "main" },
      ctxFor(client),
    );
    const items = output.results as Array<Record<string, unknown>>;
    expect(items).toEqual([
      {
        path: "a.txt",
        ok: true,
        data: { path: "a.txt", sha: "sha1", size: 6, encoding: "utf-8", content: "alpha\n", binary: false, truncated: false, total_lines: 2 },
      },
      {
        path: "b.txt",
        ok: true,
        data: { path: "b.txt", sha: "sha1", size: 5, encoding: "utf-8", content: "beta\n", binary: false, truncated: false, total_lines: 2 },
      },
      {
        path: "c.txt",
        ok: true,
        data: { path: "c.txt", sha: "sha1", size: 6, encoding: "utf-8", content: "gamma\n", binary: false, truncated: false, total_lines: 2 },
      },
    ]);
    expect(output.meta).toEqual({ cache: "miss", quota: { resource: "core", remaining: 12 }, calls: 3 });
  });

  it("rejects more than 10 paths at the schema boundary and fewer than 1", () => {
    //? Review focus: the >10 rejection must happen in Zod before the handler
    //* runs, so the parse itself is asserted against the registered schema.
    const schema = z.object(filesBatchTool.inputSchema);
    const eleven = Array.from({ length: 11 }, (_, index) => `f${index}.txt`);
    expect(schema.safeParse({ repo: REPO, paths: eleven }).success).toBe(false);
    expect(schema.safeParse({ repo: REPO, paths: [] }).success).toBe(false);
    expect(schema.safeParse({ repo: REPO, paths: eleven.slice(0, 10) }).success).toBe(true);
  });

  it("starts every path's contents request concurrently", async () => {
    //? The gates hold each contents response back, so the flush below can only
    //* pass if all three requests were already in flight: three recorded calls
    //* with zero responses is the concurrency proof, not three eventual calls.
    //* The explicit ref keeps resolveRef from adding a repo lookup to the mix.
    const gates: Array<() => void> = [];
    const calls: string[] = [];
    const client = {
      api: vi.fn(async (path: string) => {
        calls.push(path);
        await new Promise<void>((resolve) => gates.push(resolve));
        const requested = decodeURIComponent(path.split("/contents/")[1]?.split("?")[0] ?? "");
        return {
          data: contents(requested, "alpha\n"),
          headers: new Headers(),
          status: 200,
          contentType: "application/json",
          cache: { state: "miss" },
        };
      }),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const promise = filesBatchTool.handler(
      { repo: REPO, paths: ["a.txt", "b.txt", "c.txt"], ref: "main", fresh: true },
      ctxFor(client),
    );
    //? A macrotask tick drains every pending microtask deterministically, so the
    //* assertion below cannot be raced by handler-internal awaits.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([
      `/repos/${REPO}/contents/a.txt?ref=main`,
      `/repos/${REPO}/contents/b.txt?ref=main`,
      `/repos/${REPO}/contents/c.txt?ref=main`,
    ]);
    gates.forEach((release) => release());
    const output = await promise;
    expect(output.results).toHaveLength(3);
    expect(client.api).toHaveBeenCalledWith(`/repos/${REPO}/contents/a.txt?ref=main`, {
      fresh: true,
      cacheTtlMs: 300_000,
    });
  });

  it("counts the resolveRef request when no explicit ref is passed", async () => {
    const client = clientForRoutes({ "a.txt": contents("a.txt", "alpha\n") });
    const output = await filesBatchTool.handler({ repo: REPO, paths: ["a.txt"] }, ctxFor(client));
    expect(client.api).toHaveBeenCalledTimes(2);
    expect(client.api).toHaveBeenCalledWith(`/repos/${REPO}`, { fresh: undefined, cacheTtlMs: 600_000 });
    expect(client.api).toHaveBeenCalledWith(`/repos/${REPO}/contents/a.txt?ref=main`, {
      fresh: undefined,
      cacheTtlMs: 300_000,
    });
    expect(output.meta).toMatchObject({ cache: "miss", calls: 2 });
  });

  it("serves a repeated batch from the cache with zero additional upstream calls", async () => {
    //? A real GithubClient with an in-memory store proves the cache-first claim:
    //* the HTTP mock is the upstream, so two HTTP calls across two handler runs
    //* (one per path) is the zero-additional-calls guarantee, and meta reports
    //* miss then hit while still counting each path's one client invocation.
    const get = vi.fn(async (url: string) => {
      const requested = decodeURIComponent(url.split("/contents/")[1]?.split("?")[0] ?? "");
      return httpResponse(200, JSON.stringify(contents(requested, "shared\n")), { "content-type": "application/json" });
    });
    const client = new GithubClient({
      //? Same posture as test/core/github.test.ts: a concrete vi.fn cannot satisfy
      //! HttpClient under exactOptionalPropertyTypes, so the literal is asserted.
      http: { get } as unknown as HttpClient,
      cache: createCacheStore({ mode: "memory", dir: "" }),
      config: makeConfig(),
      authFingerprint: "abc",
    });
    const ctx = ctxFor(client);
    const input = { repo: REPO, paths: ["a.txt", "b.txt"], ref: "main" };
    const first = await filesBatchTool.handler(input, ctx);
    const second = await filesBatchTool.handler(input, ctx);
    expect(get).toHaveBeenCalledTimes(2);
    expect(first.meta).toMatchObject({ cache: "miss", calls: 2 });
    expect(second.meta).toMatchObject({ cache: "hit", calls: 2 });
    expect(second.results).toEqual(first.results);
  });

  it("returns the binary projection without bytes", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const client = makeClientWith({
      type: "file",
      encoding: "base64",
      size: png.length,
      name: "logo.png",
      path: "logo.png",
      sha: "sha2",
      content: png.toString("base64"),
      download_url: null,
    });
    const output = await filesBatchTool.handler(
      { repo: REPO, paths: ["logo.png"], ref: "main" },
      ctxFor(client),
    );
    const items = output.results as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({
      path: "logo.png",
      ok: true,
      data: { path: "logo.png", sha: "sha2", size: 7, encoding: null, content: null, binary: true, truncated: false, total_lines: null },
    });
  });

  it("turns invalid UTF-8 into a per-item unsupported error", async () => {
    //? The extension must stay outside the binary list so looksBinary's
    //* extension short-circuit does not claim the file before the decoder runs.
    const client = makeClientWith({
      type: "file",
      encoding: "base64",
      size: 1,
      name: "bad-utf8",
      path: "bad-utf8",
      sha: "sha3",
      content: Buffer.from([0xff]).toString("base64"),
      download_url: null,
    });
    const output = await filesBatchTool.handler(
      { repo: REPO, paths: ["bad-utf8"], ref: "main" },
      ctxFor(client),
    );
    const items = output.results as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({
      path: "bad-utf8",
      ok: false,
      error: { code: "unsupported", message: "file is not valid UTF-8" },
    });
  });

  it("turns a directory hit into a per-item invalid_params error", async () => {
    const client = makeClientWith([
      { path: "docs", mode: "040000", type: "tree", sha: "tree1", size: 0, url: "x" },
    ]);
    const output = await filesBatchTool.handler(
      { repo: REPO, paths: ["docs"], ref: "main" },
      ctxFor(client),
    );
    const items = output.results as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({
      path: "docs",
      ok: false,
      error: { code: "invalid_params", message: "path points to a directory; use github_tree" },
    });
  });

  it("falls back to the download URL when the payload has no inline content", async () => {
    const client = makeClientWith({
      type: "file",
      encoding: "base64",
      size: 6,
      name: "big.txt",
      path: "big.txt",
      sha: "sha4",
      download_url: "https://raw.githubusercontent.com/octocat/Hello-World/main/big.txt",
    });
    (client.raw as ReturnType<typeof vi.fn>).mockResolvedValue(new TextEncoder().encode("rawsix"));
    const output = await filesBatchTool.handler(
      { repo: REPO, paths: ["big.txt"], ref: "main" },
      ctxFor(client),
    );
    const items = output.results as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({
      path: "big.txt",
      ok: true,
      data: { path: "big.txt", sha: "sha4", size: 6, encoding: "utf-8", content: "rawsix", binary: false, truncated: false, total_lines: 1 },
    });
    expect(client.raw).toHaveBeenCalledWith("https://raw.githubusercontent.com/octocat/Hello-World/main/big.txt");
    //? Same boundary as github_file: one contents invocation per path, with the
    //* raw fallback fetched outside the counted client.api attempts.
    expect(client.api).toHaveBeenCalledTimes(1);
  });

  it("turns a payload without readable content into a per-item unsupported error", async () => {
    const client = makeClientWith({
      type: "file",
      encoding: "base64",
      size: 6,
      name: "empty.txt",
      path: "empty.txt",
      sha: "sha5",
      download_url: null,
    });
    const output = await filesBatchTool.handler(
      { repo: REPO, paths: ["empty.txt"], ref: "main" },
      ctxFor(client),
    );
    const items = output.results as Array<Record<string, unknown>>;
    //? Message follows the shared decodeContents pipeline, which unified the
    //* per-tool unsupported wording into one generic message.
    expect(items[0]).toEqual({
      path: "empty.txt",
      ok: false,
      error: { code: "unsupported", message: "GitHub did not provide readable content" },
    });
  });

  it("clips each item's content to the configured byte budget and reports truncated", async () => {
    const client = makeClientWith(contents("long.txt", "aaaa\nbbbb\n"));
    const output = await filesBatchTool.handler(
      { repo: REPO, paths: ["long.txt"], ref: "main" },
      ctxFor(client, { maxFileBytes: 4 }),
    );
    const items = output.results as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({
      path: "long.txt",
      ok: true,
      data: { path: "long.txt", sha: "sha1", size: 10, encoding: "utf-8", content: "aaaa", binary: false, truncated: true, total_lines: 3 },
    });
  });

  it("applies a per-call max_bytes to text only and leaves binary untouched", async () => {
    //? The per-call budget overrides the larger config default; binary rows have
    //* no decoded text to clip, so their content and flags stay unchanged.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const client = clientForRoutes({
      "long.txt": contents("long.txt", "aaaa\nbbbb\n"),
      "logo.png": {
        type: "file",
        encoding: "base64",
        size: png.length,
        name: "logo.png",
        path: "logo.png",
        sha: "sha2",
        content: png.toString("base64"),
        download_url: null,
      },
    });
    const output = await filesBatchTool.handler(
      { repo: REPO, paths: ["long.txt", "logo.png"], ref: "main", max_bytes: 4 },
      ctxFor(client),
    );
    const items = output.results as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({
      path: "long.txt",
      ok: true,
      data: { path: "long.txt", sha: "sha1", size: 10, encoding: "utf-8", content: "aaaa", binary: false, truncated: true, total_lines: 3 },
    });
    expect(items[1]).toEqual({
      path: "logo.png",
      ok: true,
      data: { path: "logo.png", sha: "sha2", size: 7, encoding: null, content: null, binary: true, truncated: false, total_lines: null },
    });
  });

  it("anchors every path to the pinned sha and reports pinned_sha", async () => {
    //? Review focus: each contents request URL must carry the pinned SHA, not
    //* the branch the pin was created from; the sha also short-circuits the
    //* default-branch lookup, so one path costs exactly one upstream call.
    const client = clientForRoutes({ "a.txt": contents("a.txt", "alpha\n") });
    setPinnedRef(REPO, "main", "abc123def456");
    const output = await filesBatchTool.handler({ repo: REPO, paths: ["a.txt"] }, ctxFor(client));
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(client.api).toHaveBeenCalledWith(`/repos/${REPO}/contents/a.txt?ref=abc123def456`, {
      fresh: undefined,
      cacheTtlMs: 300_000,
    });
    const items = output.results as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ ok: true });
    expect(output.pinned_sha).toBe("abc123def456");
    expect(output.meta).toEqual({ cache: "miss", quota: { resource: "core", remaining: 12 }, calls: 1 });
  });

  it("lets an explicit ref win over the pin and omits pinned_sha", async () => {
    const client = clientForRoutes({ "a.txt": contents("a.txt", "alpha\n") });
    setPinnedRef(REPO, "main", "abc123def456");
    const output = await filesBatchTool.handler(
      { repo: REPO, paths: ["a.txt"], ref: "main" },
      ctxFor(client),
    );
    expect(client.api).toHaveBeenCalledWith(`/repos/${REPO}/contents/a.txt?ref=main`, {
      fresh: undefined,
      cacheTtlMs: 300_000,
    });
    expect("pinned_sha" in output).toBe(false);
    expect(output.meta).toMatchObject({ calls: 1 });
  });
});
