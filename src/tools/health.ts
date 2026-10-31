import { z } from "zod";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { parseRepo } from "./util.js";

//? Field names follow the raw REST /repos payload (stargazers_count, forks_count,
//? open_issues_count), not this tool's output names; the handler maps them to the
//? spec 4.2 output keys stars/forks/open_issues_and_prs below.
interface RepoPayload {
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  has_issues: boolean;
  has_discussions: boolean;
  license: { spdx_id: string | null } | null;
  default_branch: string;
  pushed_at: string;
  created_at: string;
}

interface SearchCount {
  total_count: number;
}

interface LatestRelease {
  tag_name: string;
  published_at: string | null;
  prerelease: boolean;
}

export const DEFAULT_HEALTH_LABELS = ["bug", "regression", "data-loss", "reproduced"];

export function windowStartDate(now: Date, windowDays: number): string {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export const healthTool = defineTool({
  name: "github_repo_health",
  title: "GitHub repository health",
  description:
    "One-call repository snapshot: stars, true open issue and PR counts, has_issues/has_discussions, window opened/closed counts and per-label open counts (search-backed), and the latest release. Window terms: opened_total = issues created inside the window (any current state); opened_still_open = the subset still open; closed = issues closed inside the window (any creation date). Costs about 10 upstream calls, 9 of them search (within the 30 requests/minute search quota).",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    window_days: z.number().int().min(1).max(365).optional().describe("Analysis window in days, default 30"),
    labels: z.array(z.string()).optional().describe(`Open-issue labels to count, default ${DEFAULT_HEALTH_LABELS.join("/")}`),
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
    const labels = input.labels ?? DEFAULT_HEALTH_LABELS;
    const windowStart = windowStartDate(new Date(), windowDays);
    const fresh = input.fresh;

    const count = async (query: string): Promise<number> => {
      const { data } = await ctx.client.api<SearchCount>(
        `/search/issues?q=${encodeURIComponent(query)}&per_page=1`,
        { fresh, cacheTtlMs: 60_000 },
      );
      return data.total_count;
    };

    //? GitHub search answers 422 invalid_params for legitimately existing repos
    //? whose search is restricted (e.g. block/goose); one such rejection must not
    //? kill the whole snapshot, so that one code degrades to null ("search
    //? unavailable"). Rate limits and network failures stay loud: only
    //? invalid_params is caught, everything else rethrows.
    const safeCount = async (query: string): Promise<number | null> => {
      try {
        return await count(query);
      } catch (error) {
        if (error instanceof GithubError && error.code === "invalid_params") return null;
        throw error;
      }
    };

    const [payload, openIssues, openPrs, openedTotal, openedStillOpen, closed, ...labelCounts] = await Promise.all([
      ctx.client.api<RepoPayload>(`/repos/${owner}/${name}`, { fresh, cacheTtlMs: 600_000 }),
      safeCount(`repo:${repo} is:issue state:open`),
      safeCount(`repo:${repo} is:pr state:open`),
      safeCount(`repo:${repo} is:issue created:>${windowStart}`),
      safeCount(`repo:${repo} is:issue state:open created:>${windowStart}`),
      safeCount(`repo:${repo} is:issue state:closed closed:>${windowStart}`),
      ...labels.map((label) => safeCount(`repo:${repo} is:issue state:open label:"${label}"`)),
    ]);

    //? Any of the 9 searches resolving null means part of the snapshot is unknown;
    //? the flag lets callers distinguish "zero" from "search did not answer".
    const searchUnavailable = [openIssues, openPrs, openedTotal, openedStillOpen, closed, ...labelCounts]
      .some((value) => value === null);

    let latestRelease: LatestRelease | null = null;
    try {
      const { data } = await ctx.client.api<LatestRelease>(
        `/repos/${owner}/${name}/releases/latest`,
        { fresh, cacheTtlMs: 600_000 },
      );
      latestRelease = { tag_name: data.tag_name, published_at: data.published_at, prerelease: data.prerelease };
    } catch (error) {
      //* Repositories without any release answer 404; that is an expected outcome,
      //* so it becomes latest_release: null. The catch sits after the GithubClient
      //* boundary, which always throws real GithubErrors (mapHttpError on 404), so
      //* instanceof is exact here; any other error keeps propagating untouched.
      if (!(error instanceof GithubError && error.code === "not_found")) throw error;
    }

    const windowLabels: Record<string, number | null> = {};
    labels.forEach((label, index) => {
      //? noUncheckedIndexedAccess makes labelCounts[index] number | null | undefined;
      //? labelCounts is the same labels list mapped over safeCount(), so the indices
      //? always align and the ?? null fallback only normalizes undefined to "unknown".
      windowLabels[label] = labelCounts[index] ?? null;
    });

    return {
      repo,
      window_days: windowDays,
      generated_at: new Date().toISOString(),
      stars: payload.data.stargazers_count,
      forks: payload.data.forks_count,
      license: payload.data.license?.spdx_id ?? null,
      default_branch: payload.data.default_branch,
      pushed_at: payload.data.pushed_at,
      created_at: payload.data.created_at,
      has_issues: payload.data.has_issues,
      has_discussions: payload.data.has_discussions,
      open_issues: openIssues,
      open_prs: openPrs,
      open_issues_and_prs: payload.data.open_issues_count,
      window: { opened_total: openedTotal, opened_still_open: openedStillOpen, closed, labels: windowLabels },
      search_unavailable: searchUnavailable,
      latest_release: latestRelease,
    };
  },
});
