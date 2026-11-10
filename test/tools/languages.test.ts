import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { languagesTool } from "../../src/tools/languages.js";
import { makeConfig } from "../helpers.js";

//? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
//! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
function clientWith(data: unknown) {
  return {
    api: vi.fn(async () => ({ data, headers: new Headers(), status: 200, contentType: "application/json" })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

describe("github_languages", () => {
  it("sorts language entries by bytes descending and sums total_bytes", async () => {
    const client = clientWith({ Rust: 300, TypeScript: 700 });
    const output = await languagesTool.handler(
      { repo: "octocat/hello-world" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/repos/octocat/hello-world/languages", {
      fresh: undefined,
      cacheTtlMs: 300_000,
    });
    const languages = output.languages as Record<string, number>;
    expect(Object.keys(languages)).toEqual(["TypeScript", "Rust"]);
    expect(languages["TypeScript"]).toBe(700);
    expect(languages["Rust"]).toBe(300);
    expect(output.total_bytes).toBe(1000);
  });

  it("forwards the fresh flag to bypass the cache", async () => {
    const client = clientWith({ TypeScript: 700 });
    await languagesTool.handler(
      { repo: "octocat/hello-world", fresh: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/repos/octocat/hello-world/languages", {
      fresh: true,
      cacheTtlMs: 300_000,
    });
  });

  it("rejects a repo outside owner/name form with invalid_params", async () => {
    const client = clientWith({});
    await expect(
      languagesTool.handler(
        { repo: "no-slash" },
        { client, config: makeConfig(), authFingerprint: "abc" },
      ),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});
