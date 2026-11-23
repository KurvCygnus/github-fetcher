import { z } from "zod";
import { BatchTimeoutError, mapWithConcurrency, withTimeout } from "../core/batch.js";
import type { ToolContext } from "../core/context.js";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { windowStartDate } from "./health.js";
import type { MetaSource, ResponseMeta } from "./meta.js";
import { scarcestMeta } from "./meta.js";
import { parseLastPage, parseNextPage } from "./pagination.js";
import { parseRepo } from "./util.js";

//? Only the fields this tool reads are typed; the REST payloads carry more.
interface RepoPayload {
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
}

interface Contributor {
  login: string;
  contributions: number;
}

interface WorkflowRunsPayload {
  total_count: number;
  workflow_runs: Array<{ conclusion: string | null }>;
}

interface RepoOutcome {
  item: Record<string, unknown>;
  results: MetaSource[];
  calls: number;
}

const MAX_REPOS = 5;
const CONCURRENCY = 2;
//* A cold-cache repo issues four to seven sequential GETs that can each spend
//* seconds in transit; 8 s expired before the first result on slow links, so a
//* 25-second window keeps the per-repo isolation without shedding healthy repos.
const PER_REPO_TIMEOUT_MS = 25_000;
const CONTRIB_PAGES = 3;
const CONTRIB_PER_PAGE = 100;
const CALL_TTL_MS = 120_000;
const COMMIT_PAGE_SIZE = 100;

//* Each repo owns one worker with its own counters. Its four to seven core GETs
//* run in sequence inside one 25-second timeout so a slow repo is isolated from
//* the rest of the batch while its abandoned request keeps no claim on the
//* returned results.
async function runRepo(
  ctx: ToolContext,
  repoSpec: string,
  windowStart: string,
  topN: number,
  fresh: boolean | undefined,
): Promise<RepoOutcome> {
  let attempts = 0;
  let calls = 0;
  const results: MetaSource[] = [];

  //? attempts is incremented before the request is issued, so an in-flight call
  //* abandoned at timeout still counts; calls counts only ApiResults returned.
  const call = async <T>(url: string) => {
    attempts += 1;
    const result = await ctx.client.api<T>(url, { fresh, cacheTtlMs: CALL_TTL_MS });
    calls += 1;
    results.push(result);
    return result;
  };

  const { owner, name } = parseRepo(repoSpec);
  const base = `/repos/${owner}/${name}`;
  const started = Date.now();

  const build = async (): Promise<Record<string, unknown>> => {
    const repo = await call<RepoPayload>(base);
    const pulls = await call<Array<unknown>>(`${base}/pulls?state=open&per_page=1`);
    const commits = await call<Array<unknown>>(`${base}/commits?since=${windowStart}&per_page=100`);
    const runs = await call<WorkflowRunsPayload>(`${base}/actions/runs?created=>=${windowStart}&per_page=100`);

    const lastPage = parseLastPage(pulls.headers);
    const openPrs = lastPage ?? pulls.data.length;
    const openIssues = Math.max(0, repo.data.open_issues_count - openPrs);

    const commitsTruncated =
      commits.data.length >= COMMIT_PAGE_SIZE || parseNextPage(commits.headers.get("link")) !== null;

    const conclusions: Record<string, number> = {};
    for (const run of runs.data.workflow_runs) {
      const key = run.conclusion ?? "pending";
      conclusions[key] = (conclusions[key] ?? 0) + 1;
    }
    const ciTruncated =
      parseNextPage(runs.headers.get("link")) !== null || runs.data.total_count > runs.data.workflow_runs.length;

    const all: Contributor[] = [];
    let contributorsTruncated = false;
    for (let page = 1; page <= CONTRIB_PAGES; page += 1) {
      const result = await call<Contributor[]>(`${base}/contributors?per_page=${CONTRIB_PER_PAGE}&page=${page}`);
      all.push(...result.data);
      const more = parseNextPage(result.headers.get("link")) !== null;
      //* A full third page with another link means the 3-page cap stopped the
      //* gather; the share below is over fetched contributions only.
      if (more && page === CONTRIB_PAGES) contributorsTruncated = true;
      if (!more) break;
    }
    const top = all.slice(0, topN).map((contributor) => ({
      login: contributor.login,
      contributions: contributor.contributions,
    }));
    const total = all.reduce((sum, contributor) => sum + contributor.contributions, 0);
    const topTotal = top.reduce((sum, contributor) => sum + contributor.contributions, 0);

    return {
      repo: repoSpec,
      ok: true,
      stars: repo.data.stargazers_count,
      forks: repo.data.forks_count,
      open_issues: openIssues,
      open_prs: openPrs,
      open_counts_exact: lastPage !== null,
      window: { commits: commits.data.length, commits_truncated: commitsTruncated },
      ci: { runs: runs.data.workflow_runs.length, conclusions, truncated: ciTruncated },
      contributors: {
        top,
        top_share: total === 0 ? null : topTotal / total,
        truncated: contributorsTruncated,
      },
      calls,
      attempts,
    };
  };

  try {
    const item = await withTimeout(build(), PER_REPO_TIMEOUT_MS, repoSpec);
    return { item: { ...item, elapsed_ms: Date.now() - started }, results, calls };
  } catch (error) {
    //* A timeout is a plain error item: BatchTimeoutError is never reconstructed
    //* as a GithubError, and a single failed repo leaves the others unaffected.
    if (error instanceof BatchTimeoutError || error instanceof GithubError) {
      return {
        item: {
          repo: repoSpec,
          ok: false,
          error: {
            code: error instanceof BatchTimeoutError ? "timeout" : error.code,
            message: error.message,
          },
          calls,
          attempts,
          elapsed_ms: Date.now() - started,
        },
        results: [],
        calls,
      };
    }
    throw error;
  }
}

