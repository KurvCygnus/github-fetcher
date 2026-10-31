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
});
