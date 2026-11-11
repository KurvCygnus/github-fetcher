import { z } from "zod";
import type { ApiResult } from "../core/github.js";
import type { ToolContext } from "../core/context.js";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { windowStartDate } from "./health.js";
import type { MetaSource } from "./meta.js";
import { scarcestMeta } from "./meta.js";
import { githubQuery, parseRepo } from "./util.js";

//? Only the fields this tool reads are typed; the REST payloads carry more.
interface PullPayload {
  state: "open" | "closed";
  created_at: string;
  closed_at: string | null;
  merged_at: string | null;
  user: { login: string } | null;
}

interface IssuePayload {
  created_at: string;
  closed_at: string | null;
  //* The issues endpoint interleaves pull requests; their presence is the marker.
  pull_request?: unknown;
}

interface ReleasePayload {
  published_at: string | null;
}

interface ParticipationPayload {
  all: number[];
}

interface ContributorStatsPayload {
  author: { login: string } | null;
  weeks: Array<{ a: number; d: number }>;
}

//* Walk budgets: pulls and issues cap at 10 pages of 100, releases at 3; the caps
//* keep a hot repository from spending unbounded core quota on one call.
const WALK_PER_PAGE = 100;
const MAX_LIST_PAGES = 10;
const MAX_RELEASE_PAGES = 3;
const WALK_TTL_MS = 120_000;
const STATS_TTL_MS = 300_000;
const MS_PER_HOUR = 3_600_000;
const STATS_ATTEMPTS = 2;

interface WalkResult<T> {
  items: T[];
  truncated: boolean;
  //* Every page response the walk issued, kept for the handler's scarcest-meta
  //* report: the lowest remaining across pages is the honest worst case.
  results: MetaSource[];
}

//* Newest-first windowed walk: accumulate items while inWindow holds, stop at the
//* first older item (or when a short page runs out of items) and report
//* truncated: true only when the page cap — not the data — stopped the walk. The
//* keep predicate filters items that are in the window but not countable (the
//* issues feed interleaves pull requests).
async function walkNewestFirst<T>(
  ctx: ToolContext,
  base: string,
  params: Record<string, string | number>,
  windowStart: string,
  fresh: boolean | undefined,
  maxPages: number,
  inWindow: (item: T) => boolean,
  keep: (item: T) => boolean,
): Promise<WalkResult<T>> {
  const items: T[] = [];
  const results: MetaSource[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const query = githubQuery({ ...params, page });
    const result = await ctx.client.api<T[]>(`${base}${query}`, { fresh, cacheTtlMs: WALK_TTL_MS });
    results.push(result);
    const { data } = result;
    for (const item of data) {
      if (!inWindow(item)) {
        return { items, truncated: false, results };
      }
      if (keep(item)) items.push(item);
    }
    if (data.length < WALK_PER_PAGE) return { items, truncated: false, results };
  }
  return { items, truncated: true, results };
}

//* GitHub computes stats asynchronously: the first answer is 202 (still working).
//* Retry once immediately and report null data on a second failure instead of
//* making the caller wait or throwing — the flag carries the "unknown" meaning. A
//* real 202 answers an empty body, which fails JSON parsing inside the client and
//* surfaces as an upstream GithubError, so that counts as a failed attempt too.
//* The answering 200's client result travels beside the data for the scarcest
//* meta report; a failed stats fetch contributes no result, like any rejected
//* sub-request.
async function fetchStats<T>(
  ctx: ToolContext,
  path: string,
  fresh: boolean | undefined,
): Promise<{ data: T | null; result: ApiResult<T> | undefined }> {
  for (let attempt = 0; attempt < STATS_ATTEMPTS; attempt += 1) {
    try {
      const result = await ctx.client.api<T>(path, { fresh, cacheTtlMs: STATS_TTL_MS });
      if (result.status === 200) return { data: result.data, result };
    } catch (error) {
      if (!(error instanceof GithubError)) throw error;
    }
  }
  return { data: null, result: undefined };
}

//* Median of merged pulls' (merged_at - created_at) hours; sorted, and for an
//* even length the LOWER middle is taken so the value is always an observed one.
function medianMergeHours(pulls: PullPayload[]): number | null {
  const hours: number[] = [];
  for (const pull of pulls) {
    if (pull.merged_at === null) continue;
    hours.push((Date.parse(pull.merged_at) - Date.parse(pull.created_at)) / MS_PER_HOUR);
  }
  hours.sort((a, b) => a - b);
  if (hours.length === 0) return null;
  const middle = hours[Math.floor((hours.length - 1) / 2)];
  return middle === undefined ? null : middle;
}

