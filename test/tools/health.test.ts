import { describe, expect, it, vi } from "vitest";
import { GithubError } from "../../src/core/errors.js";
import type { GitHubApi } from "../../src/core/github.js";
import { DEFAULT_HEALTH_LABELS, healthTool, windowStartDate } from "../../src/tools/health.js";
import { makeConfig } from "../helpers.js";

//? Field names are the raw REST /repos names (stargazers_count, forks_count,
//? open_issues_count) so the fixture catches any drift back to output-shaped
//? keys; the output assertions below pin the mapped stars/forks values.
const repoPayload = {
  stargazers_count: 223356, forks_count: 29975, open_issues_count: 3813, has_issues: true, has_discussions: false,
  license: { spdx_id: "MIT" }, default_branch: "main",
  pushed_at: "2026-10-31T02:59:27Z", created_at: "2021-01-01T00:00:00Z",
};

function healthClient() {
  return {
    api: vi.fn(async (url: string) => {
      if (url === "/repos/o/r") {
        return { data: repoPayload, headers: new Headers(), status: 200, contentType: "application/json" };
      }
      if (url === "/repos/o/r/releases/latest") {
        return {
          data: { tag_name: "v2.2.5", published_at: "2026-10-30T23:17:23Z", prerelease: false },
          headers: new Headers(), status: 200, contentType: "application/json",
        };
      }
      if (url.startsWith("/search/issues?")) {
        const q = decodeURIComponent(new URL(`https://x${url}`).searchParams.get("q") ?? "");
        //? Each label gets a DISTINCT value so the assertion pins the label-to-slot
        //? mapping, not just the sum; 4102/1477 mirror the live numbers that exposed
        //? the created-in-window vs opened-in-window mismatch.
        const total = q.includes("state:closed") ? 6135
          : q.includes("is:pr") ? 500
          : q.includes(`label:"bug"`) ? 23
          : q.includes(`label:"regression"`) ? 22
          : q.includes(`label:"data-loss"`) ? 21
          : q.includes(`label:"reproduced"`) ? 20
          : q.includes("created:>") && q.includes("state:open") ? 1477
          : q.includes("created:>") ? 4102
          : 2441;
        return { data: { total_count: total }, headers: new Headers(), status: 200, contentType: "application/json" };
      }
      throw new Error(`unexpected url ${url}`);
    }),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  };
}

describe("windowStartDate", () => {
  it("subtracts whole days and formats UTC", () => {
    expect(windowStartDate(new Date("2026-10-31T12:00:00Z"), 30)).toBe("2026-10-01");
    expect(windowStartDate(new Date("2026-03-01T00:00:00Z"), 1)).toBe("2026-02-28");
  });
});

describe("github_repo_health", () => {
  it("assembles the snapshot with default labels", async () => {
    const client = healthClient();
    //? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
    //? mock literal is asserted to GitHubApi at the handler boundary only; the
    //? call-list assertions below inspect the same untyped mock.
    const output = await healthTool.handler(
      { repo: "o/r" },
      { client: client as unknown as GitHubApi, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/repos/o/r", { fresh: undefined, cacheTtlMs: 600_000 });
    const calls = client.api.mock.calls.map((call) => call[0] as string);
    expect(calls).toContain(`/search/issues?q=${encodeURIComponent("repo:o/r is:issue state:open")}&per_page=1`);
    expect(calls).toContain(`/search/issues?q=${encodeURIComponent("repo:o/r is:pr state:open")}&per_page=1`);
    //? opened_total has NO state filter: created in the window, any current state.
    expect(calls).toContain(`/search/issues?q=${encodeURIComponent(`repo:o/r is:issue created:>${windowStartDate(new Date(), 30)}`)}&per_page=1`);
    //? opened_still_open keeps the state:open filter on top of the created window.
    expect(calls).toContain(`/search/issues?q=${encodeURIComponent(`repo:o/r is:issue state:open created:>${windowStartDate(new Date(), 30)}`)}&per_page=1`);
    expect(calls).toContain(`/search/issues?q=${encodeURIComponent(`repo:o/r is:issue state:closed closed:>${windowStartDate(new Date(), 30)}`)}&per_page=1`);
    for (const label of DEFAULT_HEALTH_LABELS) {
      expect(calls).toContain(`/search/issues?q=${encodeURIComponent(`repo:o/r is:issue state:open label:"${label}"`)}&per_page=1`);
    }
    expect(output).toMatchObject({
      repo: "o/r", window_days: 30, stars: 223356, forks: 29975,
      has_issues: true, has_discussions: false,
      open_issues: 2441, open_prs: 500, open_issues_and_prs: 3813,
      license: "MIT", default_branch: "main",
      search_unavailable: false,
      window: {
        opened_total: 4102, opened_still_open: 1477, closed: 6135,
        labels: { bug: 23, regression: 22, "data-loss": 21, reproduced: 20 },
      },
      latest_release: { tag_name: "v2.2.5", published_at: "2026-10-30T23:17:23Z", prerelease: false },
    });
    expect(output).toHaveProperty("generated_at");
  });

  it("degrades search-backed fields to null when search rejects the repo", async () => {
    const client = {
      api: vi.fn(async (url: string) => {
        if (url === "/repos/o/r") {
          return { data: repoPayload, headers: new Headers(), status: 200, contentType: "application/json" };
        }
        if (url === "/repos/o/r/releases/latest") {
          return {
            data: { tag_name: "v2.2.5", published_at: "2026-10-30T23:17:23Z", prerelease: false },
            headers: new Headers(), status: 200, contentType: "application/json",
          };
        }
        //? GitHub answers 422 invalid_params for legitimately existing repos whose
        //? search is restricted (e.g. block/goose); the mock throws the REAL
        //? GithubError because the handler matches by instanceof.
        throw new GithubError("invalid_params", "Validation Failed");
      }),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    };
    const output = await healthTool.handler(
      { repo: "o/r" },
      { client: client as unknown as GitHubApi, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      search_unavailable: true,
      stars: 223356,
      has_issues: true,
      open_issues: null,
      open_prs: null,
      window: {
        opened_total: null, opened_still_open: null, closed: null,
        labels: { bug: null, regression: null, "data-loss": null, reproduced: null },
      },
      latest_release: { tag_name: "v2.2.5", published_at: "2026-10-30T23:17:23Z", prerelease: false },
    });
  });

  it("honors label overrides and a missing latest release", async () => {
    const client = {
      api: vi.fn(async (url: string) => {
        if (url === "/repos/o/r") {
          return { data: repoPayload, headers: new Headers(), status: 200, contentType: "application/json" };
        }
        if (url.startsWith("/search/issues?")) {
          const q = decodeURIComponent(new URL(`https://x${url}`).searchParams.get("q") ?? "");
          return { data: { total_count: q.includes(`label:"priority: P1"`) ? 12 : 0 }, headers: new Headers(), status: 200, contentType: "application/json" };
        }
        //? The client surfaces a 404 as GithubError("not_found"); the mock throws that
        //? real subclass because the handler matches by instanceof at the GithubClient
        //? boundary, so a plain Error wearing a code property would be rethrown.
        throw new GithubError("not_found", "Not Found");
      }),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    };
    //? Same boundary-only assertion to GitHubApi as above.
    const output = await healthTool.handler(
      { repo: "o/r", window_days: 7, labels: ["priority: P1"] },
      { client: client as unknown as GitHubApi, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      window_days: 7,
      window: { labels: { "priority: P1": 12 } },
      latest_release: null,
    });
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/releases/latest", { fresh: undefined, cacheTtlMs: 600_000 });
  });
});
