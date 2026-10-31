import { describe, expect, it, vi } from "vitest";
import { GithubError } from "../../src/core/errors.js";
import type { GitHubApi } from "../../src/core/github.js";
import { releaseTool, releasesTool } from "../../src/tools/releases.js";
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

const releasesFixture = [
  { tag_name: "v2.2.5", name: "2.2.5", prerelease: false, draft: false, published_at: "2026-10-30T23:17:23Z", html_url: "https://github.com/o/r/releases/tag/v2.2.5" },
  { tag_name: "v1.19.5", name: "1.19.5", prerelease: false, draft: false, published_at: "2026-10-28T06:17:49Z", html_url: "https://github.com/o/r/releases/tag/v1.19.5" },
  { tag_name: "v2.3.0-rc.1", name: "rc", prerelease: true, draft: false, published_at: "2026-10-29T00:00:00Z", html_url: "https://github.com/o/r/releases/tag/v2.3.0-rc.1" },
];

function releasesClient() {
  return {
    api: vi.fn(async () => ({
      data: releasesFixture,
      headers: new Headers(),
      status: 200,
      contentType: "application/json",
    })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  };
}

describe("github_releases", () => {
  it("lists lean release items and forwards pagination", async () => {
    const client = releasesClient();
    //? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
    //! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
    const output = await releasesTool.handler(
      { repo: "o/r", per_page: 3 },
      { client: client as unknown as GitHubApi, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/releases?page=1&per_page=3", {
      fresh: undefined,
      cacheTtlMs: 600_000,
    });
    //? Handler output is Record<string, unknown>, so indexing output.items cannot
    //? typecheck; the whole envelope is asserted instead with the same values,
    //? which also pins page/per_page/has_more/next_page byte for byte.
    expect(output).toEqual({
      items: [
        { tag_name: "v2.2.5", name: "2.2.5", prerelease: false, draft: false, published_at: "2026-10-30T23:17:23Z", html_url: "https://github.com/o/r/releases/tag/v2.2.5" },
        { tag_name: "v1.19.5", name: "1.19.5", prerelease: false, draft: false, published_at: "2026-10-28T06:17:49Z", html_url: "https://github.com/o/r/releases/tag/v1.19.5" },
        { tag_name: "v2.3.0-rc.1", name: "rc", prerelease: true, draft: false, published_at: "2026-10-29T00:00:00Z", html_url: "https://github.com/o/r/releases/tag/v2.3.0-rc.1" },
      ],
      page: 1,
      per_page: 3,
      has_more: false,
      next_page: null,
    });
  });

  it("filters prereleases and drafts when include_prereleases is false", async () => {
    const client = releasesClient();
    const output = await releasesTool.handler(
      { repo: "o/r", include_prereleases: false },
      { client: client as unknown as GitHubApi, config: makeConfig(), authFingerprint: "abc" },
    );
    //? Same accommodation: the tag_name order the brief asserts is pinned through
    //? the whole envelope, so no unknown-typed access to output.items is needed.
    expect(output).toEqual({
      items: [
        { tag_name: "v2.2.5", name: "2.2.5", prerelease: false, draft: false, published_at: "2026-10-30T23:17:23Z", html_url: "https://github.com/o/r/releases/tag/v2.2.5" },
        { tag_name: "v1.19.5", name: "1.19.5", prerelease: false, draft: false, published_at: "2026-10-28T06:17:49Z", html_url: "https://github.com/o/r/releases/tag/v1.19.5" },
      ],
      page: 1,
      per_page: 20,
      has_more: false,
      next_page: null,
    });
  });
});
