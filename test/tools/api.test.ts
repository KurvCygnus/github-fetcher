import { describe, expect, it, vi } from "vitest";
import { apiGetTool } from "../../src/tools/api.js";
import { makeConfig } from "../helpers.js";

describe("github_api_get", () => {
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
      { path: "/repos/o/r/readme", query: { ref: "main" } },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.apiRaw).toHaveBeenCalledWith("/repos/o/r/readme?ref=main");
    expect(output).toEqual({
      status: 200,
      content_type: "application/json; charset=utf-8",
      body: { ok: true },
      truncated: false,
    });
  });

  it("rejects traversal, schemes, and graphql", async () => {
    const client = { api: vi.fn(), apiRaw: vi.fn(), raw: vi.fn() };
    const ctx = { client, config: makeConfig(), authFingerprint: "abc" };
    for (const path of ["https://evil.test/x", "/a/../b", "/a//b", "repos/o/r"]) {
      await expect(apiGetTool.handler({ path }, ctx)).rejects.toMatchObject({
        code: "invalid_params",
      });
    }
    await expect(apiGetTool.handler({ path: "/graphql" }, ctx)).rejects.toMatchObject({
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
      { path: "/repos/o/r/releases" },
      { client, config: makeConfig({ maxFileBytes: 1024 }), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      status: 200,
      content_type: "application/json",
      body: null,
      truncated: true,
      hint: "response exceeded GITHUB_MCP_MAX_FILE_BYTES; narrow the query (e.g. per_page) or raise the limit",
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
      { path: "/repos/o/r/readme" },
      { client, config: makeConfig({ maxFileBytes: 128 }), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({ truncated: true, body: "y".repeat(128) });
  });
});
