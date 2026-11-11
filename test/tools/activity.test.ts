import { describe, expect, it, vi } from "vitest";
import { GithubError } from "../../src/core/errors.js";
import type { GitHubApi } from "../../src/core/github.js";
import { repoActivityTool } from "../../src/tools/activity.js";
import { makeConfig } from "../helpers.js";

//? Fixture dates are computed relative to "now" so they stay inside (or safely
//* outside) the handler's 30-day default window without pinning a clock: items
//* land at least a day away from the windowStart date on both sides.
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

interface PullFixture {
  state: "open" | "closed";
  created_at: string;
  closed_at: string | null;
  merged_at: string | null;
  user: { login: string } | null;
}

interface IssueFixture {
  created_at: string;
  closed_at: string | null;
  pull_request?: { url: string };
}

function isoAt(daysAgo: number, hour: number): string {
  const date = new Date(Date.now() - daysAgo * DAY_MS);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

//* A newest-first timestamp sequence: each next index steps one minute back, so
//* any in-window bulk size fits without ever crossing the window edge.
function minutesBack(steps: number): string {
  const days = Math.floor(steps / 1440);
  const remainder = steps % 1440;
  const date = new Date(Date.now() - days * DAY_MS);
  date.setUTCHours(Math.floor(remainder / 60), remainder % 60, 0, 0);
  return date.toISOString();
}

function openPull(created: string, login = "octocat"): PullFixture {
  return { state: "open", created_at: created, closed_at: null, merged_at: null, user: { login } };
}

function mergedPull(created: string, mergeHoursAfter: number, login = "octocat"): PullFixture {
  const mergedAt = new Date(Date.parse(created) + mergeHoursAfter * HOUR_MS).toISOString();
  return { state: "closed", created_at: created, closed_at: mergedAt, merged_at: mergedAt, user: { login } };
}

function closedPull(created: string, login = "octocat"): PullFixture {
  const closedAt = new Date(Date.parse(created) + 5 * HOUR_MS).toISOString();
  return { state: "closed", created_at: created, closed_at: closedAt, merged_at: null, user: { login } };
}

function bulkOpenPulls(count: number, firstStep: number): PullFixture[] {
  return Array.from({ length: count }, (_, index) => openPull(minutesBack(firstStep + index)));
}

function issue(created: string, closed: boolean): IssueFixture {
  return { created_at: created, closed_at: closed ? new Date(Date.parse(created) + DAY_MS).toISOString() : null };
}

function prInIssuesFeed(created: string): IssueFixture {
  return { created_at: created, closed_at: null, pull_request: { url: "https://api.github.com/repos/o/r/pulls/1" } };
}

function release(daysAgo: number): { published_at: string } {
  return { published_at: isoAt(daysAgo, 10) };
}

interface WeekFixture {
  a: number;
  d: number;
}

interface ContributorFixture {
  author: { login: string };
  weeks: Array<{ w: number; a: number; d: number; c: number }>;
}

//* 52 weeks oldest-first like the REST payload; `tail` fills the newest weeks and
//* everything before them stays zero unless tailFill says otherwise.
function contributor(tail: WeekFixture[], tailFill = 0): ContributorFixture {
  const zeroWeeks = Array.from({ length: 52 - tail.length }, (_, index) => ({ w: index, a: tailFill, d: 0, c: 0 }));
  const tailWeeks = tail.map((week, index) => ({ w: 52 - tail.length + index, a: week.a, d: week.d, c: 0 }));
  return { author: { login: "someone" }, weeks: [...zeroWeeks, ...tailWeeks] };
}

function participationAll(tail: number[]): { all: number[] } {
  return { all: [...Array(52 - tail.length).fill(0), ...tail] };
}

interface MockReply {
  data: unknown;
  status?: number;
}

//? Routes switch on pathname so each walk page can serve different content; the
//? page query param is parsed out and handed to the route. Any unrouted URL or
//? page fails the test loudly instead of silently returning a wrong-shaped page.
function clientWithRoutes(routes: Record<string, (page: number) => MockReply>) {
  return {
    api: vi.fn(async (url: string) => {
      const parsed = new URL(`https://api.github.com${url}`);
      const route = routes[parsed.pathname];
      if (route === undefined) throw new Error(`unexpected url ${url}`);
      const reply = route(Number(parsed.searchParams.get("page") ?? "1"));
      return {
        data: reply.data,
        headers: new Headers(),
        status: reply.status ?? 200,
        contentType: "application/json",
        cache: { state: "miss" },
      };
    }),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

function callsFor(client: GitHubApi, prefix: string): string[] {
  const api = (client as unknown as { api: { mock: { calls: Array<[string, unknown]> } } }).api;
  return api.mock.calls.map((call) => call[0]).filter((url) => url.startsWith(prefix));
}

describe("github_repo_activity", () => {
  it("walks three pulls pages until the window edge and assembles every section", async () => {
    const client = clientWithRoutes({
      "/repos/o/r/pulls": (page) => {
        if (page === 1) return { data: bulkOpenPulls(100, 0) };
        if (page === 2) return { data: bulkOpenPulls(100, 100) };
        //* Newest first: the two out-of-window items at the end stop the walk.
        return {
          data: [
            mergedPull(isoAt(2, 12), 3, "dependabot[bot]"),
            openPull(isoAt(3, 12)),
            closedPull(isoAt(28, 12)),
            openPull(isoAt(31, 12)),
            closedPull(isoAt(32, 12)),
          ],
        };
      },
      "/repos/o/r/issues": () => ({
        data: [prInIssuesFeed(isoAt(2, 12)), issue(isoAt(3, 12), false), issue(isoAt(5, 12), true), issue(isoAt(31, 12), false)],
      }),
      "/repos/o/r/releases": () => ({ data: [release(2), release(4), release(31)] }),
      "/repos/o/r/stats/participation": () => ({ data: participationAll([1, 2, 3, 4, 5]) }),
      "/repos/o/r/stats/contributors": () => ({
        data: [
          contributor([{ a: 5, d: 0 }]),
          //* Active only at week 10, far outside the last ceil(30/7)=5 weeks.
          {
            author: { login: "old-only" },
            weeks: Array.from({ length: 52 }, (_, index) => ({ w: index, a: index === 10 ? 9 : 0, d: 0, c: 0 })),
          },
          contributor([{ a: 0, d: 2 }]),
        ],
      }),
    });
    const output = await repoActivityTool.handler(
      { repo: "o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      repo: "o/r",
      window_days: 30,
      generated_at: expect.any(String),
      pulls: { opened: 203, merged: 1, closed: 1, bot_opened: 1 },
      median_merge_hours: 3,
      issues: { opened: 2, closed: 1 },
      commits: 15,
      active_contributors: 2,
      releases: 2,
      pulls_truncated: false,
      issues_truncated: false,
      releases_truncated: false,
      stats_unavailable: false,
      meta: { cache: "miss" },
    });
    //? The pull walk stopped inside page 3, so page 4 must never be requested.
    expect(callsFor(client, "/repos/o/r/pulls")).toHaveLength(3);
    expect(callsFor(client, "/repos/o/r/pulls").some((url) => url.includes("page=4"))).toBe(false);
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/pulls?state=all&sort=created&direction=desc&per_page=100&page=1", {
      fresh: undefined,
      cacheTtlMs: 120_000,
    });
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/releases?per_page=100&page=1", {
      fresh: undefined,
      cacheTtlMs: 120_000,
    });
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/stats/participation", { fresh: undefined, cacheTtlMs: 300_000 });
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/stats/contributors", { fresh: undefined, cacheTtlMs: 300_000 });
  });

  it("stops the pulls walk at the 10-page cap and reports pulls_truncated", async () => {
    const client = clientWithRoutes({
      "/repos/o/r/pulls": (page) => {
        if (page >= 1 && page <= 10) return { data: bulkOpenPulls(100, (page - 1) * 100) };
        throw new Error(`unexpected pulls page ${page}`);
      },
      "/repos/o/r/issues": () => ({ data: [] }),
      "/repos/o/r/releases": () => ({ data: [] }),
      "/repos/o/r/stats/participation": () => ({ data: participationAll([]) }),
      "/repos/o/r/stats/contributors": () => ({ data: [] }),
    });
    const output = await repoActivityTool.handler(
      { repo: "o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toEqual({
      repo: "o/r",
      window_days: 30,
      generated_at: expect.any(String),
      pulls: { opened: 1000, merged: 0, closed: 0, bot_opened: 0 },
      median_merge_hours: null,
      issues: { opened: 0, closed: 0 },
      commits: 0,
      active_contributors: 0,
      releases: 0,
      pulls_truncated: true,
      issues_truncated: false,
      releases_truncated: false,
      stats_unavailable: false,
      meta: { cache: "miss" },
    });
    expect(callsFor(client, "/repos/o/r/pulls")).toHaveLength(10);
  });

  it("retries a still-computing stats endpoint once and reports numbers once it answers", async () => {
    let participationCalls = 0;
    const client = clientWithRoutes({
      "/repos/o/r/pulls": () => ({ data: [openPull(isoAt(1, 12))] }),
      "/repos/o/r/issues": () => ({ data: [] }),
      "/repos/o/r/releases": () => ({ data: [] }),
      "/repos/o/r/stats/participation": () => {
        participationCalls += 1;
        return participationCalls === 1 ? { data: null, status: 202 } : { data: participationAll([9]) };
      },
      "/repos/o/r/stats/contributors": () => ({ data: [contributor([{ a: 1, d: 1 }])] }),
    });
    const output = await repoActivityTool.handler(
      { repo: "o/r", window_days: 7 },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({ window_days: 7, commits: 9, active_contributors: 1, stats_unavailable: false });
    expect(participationCalls).toBe(2);
  });

  it("degrades to null stats with stats_unavailable when both attempts answer 202", async () => {
    let participationCalls = 0;
    let contributorCalls = 0;
    const client = clientWithRoutes({
      "/repos/o/r/pulls": () => ({ data: [openPull(isoAt(1, 12))] }),
      "/repos/o/r/issues": () => ({ data: [] }),
      "/repos/o/r/releases": () => ({ data: [] }),
      "/repos/o/r/stats/participation": () => {
        participationCalls += 1;
        return { data: null, status: 202 };
      },
      "/repos/o/r/stats/contributors": () => {
        contributorCalls += 1;
        return { data: null, status: 202 };
      },
    });
    const output = await repoActivityTool.handler(
      { repo: "o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({ commits: null, active_contributors: null, stats_unavailable: true });
    //? Exactly one retry: a third attempt would mean the cap is wrong.
    expect(participationCalls).toBe(2);
    expect(contributorCalls).toBe(2);
  });

  it("degrades the same way when a real 202 arrives as an empty body the client cannot parse", async () => {
    let participationCalls = 0;
    let contributorCalls = 0;
    const client = clientWithRoutes({
      "/repos/o/r/pulls": () => ({ data: [openPull(isoAt(1, 12))] }),
      "/repos/o/r/issues": () => ({ data: [] }),
      "/repos/o/r/releases": () => ({ data: [] }),
      "/repos/o/r/stats/participation": () => {
        participationCalls += 1;
        throw new GithubError("upstream", "GitHub returned invalid JSON for /repos/o/r/stats/participation");
      },
      "/repos/o/r/stats/contributors": () => {
        contributorCalls += 1;
        throw new GithubError("upstream", "GitHub returned invalid JSON for /repos/o/r/stats/contributors");
      },
    });
    const output = await repoActivityTool.handler(
      { repo: "o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({ commits: null, active_contributors: null, stats_unavailable: true });
    expect(participationCalls).toBe(2);
    expect(contributorCalls).toBe(2);
  });

  it("counts [bot]-authored opened pulls and excludes lookalike logins", async () => {
    const client = clientWithRoutes({
      "/repos/o/r/pulls": () => ({
        data: [
          openPull(isoAt(1, 12), "human1"),
          openPull(isoAt(2, 12), "dependabot[bot]"),
          mergedPull(isoAt(4, 12), 2, "renovate[bot]"),
          closedPull(isoAt(6, 12), "human2"),
          openPull(isoAt(8, 12), "robotfan"),
        ],
      }),
      "/repos/o/r/issues": () => ({ data: [] }),
      "/repos/o/r/releases": () => ({ data: [] }),
      "/repos/o/r/stats/participation": () => ({ data: participationAll([]) }),
      "/repos/o/r/stats/contributors": () => ({ data: [] }),
    });
    const output = await repoActivityTool.handler(
      { repo: "o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      pulls: { opened: 5, merged: 1, closed: 1, bot_opened: 2 },
      median_merge_hours: 2,
      pulls_truncated: false,
    });
  });

  it("takes the middle merge duration of three merged pulls", async () => {
    const client = clientWithRoutes({
      "/repos/o/r/pulls": () => ({
        data: [
          openPull(isoAt(1, 12)),
          mergedPull(isoAt(2, 12), 10),
          mergedPull(isoAt(3, 12), 1),
          mergedPull(isoAt(5, 12), 3),
        ],
      }),
      "/repos/o/r/issues": () => ({ data: [] }),
      "/repos/o/r/releases": () => ({ data: [] }),
      "/repos/o/r/stats/participation": () => ({ data: participationAll([]) }),
      "/repos/o/r/stats/contributors": () => ({ data: [] }),
    });
    const output = await repoActivityTool.handler(
      { repo: "o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      pulls: { opened: 4, merged: 3, closed: 0 },
      median_merge_hours: 3,
    });
  });

  it("picks the lower middle duration for an even number of merged pulls", async () => {
    const client = clientWithRoutes({
      "/repos/o/r/pulls": () => ({
        data: [mergedPull(isoAt(2, 12), 1), mergedPull(isoAt(3, 12), 2), mergedPull(isoAt(4, 12), 9), mergedPull(isoAt(5, 12), 10)],
      }),
      "/repos/o/r/issues": () => ({ data: [] }),
      "/repos/o/r/releases": () => ({ data: [] }),
      "/repos/o/r/stats/participation": () => ({ data: participationAll([]) }),
      "/repos/o/r/stats/contributors": () => ({ data: [] }),
    });
    const output = await repoActivityTool.handler(
      { repo: "o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({ pulls: { opened: 4, merged: 4 }, median_merge_hours: 2 });
  });

  it("rejects a repo outside owner/name form with invalid_params", async () => {
    const client = clientWithRoutes({});
    await expect(
      repoActivityTool.handler({ repo: "no-slash" }, { client, config: makeConfig(), authFingerprint: "abc" }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});
