import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/core/context.js";
import { GithubError } from "../../src/core/errors.js";
import { compareReposTool } from "../../src/tools/compare.js";
import { makeConfig } from "../helpers.js";

//? Field names are the raw REST /repos names so the fixture catches any drift
//? back to output-shaped keys; the assertions pin the mapped stars value.
const payload = {
  stargazers_count: 100, forks_count: 10, open_issues_count: 30,
  has_issues: true, has_discussions: false, license: { spdx_id: "MIT" },
  default_branch: "main", pushed_at: "2026-10-31T00:00:00Z", created_at: "2026-01-01T00:00:00Z",
};

function clientFor(repos: Record<string, unknown>, searchFailFor: string[] = []) {
  return {
    api: vi.fn(async (url: string) => {
      const match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url);
      if (match) {
        const key = `${match[1]}/${match[2]}`;
        if (!(key in repos)) throw new GithubError("not_found", "Not Found");
        return { data: repos[key], headers: new Headers(), status: 200, contentType: "application/json" };
      }
      if (url.includes("/releases/latest")) {
        return {
          data: { tag_name: "v1.0.0", published_at: "2026-10-01T00:00:00Z", prerelease: false },
          headers: new Headers(), status: 200, contentType: "application/json",
        };
      }
      if (url.startsWith("/search/issues?")) {
        const q = decodeURIComponent(new URL(`https://x${url}`).searchParams.get("q") ?? "");
        //? GitHub answers 422 invalid_params for legitimately existing repos whose
        //? search is restricted; the mock throws the REAL GithubError because
        //? safeCount matches by instanceof and code, never by shape.
        if (searchFailFor.some((repo) => q.includes(`repo:${repo} `))) {
          throw new GithubError("invalid_params", "Validation Failed");
        }
        if (q.includes("is:pr")) return { data: { total_count: 5 }, headers: new Headers(), status: 200, contentType: "application/json" };
        if (q.includes("state:closed")) return { data: { total_count: 40 }, headers: new Headers(), status: 200, contentType: "application/json" };
        return { data: { total_count: 25 }, headers: new Headers(), status: 200, contentType: "application/json" };
      }
      throw new Error(`unexpected url ${url}`);
    }),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  };
}

function ctxFor(client: ReturnType<typeof clientFor>): ToolContext {
  return { client: client as unknown as ToolContext["client"], config: makeConfig(), authFingerprint: "abc" };
}

describe("github_compare_repos", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("compares repos serially with throttled delays", async () => {
    const client = clientFor({ "o/a": payload, "o/b": payload });
    const promise = compareReposTool.handler({ repos: ["o/a", "o/b"] }, ctxFor(client));
    await vi.advanceTimersByTimeAsync(6000);
    const output = await promise;
    const searchCalls = client.api.mock.calls
      .filter((call) => String(call[0]).startsWith("/search/issues"));
    expect(searchCalls).toHaveLength(6);
    expect(output).toMatchObject({
      window_days: 30,
      repos: [
        { repo: "o/a", stars: 100, open_issues: 25, open_prs: 5, search_unavailable: false,
          window: { closed: 40 }, latest_release: { tag_name: "v1.0.0" } },
        { repo: "o/b", stars: 100, open_issues: 25, open_prs: 5, search_unavailable: false,
          window: { closed: 40 }, latest_release: { tag_name: "v1.0.0" } },
      ],
    });
    expect((output as { elapsed_ms: number }).elapsed_ms).toBeGreaterThanOrEqual(6000);
  });

  it("contains per-repo failures without killing the batch", async () => {
    const client = clientFor({ "o/a": payload, "block/goose": payload }, ["block/goose"]);
    const promise = compareReposTool.handler(
      { repos: ["o/a", "block/goose", "o/missing"] },
      ctxFor(client),
    );
    await vi.advanceTimersByTimeAsync(12000);
    const output = await promise;
    const items = (output as { repos: Array<Record<string, unknown>> }).repos;
    expect(items[0]).toMatchObject({ repo: "o/a", stars: 100 });
    expect(items[1]).toMatchObject({
      repo: "block/goose",
      stars: 100,
      has_issues: true,
      has_discussions: false,
      open_issues: null,
      open_prs: null,
      search_unavailable: true,
      window: { closed: null },
      latest_release: { tag_name: "v1.0.0", published_at: "2026-10-01T00:00:00Z", prerelease: false },
    });
    expect(items[2]).toMatchObject({ repo: "o/missing", error: { code: "not_found" } });
  });
});