export const batchActivityTool = defineTool({
  name: "github_batch_activity",
  title: "GitHub batch activity snapshot",
  description:
    "Windowed activity snapshot for up to 5 repositories in one call: stars, forks, open issues/PRs, recent commits, CI run conclusions, and top contributors with their share. Uses core endpoints only; search quota untouched. Each repository's four to seven core GETs run sequentially under a 25-second per-repo timeout: a timed-out repository reports ok:false while the others stay ok:true, and the abandoned request's result is discarded. Contributor gathering stops after 3 pages of 100. Returns {window_days, top_n, generated_at, items[repo item or error item], meta}.",
  inputSchema: {
    repos: z.array(z.string()).min(1).max(MAX_REPOS).describe("Repositories in owner/name form, at most 5"),
    window_days: z.number().int().min(1).max(90).optional().describe("Analysis window in days, 1-90, default 30"),
    top_n: z.number().int().min(1).max(20).optional().describe("Top contributors to project, 1-20, default 5"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const windowDays = input.window_days ?? 30;
    const topN = input.top_n ?? 5;
    const windowStart = windowStartDate(new Date(), windowDays);
    const outcomes = await mapWithConcurrency(
      input.repos,
      CONCURRENCY,
      (repo) => runRepo(ctx, repo, windowStart, topN, input.fresh),
    );
    //* Each item carries its own counters; the batch folds every successful
    //* repo's observations into one scarcest meta stamped with the total calls.
    const observations = outcomes.flatMap((outcome) => outcome.results);
    const totalCalls = outcomes.reduce((sum, outcome) => sum + outcome.calls, 0);
    //* Every repo can time out without a single completed ApiResult, leaving no
    //* observed cache state to report; miss is the only honest label while calls
    //* still counts the client invocations that were attempted.
    const meta: ResponseMeta = scarcestMeta(observations, totalCalls) ?? { cache: "miss", calls: totalCalls };
    return {
      window_days: windowDays,
      top_n: topN,
      generated_at: new Date().toISOString(),
      items: outcomes.map((outcome) => outcome.item),
      meta,
    };
  },
});
