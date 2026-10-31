import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/github.js";
import { releaseTool } from "../../src/tools/releases.js";
import { makeConfig } from "../helpers.js";

describe("github_release", () => {
  it("maps the latest release and assets", async () => {
    const client = {
      api: vi.fn(async () => ({
        data: {
          tag_name: "v1.0.0",
          name: "1.0.0",
          body: "notes",
          prerelease: false,
          draft: false,
          published_at: "2024-01-01T00:00:00Z",
          html_url: "https://github.com/o/r/releases/tag/v1.0.0",
          assets: [{ name: "a.zip", size: 10, download_count: 2, browser_download_url: "https://example.com/a.zip" }],
        },
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    };
    //? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
    //! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
    const api = client as unknown as GitHubApi;
    const output = await releaseTool.handler(
      { repo: "o/r" },
      { client: api, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/releases/latest", {
      fresh: undefined,
      cacheTtlMs: 600_000,
    });
    expect(output).toEqual({
      tag_name: "v1.0.0",
      name: "1.0.0",
      body: "notes",
      prerelease: false,
      draft: false,
      published_at: "2024-01-01T00:00:00Z",
      html_url: "https://github.com/o/r/releases/tag/v1.0.0",
      assets: [{ name: "a.zip", size: 10, download_count: 2, browser_download_url: "https://example.com/a.zip" }],
    });
  });
});
