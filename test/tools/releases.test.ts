import { describe, expect, it, vi } from "vitest";
import { GithubError } from "../../src/core/errors.js";
import type { GitHubApi } from "../../src/core/github.js";
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
      found: true,
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

  it("returns found false instead of an error when no release exists", async () => {
    //? The client surfaces a 404 as GithubError("not_found"); the mock throws that
    //? real subclass because the handler matches by instanceof, so a plain Error
    //? wearing a code property would be rethrown instead of returning the shape.
    const client = {
      api: vi.fn(async () => {
        throw new GithubError("not_found", "Not Found");
      }),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    };
    const output = await releaseTool.handler(
      { repo: "o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      found: false,
      tag_name: null,
      name: null,
      body: null,
      prerelease: false,
      draft: false,
      published_at: null,
      html_url: null,
      assets: [],
    });
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/releases/latest", {
      fresh: undefined,
      cacheTtlMs: 600_000,
    });
  });
});
