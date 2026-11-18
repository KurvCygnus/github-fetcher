import { z } from "zod";
import { defineTool } from "./define.js";
import { scarcestMeta } from "./meta.js";
import { LOGIN_PATTERN, gatherRepos, parseUser } from "./user.js";

//? Only the fields this tool reads are typed; the REST payload carries more.
interface UserPayload {
  name: string | null;
  type: string;
  public_repos: number;
}

//? The gathered element type is reached through the exported walk instead of a
//* second interface, so these metrics can never drift from user.ts's payload.
type GatheredRepo = Awaited<ReturnType<typeof gatherRepos>>["payloads"][number];

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_WINDOW_DAYS = 90;

//? fork_share rounds half up at two decimals; a zero total (no gathered repos)
//* guards the division instead of producing NaN.
function forkShare(originals: number, forks: number): number {
  const total = originals + forks;
  return total === 0 ? 0 : Math.round((forks / total) * 100) / 100;
}

interface TopRepoRow {
  full_name: string;
  stars: number;
  language: string | null;
  pushed_at: string | null;
}

//? Top five by stars descending; the copy keeps the in-place stable sort off the
//* caller's array and lets equal stars keep the order the gather saw.
function topRepoRows(repos: GatheredRepo[]): TopRepoRow[] {
  return [...repos]
    .sort((a, b) => b.stargazers_count - a.stargazers_count)
    .slice(0, 5)
    .map((repo) => ({
      full_name: repo.full_name,
      stars: repo.stargazers_count,
      language: repo.language,
      pushed_at: repo.pushed_at,
    }));
}

//? Language distribution over each repository's language field; null is skipped,
//* and equal counts keep first-seen gather order via the stable entry sort.
function languageCounts(repos: GatheredRepo[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const repo of repos) {
    if (repo.language === null) continue;
    counts.set(repo.language, (counts.get(repo.language) ?? 0) + 1);
  }
  const languages: Record<string, number> = {};
  for (const [language, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    languages[language] = count;
  }
  return languages;
}

//? A repository is 90d-active when its push time parses and is not older than
//* the cutoff; pushed_at exactly at the cutoff counts (>=) and a missing or
//* unparseable one can never count. No upper bound: a few seconds of clock skew
//* must not drop a just-pushed repository from the window.
function pushActivity(repos: GatheredRepo[], nowMs: number): { recent: number; oldestGapDays: number | null } {
  const cutoff = nowMs - ACTIVITY_WINDOW_DAYS * DAY_MS;
  const pushedMs: number[] = [];
  for (const repo of repos) {
    if (repo.pushed_at === null) continue;
    const parsed = Date.parse(repo.pushed_at);
    if (Number.isNaN(parsed) || parsed < cutoff) continue;
    pushedMs.push(parsed);
  }
  if (pushedMs.length === 0) return { recent: 0, oldestGapDays: null };
  const oldest = Math.min(...pushedMs);
  //? Whole elapsed days; the clamp keeps a clock-skewed future push (a negative
  //* fraction of a day) at 0 instead of flooring to -1.
  const oldestGapDays = Math.max(0, Math.floor((nowMs - oldest) / DAY_MS));
  return { recent: pushedMs.length, oldestGapDays };
}

export const userHealthTool = defineTool({
  name: "github_user_health",
  title: "GitHub user health",
  description:
    "One-call user profile audit: original vs fork split, star totals, top repositories, language distribution, and 90-day push activity — the multi-call walk of a manual audit, compressed to 1. Costs 2-11 core calls, none search. top_repos, languages, and 90-day push activity exclude forks by default (include_forks: true keeps them); originals, forks, fork_share, and total_stars always count them. Returns {user, name, type, public_repos, originals, forks, fork_share, total_stars, top_repos[{full_name, stars, language, pushed_at}], languages, recent_pushes_90d, oldest_push_90d_gap_days, repos_truncated, meta}.",
  inputSchema: {
    user: z.string().regex(LOGIN_PATTERN).describe("GitHub user login, like octocat (alphanumerics and hyphens)"),
    include_forks: z.boolean().optional().describe("Include fork repositories in the top_repos, languages, and push-activity metrics; defaults to false, pass true to include them"),
    per_page: z.number().int().min(1).max(100).optional().describe("Accepted for symmetry with the user tools; the metrics walk always reads 100 repositories per page (the gather's fixed page size)"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const user = parseUser(input.user);
    const userResult = await ctx.client.api<UserPayload>(`/users/${user}`, {
      fresh: input.fresh,
      cacheTtlMs: 300_000,
    });
    //* Owner repositories in upstream default order — the same ten-page walk
    //* github_user_repos uses for its stars ranking; no type filter forwards,
    //* so the walk sees the upstream default (owner repositories).
    const gathered = await gatherRepos(ctx, user, undefined, input.fresh);

    //? The split and total_stars cover every gathered repository either way: the
    //* split is the headline (fork_share needs the fork tally) and star totals
    //* reflect the account. The detail metrics rank the fork-filtered set, so
    //* forks stay noise until include_forks opts back in.
    const detailPool = input.include_forks === true ? gathered.payloads : gathered.payloads.filter((repo) => !repo.fork);
    const originals = gathered.payloads.filter((repo) => !repo.fork).length;
    const forks = gathered.payloads.length - originals;
    const totalStars = gathered.payloads.reduce((sum, repo) => sum + repo.stargazers_count, 0);
    const { recent, oldestGapDays } = pushActivity(detailPool, Date.now());

    //? Multi-request tool: the scarcest observation across the profile fetch and
    //* every gathered page, with the exact call count (1 + one per page).
    const calls = 1 + gathered.results.length;
    const meta = scarcestMeta([userResult, ...gathered.results], calls);
    return {
      user,
      name: userResult.data.name ?? null,
      type: userResult.data.type,
      public_repos: userResult.data.public_repos,
      originals,
      forks,
      fork_share: forkShare(originals, forks),
      total_stars: totalStars,
      top_repos: topRepoRows(detailPool),
      languages: languageCounts(detailPool),
      recent_pushes_90d: recent,
      oldest_push_90d_gap_days: oldestGapDays,
      //? repos_truncated appears only when the 10-page cap stopped the gather,
      //* the same conditional spread the meta key uses; meta stays the last key.
      ...(gathered.truncated ? { repos_truncated: true } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
