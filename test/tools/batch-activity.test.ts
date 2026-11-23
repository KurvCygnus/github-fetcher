import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/core/context.js";
import { GithubError } from "../../src/core/errors.js";
import { batchActivityTool } from "../../src/tools/batch-activity.js";
import { windowStartDate } from "../../src/tools/health.js";
import { makeConfig } from "../helpers.js";

interface Route {
  data: unknown;
  headers?: Headers;
  quota?: { resource: string; remaining: number };
}

//* The fake client routes by exact URL so the call sequence itself is pinned, and
//* carries a cache outcome so the envelope's meta can be asserted without a real cache.
function makeCtx(route: (url: string) => Route) {
  const api = vi.fn(async (url: string, _options?: { fresh?: boolean; cacheTtlMs?: number }) => {
    const response = route(url);
    return {
      data: response.data,
      headers: response.headers ?? new Headers(),
      status: 200,
      contentType: "application/json",
      cache: { state: "miss" as const },
      ...(response.quota !== undefined ? { quota: response.quota } : {}),
    };
  });
  const client = { api, apiRaw: vi.fn(), raw: vi.fn() } as unknown as ToolContext["client"];
  return { ctx: { client, config: makeConfig(), authFingerprint: "abc" }, api };
}

function routeBy(routes: Record<string, Route>): (url: string) => Route {
  return (url) => {
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected URL: ${url}`);
    return route;
  };
}

function urls(owner: string, name: string, start: string) {
  const base = `/repos/${owner}/${name}`;
  return {
    repo: base,
    pulls: `${base}/pulls?state=open&per_page=1`,
    commits: `${base}/commits?since=${start}&per_page=100`,
    runs: `${base}/actions/runs?created=>=${start}&per_page=100`,
    contributor: (page: number) => `${base}/contributors?per_page=100&page=${page}`,
  };
}

const repoData = { stargazers_count: 100, forks_count: 20, open_issues_count: 12 };
const commitsData = [{ sha: "a" }, { sha: "b" }, { sha: "c" }];
const runsData = {
  total_count: 4,
  workflow_runs: [
    { conclusion: "success" },
    { conclusion: "failure" },
    { conclusion: "success" },
    { conclusion: null },
  ],
};
const contributorsData = [
  { login: "a", contributions: 50 },
  { login: "b", contributions: 30 },
  { login: "c", contributions: 20 },
];

function itemsOf(result: Record<string, unknown>): Array<Record<string, unknown>> {
  return result.items as Array<Record<string, unknown>>;
}

describe("github_batch_activity", () => {
  it("issues the five core calls in order and returns the full item envelope", async () => {
    const start = windowStartDate(new Date(), 30);
    const u = urls("o", "r", start);
    const { ctx, api } = makeCtx(routeBy({
      [u.repo]: { data: repoData },
      [u.pulls]: {
        data: [{ number: 1 }],
        headers: new Headers({ link: '<https://api.github.com/repos/o/r/pulls?page=7>; rel="last"' }),
      },
      [u.commits]: { data: commitsData },
      [u.runs]: { data: runsData },
      [u.contributor(1)]: { data: contributorsData },
    }));

    const result = await batchActivityTool.handler({ repos: ["o/r"] }, ctx);

    expect(api.mock.calls.map((call) => call[0])).toEqual([
      u.repo, u.pulls, u.commits, u.runs, u.contributor(1),
    ]);
    expect(api.mock.calls.every((call) => call[1]?.fresh === undefined && call[1]?.cacheTtlMs === 120000)).toBe(true);
    expect(result).toMatchObject({
      window_days: 30,
      top_n: 5,
      items: [{
        repo: "o/r",
        ok: true,
        stars: 100,
        forks: 20,
        open_issues: 5,
        open_prs: 7,
        open_counts_exact: true,
        window: { commits: 3, commits_truncated: false },
        ci: { runs: 4, conclusions: { success: 2, failure: 1, pending: 1 }, truncated: false },
        contributors: {
          top: [
            { login: "a", contributions: 50 },
            { login: "b", contributions: 30 },
            { login: "c", contributions: 20 },
          ],
          top_share: 1,
          truncated: false,
        },
        calls: 5,
        attempts: 5,
      }],
      meta: { cache: "miss", calls: 5 },
    });
    expect(typeof result.generated_at).toBe("string");
    expect(typeof itemsOf(result)[0]!.elapsed_ms).toBe("number");
    expect(Object.keys(result).at(-1)).toBe("meta");
    expect(api.mock.calls.every((call) => call[0].startsWith("/repos/") && !call[0].includes("/search"))).toBe(true);
  });

  it("infers the PR count from one page when Link last is absent and clamps open_issues", async () => {
    const start = windowStartDate(new Date(), 30);
    const a = urls("o", "a", start);
    const b = urls("o", "b", start);
    const { ctx } = makeCtx(routeBy({
      [a.repo]: { data: { stargazers_count: 1, forks_count: 1, open_issues_count: 1 } },
      [a.pulls]: { data: [{ number: 1 }] },
      [a.commits]: { data: [] },
      [a.runs]: { data: { total_count: 0, workflow_runs: [] } },
      [a.contributor(1)]: { data: [] },
      [b.repo]: { data: { stargazers_count: 2, forks_count: 2, open_issues_count: 4 } },
      [b.pulls]: { data: [] },
      [b.commits]: { data: [] },
      [b.runs]: { data: { total_count: 0, workflow_runs: [] } },
      [b.contributor(1)]: { data: [] },
    }));

    const result = await batchActivityTool.handler({ repos: ["o/a", "o/b"] }, ctx);
    const items = itemsOf(result);

    expect(items[0]).toMatchObject({ open_prs: 1, open_issues: 0, open_counts_exact: false });
    expect(items[1]).toMatchObject({ open_prs: 0, open_issues: 4, open_counts_exact: false });
    expect(items[0]).toMatchObject({ contributors: { top_share: null } });
  });

  it("flags commit truncation from a full page or a next link", async () => {
    const start = windowStartDate(new Date(), 30);
    const a = urls("o", "a", start);
    const b = urls("o", "b", start);
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ sha: `sha${index}` }));
    const { ctx } = makeCtx(routeBy({
      [a.repo]: { data: repoData },
      [a.pulls]: { data: [] },
      [a.commits]: { data: fullPage },
      [a.runs]: { data: { total_count: 0, workflow_runs: [] } },
      [a.contributor(1)]: { data: [] },
      [b.repo]: { data: repoData },
      [b.pulls]: { data: [] },
      [b.commits]: {
        data: commitsData,
        headers: new Headers({ link: '<https://api.github.com/repos/o/b/commits?page=2>; rel="next"' }),
      },
      [b.runs]: { data: { total_count: 0, workflow_runs: [] } },
      [b.contributor(1)]: { data: [] },
    }));

    const result = await batchActivityTool.handler({ repos: ["o/a", "o/b"] }, ctx);
    const items = itemsOf(result);

    expect(items[0]).toMatchObject({ window: { commits: 100, commits_truncated: true } });
    expect(items[1]).toMatchObject({ window: { commits: 3, commits_truncated: true } });
  });

  it("builds the CI conclusion histogram and reports truncation", async () => {
    const start = windowStartDate(new Date(), 7);
    const u = urls("o", "r", start);
    const { ctx } = makeCtx(routeBy({
      [u.repo]: { data: repoData },
      [u.pulls]: { data: [] },
      [u.commits]: { data: [] },
      [u.runs]: {
        data: {
          total_count: 9,
          workflow_runs: [
            { conclusion: "success" },
            { conclusion: "cancelled" },
            { conclusion: null },
          ],
        },
        headers: new Headers({ link: '<https://api.github.com/repos/o/r/actions/runs?page=2>; rel="next"' }),
      },
      [u.contributor(1)]: { data: [] },
    }));

    const result = await batchActivityTool.handler(
      { repos: ["o/r"], window_days: 7 },
      ctx,
    );

    expect(result.window_days).toBe(7);
    expect(itemsOf(result)[0]).toMatchObject({
      ci: {
        runs: 3,
        conclusions: { success: 1, cancelled: 1, pending: 1 },
        truncated: true,
      },
    });
  });

  it("gathers at most three contributor pages and divides by the fetched total", async () => {
    const start = windowStartDate(new Date(), 30);
    const u = urls("o", "r", start);
    const more = new Headers({ link: '<https://api.github.com/repos/o/r/contributors?page=9>; rel="next"' });
    const { ctx, api } = makeCtx(routeBy({
      [u.repo]: { data: repoData },
      [u.pulls]: { data: [] },
      [u.commits]: { data: [] },
      [u.runs]: { data: { total_count: 0, workflow_runs: [] } },
      [u.contributor(1)]: { data: [{ login: "a", contributions: 60 }, { login: "b", contributions: 40 }], headers: more },
      [u.contributor(2)]: { data: [{ login: "c", contributions: 30 }], headers: more },
      [u.contributor(3)]: { data: [{ login: "d", contributions: 20 }], headers: more },
    }));

    const result = await batchActivityTool.handler({ repos: ["o/r"], top_n: 2 }, ctx);
    const item = itemsOf(result)[0]!;

    expect(result.top_n).toBe(2);
    expect(api.mock.calls.map((call) => call[0])).toContain(u.contributor(2));
    expect(api.mock.calls.map((call) => call[0])).toContain(u.contributor(3));
    expect(api.mock.calls.map((call) => call[0])).not.toContain(u.contributor(4));
    expect(item).toMatchObject({
      calls: 7,
      attempts: 7,
      contributors: {
        top: [{ login: "a", contributions: 60 }, { login: "b", contributions: 40 }],
        truncated: true,
      },
    });
    expect((item.contributors as { top_share: number }).top_share).toBeCloseTo(100 / 150);
    expect(result.meta).toEqual({ cache: "miss", calls: 7 });
  });

  it("keeps one repo's GithubError local to its error item", async () => {
    const start = windowStartDate(new Date(), 30);
    const bad = urls("o", "bad", start);
    const good = urls("o", "good", start);
    const api = vi.fn(async (url: string) => {
      if (url === bad.repo) throw new GithubError("not_found", "Not Found");
      return {
        data: url === good.repo ? repoData : url === good.pulls ? [] : url === good.commits ? [] : url === good.runs ? { total_count: 0, workflow_runs: [] } : [],
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
        cache: { state: "miss" as const },
      };
    });
    const client = { api, apiRaw: vi.fn(), raw: vi.fn() } as unknown as ToolContext["client"];
    const ctx: ToolContext = { client, config: makeConfig(), authFingerprint: "abc" };

    const result = await batchActivityTool.handler({ repos: ["o/bad", "o/good"] }, ctx);
    const items = itemsOf(result);

    expect(items[0]).toMatchObject({
      repo: "o/bad",
      ok: false,
      error: { code: "not_found", message: "Not Found" },
      calls: 0,
      attempts: 1,
    });
    expect(typeof items[0]!.elapsed_ms).toBe("number");
    expect(items[1]).toMatchObject({ repo: "o/good", ok: true, calls: 5, attempts: 5 });
    expect(result.meta).toEqual({ cache: "miss", calls: 5 });
  });

  it("turns a per-repo timeout into a plain timeout error while other repos succeed", async () => {
    const start = windowStartDate(new Date(), 30);
    const slow = urls("o", "slow", start);
    const fast = urls("o", "fast", start);
    const api = vi.fn(async (url: string) => {
      if (url === slow.repo) return new Promise<never>(() => {});
      return {
        data: url === fast.repo ? repoData : url === fast.pulls ? [] : url === fast.commits ? [] : url === fast.runs ? { total_count: 0, workflow_runs: [] } : [],
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
        cache: { state: "miss" as const },
      };
    });
    const client = { api, apiRaw: vi.fn(), raw: vi.fn() } as unknown as ToolContext["client"];
    const ctx: ToolContext = { client, config: makeConfig(), authFingerprint: "abc" };

    vi.useFakeTimers();
    try {
      const pending = batchActivityTool.handler({ repos: ["o/slow", "o/fast"] }, ctx);
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25_000);
      const result = await pending;
      const items = itemsOf(result);

      expect(items[0]).toMatchObject({
        repo: "o/slow",
        ok: false,
        error: { code: "timeout", message: expect.stringContaining("Timed out after 25000ms") },
        calls: 0,
        attempts: 1,
      });
      expect(items[1]).toMatchObject({ repo: "o/fast", ok: true, calls: 5, attempts: 5 });
      expect(result.meta).toEqual({ cache: "miss", calls: 5 });
      expect(api.mock.calls.some((call) => call[0] === slow.pulls)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits a trailing miss meta when every repo times out", async () => {
    const api = vi.fn(async (_url: string) => new Promise<never>(() => {}));
    const client = { api, apiRaw: vi.fn(), raw: vi.fn() } as unknown as ToolContext["client"];
    const ctx: ToolContext = { client, config: makeConfig(), authFingerprint: "abc" };

    vi.useFakeTimers();
    try {
      const pending = batchActivityTool.handler({ repos: ["o/a", "o/b"] }, ctx);
      for (let index = 0; index < 24; index += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25_000);
      const result = await pending;

      expect(itemsOf(result).map((item) => item.error)).toEqual([
        { code: "timeout", message: expect.stringContaining("Timed out after 25000ms") },
        { code: "timeout", message: expect.stringContaining("Timed out after 25000ms") },
      ]);
      expect(result.meta).toEqual({ cache: "miss", calls: 0 });
      expect(Object.keys(result)).toEqual(["window_days", "top_n", "generated_at", "items", "meta"]);
      expect(Object.keys(result).at(-1)).toBe("meta");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sums item calls into meta.calls across repos", async () => {
    const start = windowStartDate(new Date(), 30);
    const a = urls("o", "a", start);
    const b = urls("o", "b", start);
    const more = new Headers({ link: '<https://api.github.com/repos/o/b/contributors?page=9>; rel="next"' });
    const { ctx } = makeCtx(routeBy({
      [a.repo]: { data: repoData, quota: { resource: "core", remaining: 50 } },
      [a.pulls]: { data: [] },
      [a.commits]: { data: [] },
      [a.runs]: { data: { total_count: 0, workflow_runs: [] } },
      [a.contributor(1)]: { data: [] },
      [b.repo]: { data: repoData, quota: { resource: "core", remaining: 3 } },
      [b.pulls]: { data: [] },
      [b.commits]: { data: [] },
      [b.runs]: { data: { total_count: 0, workflow_runs: [] } },
      [b.contributor(1)]: { data: [{ login: "a", contributions: 1 }], headers: more },
      [b.contributor(2)]: { data: [{ login: "b", contributions: 1 }], headers: more },
      [b.contributor(3)]: { data: [{ login: "c", contributions: 1 }], headers: more },
    }));

    const result = await batchActivityTool.handler({ repos: ["o/a", "o/b"] }, ctx);

    expect(itemsOf(result).map((item) => item.calls)).toEqual([5, 7]);
    expect(result.meta).toEqual({ cache: "miss", quota: { resource: "core", remaining: 3 }, calls: 12 });
    expect(Object.keys(result).at(-1)).toBe("meta");
  });

  it("bounds repos, window_days, and top_n in the input schema", () => {
    const shape = batchActivityTool.inputSchema as Record<string, z.ZodType>;

    expect(shape.repos!.safeParse(["a/b", "c/d", "e/f", "g/h", "i/j"]).success).toBe(true);
    expect(shape.repos!.safeParse(["a/b", "c/d", "e/f", "g/h", "i/j", "k/l"]).success).toBe(false);
    expect(shape.window_days!.safeParse(1).success).toBe(true);
    expect(shape.window_days!.safeParse(90).success).toBe(true);
    expect(shape.window_days!.safeParse(91).success).toBe(false);
    expect(shape.top_n!.safeParse(1).success).toBe(true);
    expect(shape.top_n!.safeParse(20).success).toBe(true);
    expect(shape.top_n!.safeParse(21).success).toBe(false);
  });
});
