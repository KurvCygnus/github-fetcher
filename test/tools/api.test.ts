import { describe, expect, it, vi } from "vitest";
import type { RawApiResult } from "../../src/core/github.js";
import { apiGetTool } from "../../src/tools/api.js";
import { makeConfig } from "../helpers.js";

//? Direct handler calls bypass the MCP/CLI Zod parse that applies the schema
//? default, so the guard tests pass raw input the way an unchecked caller would.
function rawInput(input: Record<string, unknown>): Parameters<typeof apiGetTool.handler>[0] {
  return input as unknown as Parameters<typeof apiGetTool.handler>[0];
}

describe("github_api_get", () => {
  it("rejects escape-hatch calls without ihaveto", async () => {
    const client = { api: vi.fn(), apiRaw: vi.fn(), raw: vi.fn() };
    const ctx = { client, config: makeConfig(), authFingerprint: "abc" };
    await expect(apiGetTool.handler(rawInput({ path: "/repos/o/r" }), ctx)).rejects.toMatchObject({
      code: "invalid_params",
      message: "github_api_get is the last-resort escape hatch for endpoints no dedicated tool covers.",
      hint: "Call github_capabilities() first and use a dedicated tool when one exists. If it truly does not, pass ihaveto: true.",
    });
    await expect(apiGetTool.handler({ path: "/repos/o/r", ihaveto: false }, ctx)).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(client.apiRaw).not.toHaveBeenCalled();
    expect(client.api).not.toHaveBeenCalled();
  });

  it("allows an explicit ihaveto true", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ ok: true }));
    const client = {
      api: vi.fn(),
      apiRaw: vi.fn(async () => ({
        bytes: body,
        headers: new Headers({ "content-type": "application/json" }),
        status: 200,
        contentType: "application/json",
      })),
      raw: vi.fn(),
    };
    const ctx = { client, config: makeConfig(), authFingerprint: "abc" };
    const result = await apiGetTool.handler({ path: "/repos/o/r", ihaveto: true }, ctx);
    expect(result.status).toBe(200);
  });

  it("rejects the guard before path validation and before any client call", async () => {
    const client = { api: vi.fn(), apiRaw: vi.fn(), raw: vi.fn() };
    const ctx = { client, config: makeConfig(), authFingerprint: "abc" };
    await expect(apiGetTool.handler(rawInput({ path: "https://evil.test/x" }), ctx)).rejects.toMatchObject({
      code: "invalid_params",
      message: "github_api_get is the last-resort escape hatch for endpoints no dedicated tool covers.",
    });
    expect(client.apiRaw).not.toHaveBeenCalled();
    expect(client.api).not.toHaveBeenCalled();
    expect(client.raw).not.toHaveBeenCalled();
  });

  it("returns parsed JSON and forwards the query", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ ok: true }));
    const client = {
      api: vi.fn(),
      apiRaw: vi.fn(async () => ({
        bytes: body,
        headers: new Headers({ "content-type": "application/json; charset=utf-8" }),
        status: 200,
        contentType: "application/json; charset=utf-8",
      })),
      raw: vi.fn(),
    };
    const output = await apiGetTool.handler(
      { path: "/repos/o/r/readme", query: { ref: "main" }, ihaveto: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.apiRaw).toHaveBeenCalledWith("/repos/o/r/readme?ref=main", { fresh: undefined });
    expect(output).toEqual({
      status: 200,
      content_type: "application/json; charset=utf-8",
      body: { ok: true },
      truncated: false,
      pagination: { next: null, prev: null, first: null, last: null },
    });
  });

  it("rejects traversal, schemes, and graphql", async () => {
    const client = { api: vi.fn(), apiRaw: vi.fn(), raw: vi.fn() };
    const ctx = { client, config: makeConfig(), authFingerprint: "abc" };
    for (const path of ["https://evil.test/x", "/a/../b", "/a//b", "repos/o/r"]) {
      await expect(apiGetTool.handler({ path, ihaveto: true }, ctx)).rejects.toMatchObject({
        code: "invalid_params",
      });
    }
    await expect(apiGetTool.handler({ path: "/graphql", ihaveto: true }, ctx)).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("returns body null with a hint when JSON would be truncated", async () => {
    const big = JSON.stringify({ ok: true, padding: "x".repeat(200_000) });
    const client = {
      api: vi.fn(),
      apiRaw: vi.fn(async () => ({
        bytes: new TextEncoder().encode(big),
        headers: new Headers({ "content-type": "application/json" }),
        status: 200,
        contentType: "application/json",
      })),
      raw: vi.fn(),
    };
    const output = await apiGetTool.handler(
      { path: "/repos/o/r/releases", ihaveto: true },
      { client, config: makeConfig({ maxFileBytes: 1024 }), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      status: 200,
      content_type: "application/json",
      body: null,
      truncated: true,
      hint: "response exceeded GITHUB_MCP_MAX_FILE_BYTES; narrow the query (e.g. per_page) or raise the limit",
      pagination: { next: null, prev: null, first: null, last: null },
    });
  });

  it("adds pagination and meta to the truncated-JSON early return", async () => {
    const big = JSON.stringify({ ok: true, padding: "x".repeat(200_000) });
    const client = {
      api: vi.fn(),
      apiRaw: vi.fn(async (): Promise<RawApiResult> => ({
        bytes: new TextEncoder().encode(big),
        headers: new Headers({ "content-type": "application/json" }),
        status: 200,
        contentType: "application/json",
        cache: { state: "hit", ageSeconds: 12 },
      })),
      raw: vi.fn(),
    };
    const output = await apiGetTool.handler(
      { path: "/repos/o/r/releases", ihaveto: true },
      { client, config: makeConfig({ maxFileBytes: 1024 }), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      status: 200,
      content_type: "application/json",
      body: null,
      truncated: true,
      hint: "response exceeded GITHUB_MCP_MAX_FILE_BYTES; narrow the query (e.g. per_page) or raise the limit",
      pagination: { next: null, prev: null, first: null, last: null },
      meta: { cache: "hit", age_s: 12, calls: 1 },
    });
  });

  it("surfaces Link header rel URLs verbatim in pagination", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ ok: true }));
    const client = {
      api: vi.fn(),
      apiRaw: vi.fn(async (): Promise<RawApiResult> => ({
        bytes: body,
        headers: new Headers({
          "content-type": "application/json",
          link:
            '<https://api.github.com/repos/o/r/issues?page=2>; rel="next", ' +
            '<https://api.github.com/repos/o/r/issues?page=7>; rel="prev", ' +
            '<https://api.github.com/repos/o/r/issues?page=1>; rel="first", ' +
            '<https://api.github.com/repos/o/r/issues?page=9>; rel="last"',
        }),
        status: 200,
        contentType: "application/json",
      })),
      raw: vi.fn(),
    };
    const output = await apiGetTool.handler(
      { path: "/repos/o/r/issues", ihaveto: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      status: 200,
      content_type: "application/json",
      body: { ok: true },
      truncated: false,
      pagination: {
        next: "https://api.github.com/repos/o/r/issues?page=2",
        prev: "https://api.github.com/repos/o/r/issues?page=7",
        first: "https://api.github.com/repos/o/r/issues?page=1",
        last: "https://api.github.com/repos/o/r/issues?page=9",
      },
    });
  });

  it("returns clipped text for truncated non-JSON content", async () => {
    const client = {
      api: vi.fn(),
      apiRaw: vi.fn(async () => ({
        bytes: new TextEncoder().encode("y".repeat(2000)),
        headers: new Headers({ "content-type": "text/plain" }),
        status: 200,
        contentType: "text/plain",
      })),
      raw: vi.fn(),
    };
    const output = await apiGetTool.handler(
      { path: "/repos/o/r/readme", ihaveto: true },
      { client, config: makeConfig({ maxFileBytes: 128 }), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({ truncated: true, body: "y".repeat(128) });
  });

  function rawClient(body: string, contentType = "application/json") {
    return {
      api: vi.fn(),
      apiRaw: vi.fn(async () => ({
        bytes: new TextEncoder().encode(body),
        headers: new Headers({ "content-type": contentType }),
        status: 200,
        contentType,
      })),
      raw: vi.fn(),
    };
  }

  it("merges a path query string with scalar query values", async () => {
    const client = rawClient(JSON.stringify({ ok: true }));
    await apiGetTool.handler(
      { path: "/search/repositories?q=rust", query: { per_page: 5, fork: true }, ihaveto: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.apiRaw).toHaveBeenCalledWith("/search/repositories?q=rust&per_page=5&fork=true", { fresh: undefined });
  });

  it("lets explicit query entries override path pairs", async () => {
    const client = rawClient(JSON.stringify({ ok: true }));
    await apiGetTool.handler(
      { path: "/search/issues?q=is:pr", query: { q: "is:issue" }, ihaveto: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.apiRaw).toHaveBeenCalledWith("/search/issues?q=is%3Aissue", { fresh: undefined });
  });

  it("forwards a path query alone and allows an empty query part", async () => {
    const client = rawClient(JSON.stringify({ ok: true }));
    await apiGetTool.handler(
      { path: "/repos/o/r/issues?state=open", ihaveto: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.apiRaw).toHaveBeenCalledWith("/repos/o/r/issues?state=open", { fresh: undefined });
    await apiGetTool.handler(
      { path: "/repos/o/r/issues?", ihaveto: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.apiRaw).toHaveBeenLastCalledWith("/repos/o/r/issues", { fresh: undefined });
  });

  it("rejects a second query separator and GraphQL with a query", async () => {
    const client = rawClient(JSON.stringify({ ok: true }));
    const ctx = { client, config: makeConfig(), authFingerprint: "abc" };
    await expect(apiGetTool.handler({ path: "/a?b?c", ihaveto: true }, ctx)).rejects.toMatchObject({
      code: "invalid_params",
    });
    await expect(apiGetTool.handler({ path: "/graphql?x=1", ihaveto: true }, ctx)).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("projects the cache outcome into the envelope", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ ok: true }));
    const client = {
      api: vi.fn(),
      apiRaw: vi.fn(async (): Promise<RawApiResult> => ({
        bytes: body,
        headers: new Headers({ "content-type": "application/json" }),
        status: 200,
        contentType: "application/json",
        cache: { state: "hit", ageSeconds: 12 },
      })),
      raw: vi.fn(),
    };
    const output = await apiGetTool.handler(
      { path: "/repos/o/r/readme", ihaveto: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      status: 200,
      content_type: "application/json",
      body: { ok: true },
      truncated: false,
      pagination: { next: null, prev: null, first: null, last: null },
      meta: { cache: "hit", age_s: 12, calls: 1 },
    });
  });

  it("reports a miss without an age key", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ ok: true }));
    const client = {
      api: vi.fn(),
      apiRaw: vi.fn(async (): Promise<RawApiResult> => ({
        bytes: body,
        headers: new Headers({ "content-type": "application/json" }),
        status: 200,
        contentType: "application/json",
        cache: { state: "miss" },
      })),
      raw: vi.fn(),
    };
    const output = await apiGetTool.handler(
      { path: "/repos/o/r/readme", fresh: true, ihaveto: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({ meta: { cache: "miss" } });
    expect(output).not.toHaveProperty("cache");
    expect(output).not.toHaveProperty("cache_age_seconds");
    expect(output).not.toHaveProperty("meta.age_s");
    expect(client.apiRaw).toHaveBeenCalledWith(
      expect.any(String),
      { fresh: true },
    );
  });
});
