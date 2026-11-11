import { z } from "zod";
import type { ApiResult } from "../core/github.js";
import type { ToolContext } from "../core/context.js";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { windowStartDate } from "./health.js";
import type { MetaSource } from "./meta.js";
import { scarcestMeta } from "./meta.js";
import { safeCount } from "./safe-count.js";
import { parseRepo } from "./util.js";

//? Only the fields this tool reads are typed; the REST payload carries more.
interface RepoPayload {
  stargazers_count: number;
  has_issues: boolean;
  has_discussions: boolean;
}

interface LatestRelease {
  tag_name: string;
  published_at: string | null;
  prerelease: boolean;
}

//* Three searches per repo: open issues, open PRs, and issues closed inside the
//* window. Search quota is 30 requests/minute, so repos are serialized with a
//* delay that keeps a 20-repo batch near 10 repos/minute.
const REPO_DELAY_MS = 6000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

//? One repo's outcome: the projected item plus the client results that produced
//* it, so the handler can fold every repo's observations into one scarcest meta.
interface CompareOneOutcome {
  item: Record<string, unknown>;
  results: MetaSource[];
}

async function compareOne(
  ctx: ToolContext,
  repoSpec: string,
  windowStart: string,
  fresh: boolean | undefined,
): Promise<CompareOneOutcome> {
  try {
    const { owner, name } = parseRepo(repoSpec);
    const repo = `${owner}/${name}`;
    const [payload, openIssuesS, openPrsS, closedS] = await Promise.all([
      ctx.client.api<RepoPayload>(`/repos/${owner}/${name}`, { fresh, cacheTtlMs: 600_000 }),
      safeCount(ctx, `repo:${repo} is:issue state:open`, fresh),
      safeCount(ctx, `repo:${repo} is:pr state:open`, fresh),
      safeCount(ctx, `repo:${repo} is:issue state:closed closed:>${windowStart}`, fresh),
    ]);
    let latestRelease: LatestRelease | null = null;
    let releaseResult: ApiResult<LatestRelease> | undefined;
    try {
      const result = await ctx.client.api<LatestRelease>(
        `/repos/${owner}/${name}/releases/latest`,
        { fresh, cacheTtlMs: 600_000 },
      );
      releaseResult = result;
      latestRelease = {
        tag_name: result.data.tag_name,
        published_at: result.data.published_at,
        prerelease: result.data.prerelease,
      };
    } catch (error) {
      //* Repositories without any release answer 404; that is an expected outcome,
      //* so it becomes latest_release: null while every other error stays loud.
      if (!(error instanceof GithubError && error.code === "not_found")) throw error;
    }
    const item: Record<string, unknown> = {
      repo,
      stars: payload.data.stargazers_count,
      has_issues: payload.data.has_issues,
      has_discussions: payload.data.has_discussions,
      open_issues: openIssuesS.total,
      open_prs: openPrsS.total,
      search_unavailable: openIssuesS.total === null || openPrsS.total === null || closedS.total === null,
      window: { closed: closedS.total },
      latest_release: latestRelease,
    };
    return {
      item,
      results: [payload, openIssuesS.result, openPrsS.result, closedS.result, releaseResult],
    };
  } catch (error) {
    //* One bad repo must not kill the batch: a GithubError becomes an error item
    //* while anything unexpected propagates. The failed repo produced no complete
    //* result set, so it contributes no meta observations either.
    if (error instanceof GithubError) {
      return { item: { repo: repoSpec, error: { code: error.code, message: error.message } }, results: [] };
    }
    throw error;
  }
}

export const compareReposTool = defineTool({
  name: "github_compare_repos",
  title: "GitHub repository comparison",
  description:
    "Throttled multi-repo breadth comparison: stars, open issue/PR counts, window closed count, and latest release for up to 20 repositories in one call. About 5 upstream calls per repo, roughly 10 repos/minute (search quota). Label-level detail lives in github_repo_health. Returns {window_days, repos[{repo, stars, has_issues, has_discussions, open_issues, open_prs, search_unavailable, window, latest_release} or {repo, error}], elapsed_ms}.",
  inputSchema: {
    repos: z.array(z.string()).min(1).max(20).describe("Repositories in owner/name form"),
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
    const started = Date.now();
    const windowDays = input.window_days ?? 30;
    const windowStart = windowStartDate(new Date(), windowDays);
    const repos: Array<Record<string, unknown>> = [];
    const observations: MetaSource[] = [];
    //? entries() (not indexed access) because noUncheckedIndexedAccess types
    //? input.repos[index] as string | undefined.
    for (const [index, repo] of input.repos.entries()) {
      if (index > 0) await delay(REPO_DELAY_MS);
      const outcome = await compareOne(ctx, repo, windowStart, input.fresh);
      repos.push(outcome.item);
      observations.push(...outcome.results);
    }
    //? Multi-request tool: one scarcest meta for the whole batch, taken across
    //* every repo's request results (lowest remaining, tagged with its resource).
    const meta = scarcestMeta(observations);
    return {
      window_days: windowDays,
      repos,
      elapsed_ms: Date.now() - started,
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