export const repoActivityTool = defineTool({
  name: "github_repo_activity",
  title: "GitHub repository activity",
  description:
    "Answer how alive a repository has been over a window, from core endpoints only: pulls opened/merged/closed (closed counts PRs closed without merging) with bot-authored opens and the median hours from opening to merge, issues opened and closed, the window's commit total, active contributors, and the release count. Pulls and issues walk newest-first until the window edge (10-page cap), releases cap at 3 pages; a *_truncated flag reports a walk the cap stopped, and stats GitHub is still computing report null commits/contributors with stats_unavailable. Costs 4-12 core calls, none search. Returns {repo, window_days, generated_at, pulls, median_merge_hours, issues, commits, active_contributors, releases, pulls_truncated, issues_truncated, releases_truncated, stats_unavailable}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    window_days: z.number().int().min(1).max(365).optional().describe("Analysis window in days, 1-365, default 30"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const { owner, name } = parseRepo(input.repo);
    const repo = `${owner}/${name}`;
    const windowDays = input.window_days ?? 30;
    //? windowStart is a date (YYYY-MM-DD), so the >= comparisons are inclusive of
    //* the whole window-start day; ISO strings order correctly as plain strings.
    const windowStart = windowStartDate(new Date(), windowDays);
    const fresh = input.fresh;
    const weeks = Math.ceil(windowDays / 7);

    const [pulls, issues, releases, participationS, contributorStatsS] = await Promise.all([
      walkNewestFirst<PullPayload>(
        ctx,
        `/repos/${owner}/${name}/pulls`,
        { state: "all", sort: "created", direction: "desc", per_page: WALK_PER_PAGE },
        windowStart,
        fresh,
        MAX_LIST_PAGES,
        (pull) => pull.created_at >= windowStart,
        () => true,
      ),
      walkNewestFirst<IssuePayload>(
        ctx,
        `/repos/${owner}/${name}/issues`,
        { state: "all", sort: "created", direction: "desc", per_page: WALK_PER_PAGE },
        windowStart,
        fresh,
        MAX_LIST_PAGES,
        (item) => item.created_at >= windowStart,
        (item) => item.pull_request === undefined,
      ),
      walkNewestFirst<ReleasePayload>(
        ctx,
        `/repos/${owner}/${name}/releases`,
        { per_page: WALK_PER_PAGE },
        windowStart,
        fresh,
        MAX_RELEASE_PAGES,
        //* A null published_at (draft) cannot be placed in the window, so it ends
        //* the walk like an out-of-window item.
        (release) => release.published_at !== null && release.published_at >= windowStart,
        () => true,
      ),
      fetchStats<ParticipationPayload>(ctx, `/repos/${owner}/${name}/stats/participation`, fresh),
      fetchStats<ContributorStatsPayload[]>(ctx, `/repos/${owner}/${name}/stats/contributors`, fresh),
    ]);

    const merged = pulls.items.filter((pull) => pull.merged_at !== null).length;
    const closed = pulls.items.filter((pull) => pull.state === "closed" && pull.merged_at === null).length;
    const botOpened = pulls.items.filter((pull) => (pull.user?.login ?? "").endsWith("[bot]")).length;
    const issuesClosed = issues.items.filter((item) => item.closed_at !== null).length;
    const participation = participationS.data;
    const contributorStats = contributorStatsS.data;
    //* Participation's all array is oldest-first; the window is the last ceil(days/7)
    //* weekly buckets. Contributor activity is the same tail of additions+deletions.
    const commits = participation === null ? null : participation.all.slice(-weeks).reduce((sum, count) => sum + count, 0);
    const activeContributors = contributorStats === null
      ? null
      : contributorStats.filter(
          (entry) => entry.weeks.slice(-weeks).reduce((sum, week) => sum + week.a + week.d, 0) > 0,
        ).length;

    //? Multi-request tool: the envelope reports the scarcest observation across
    //* every walk page and the answering stats calls (lowest remaining, tagged
    //* with its resource), staying undefined when nothing produced a result.
    const meta = scarcestMeta([
      ...pulls.results,
      ...issues.results,
      ...releases.results,
      participationS.result,
      contributorStatsS.result,
    ]);

    return {
      repo,
      window_days: windowDays,
      generated_at: new Date().toISOString(),
      pulls: { opened: pulls.items.length, merged, closed, bot_opened: botOpened },
      median_merge_hours: medianMergeHours(pulls.items),
      issues: { opened: issues.items.length, closed: issuesClosed },
      commits,
      active_contributors: activeContributors,
      releases: releases.items.length,
      pulls_truncated: pulls.truncated,
      issues_truncated: issues.truncated,
      releases_truncated: releases.truncated,
      stats_unavailable: participation === null || contributorStats === null,
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
