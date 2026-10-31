import { z } from "zod";
import { defineTool } from "./define.js";
import { parseRepo } from "./util.js";

interface RepoPayload {
  stars: number;
  forks: number;
  open_issues: number;
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
    "One-call repository snapshot: stars, true open issue and PR counts, has_issues/has_discussions, window opened/closed and per-label open counts (search-backed), and the latest release. Costs about 10 upstream calls, 8 of them search (within the 30 requests/minute search quota).",
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

    const [payload, openIssues, openPrs, opened, closed, ...labelCounts] = await Promise.all([
      ctx.client.api<RepoPayload>(`/repos/${owner}/${name}`, { fresh, cacheTtlMs: 600_000 }),
      count(`repo:${repo} is:issue state:open`),
      count(`repo:${repo} is:pr state:open`),
      count(`repo:${repo} is:issue state:open created:>${windowStart}`),
      count(`repo:${repo} is:issue state:closed closed:>${windowStart}`),
      ...labels.map((label) => count(`repo:${repo} is:issue state:open label:"${label}"`)),
    ]);

    let latestRelease: LatestRelease | null = null;
    try {
      const { data } = await ctx.client.api<LatestRelease>(
        `/repos/${owner}/${name}/releases/latest`,
        { fresh, cacheTtlMs: 600_000 },
      );
      latestRelease = { tag_name: data.tag_name, published_at: data.published_at, prerelease: data.prerelease };
    } catch (error) {
      //? Duck-typed code check, not instanceof GithubError: the real client signals a
      //? missing release with GithubError code "not_found" (mapHttpError on 404) and
      //? the offline mock with a plain Error carrying the same code property, so
      //? matching on code covers both; any other code still propagates untouched.
      //? Optional chaining keeps a thrown null or string rethrown as itself instead
      //? of crashing on the property read.
      if ((error as { code?: unknown } | null | undefined)?.code !== "not_found") throw error;
    }

    const windowLabels: Record<string, number> = {};
    labels.forEach((label, index) => {
      //? noUncheckedIndexedAccess makes labelCounts[index] number | undefined;
      //? labelCounts is the same labels list mapped over count(), so the indices
      //? always align and the ?? 0 fallback never fires.
      windowLabels[label] = labelCounts[index] ?? 0;
    });

    return {
      repo,
      window_days: windowDays,
      generated_at: new Date().toISOString(),
      stars: payload.data.stars,
      forks: payload.data.forks,
      license: payload.data.license?.spdx_id ?? null,
      default_branch: payload.data.default_branch,
      pushed_at: payload.data.pushed_at,
      created_at: payload.data.created_at,
      has_issues: payload.data.has_issues,
      has_discussions: payload.data.has_discussions,
      open_issues: openIssues,
      open_prs: openPrs,
      open_issues_and_prs: payload.data.open_issues,
      window: { opened, closed, labels: windowLabels },
      latest_release: latestRelease,
    };
  },
});
