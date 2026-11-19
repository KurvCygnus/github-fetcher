import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defaultCacheDir } from "../core/cache.js";
import { defineTool } from "./define.js";
import type { ToolDefinition } from "./define.js";
import { windowStartDate } from "./health.js";
import { scarcestMeta } from "./meta.js";
import { githubQuery } from "./util.js";

//? Injectable boundaries following the doctor factory pattern: the snapshot
//* store (and the clock/env inputs feeding its default) lives behind deps so
//! tests inject in-memory stores and never touch the real filesystem.
export interface TrendingDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
  readSnapshot?: (key: string) => Promise<SnapshotEntry | undefined>;
  writeSnapshot?: (key: string, entry: SnapshotEntry) => Promise<void>;
  now?: () => Date;
}

//? One observation of a lens at one point in time: the stars map is the
//* full_name -> stargazer count of every repo the lens returned, and the date
//* stamps the observation so repeated calls can turn deltas into velocity.
export interface SnapshotEntry {
  date: string;
  stars: Record<string, number>;
}

//? The window qualifier maps to whole days; windowStartDate slices the ISO
//* date, so the search qualifier is always a plain YYYY-MM-DD threshold.
const WINDOW_DAYS: Record<"daily" | "weekly" | "monthly", number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

//? Only the fields this tool reads are typed; the REST payload carries more.
interface SearchRepoItem {
  full_name: string;
  stargazers_count: number;
  description: string | null;
  language: string | null;
  pushed_at: string;
  created_at: string;
}

interface SearchPayload {
  total_count: number;
  incomplete_results: boolean;
  items: SearchRepoItem[];
}

interface SnapshotFile {
  [key: string]: SnapshotEntry;
}

//? Entries cross a JSON boundary, so they are validated before use: a missing
//* stars map or a non-number count would otherwise crash the delta math (or
//* poison it with NaN) on a hand-edited or corrupt snapshot file. A malformed
//* entry reads as "no prior snapshot", exactly like a missing one.
function isSnapshotEntry(value: unknown): value is SnapshotEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as SnapshotEntry;
  return (
    typeof candidate.date === "string" &&
    typeof candidate.stars === "object" &&
    candidate.stars !== null &&
    Object.values(candidate.stars).every((count) => typeof count === "number")
  );
}

//? The default store keeps every lens key in one JSON file beside the HTTP
//* cache. Both directions are best-effort: a missing or corrupt file reads as
//* "no prior snapshot" and write failures are swallowed, because a broken
//* snapshot store must never fail the trending call it decorates. The handler
//* also guards the injected fakes, so this belt-and-braces catch only covers
//* the fs layer itself.
//* Concurrency: overlapping calls can interleave the read-modify-write, and the worst case degrades to "no prior", so no lock.
function defaultSnapshotStore(cacheDir: string): {
  readSnapshot: (key: string) => Promise<SnapshotEntry | undefined>;
  writeSnapshot: (key: string, entry: SnapshotEntry) => Promise<void>;
} {
  const file = join(cacheDir, "trending-snapshots.json");
  const readAll = async (): Promise<SnapshotFile> => {
    try {
      const text = await readFile(file, "utf8");
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      return parsed as SnapshotFile;
    } catch {
      return {};
    }
  };
  return {
    async readSnapshot(key) {
      try {
        const entry = (await readAll())[key];
        return isSnapshotEntry(entry) ? entry : undefined;
      } catch {
        return undefined;
      }
    },
    async writeSnapshot(key, entry) {
      try {
        const all = await readAll();
        all[key] = entry;
        await mkdir(cacheDir, { recursive: true });
        await writeFile(file, JSON.stringify(all), "utf8");
      } catch {
        //* Best-effort by contract: an unwritable store loses this observation
        //* only, and the next call simply starts from the next prior it sees.
      }
    },
  };
}

export function createTrendingTool(deps?: TrendingDeps): ToolDefinition {
  const env = deps?.env ?? process.env;
  const home = deps?.homedir ?? osHomedir();
  const platform = deps?.platform ?? process.platform;
  const injectedRead = deps?.readSnapshot;
  const injectedWrite = deps?.writeSnapshot;
  const now = deps?.now ?? (() => new Date());
  return defineTool({
    name: "github_trending",
    title: "GitHub trending approximation",
    description:
      "Compute a trending approximation from GitHub search, NOT GitHub's trending page: the rising lens lists repositories created inside the window above the star floor and the active lens lists repositories pushed inside the window, both sorted by stars. Star gains are not observable from search alone; every observation is snapshotted under the cache directory, and repeated calls with the same lens, language, and window gain stars_gained against the previous snapshot, so deltas accumulate across calls into real velocity. Costs 2 search calls against the 30 requests/minute search quota. Returns {window, language, lenses{rising, active}, rising_incomplete_results, active_incomplete_results, source}.",
    inputSchema: {
      window: z.enum(["daily", "weekly", "monthly"]).optional().describe("Lookback window for both lenses; daily is 1 day, weekly 7, monthly 30, default weekly"),
      language: z.string().optional().describe("Restrict both lenses to one language qualifier, like rust or typescript"),
      min_stars: z.number().int().min(0).optional().describe("Star floor for both lenses (stars:>N), default 100"),
      limit: z.number().int().min(1).max(30).optional().describe("Rows per lens, 1-30, default 15"),
      fresh: z.boolean().optional().describe("Bypass the local cache"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async handler(input, ctx) {
      const stamp = now();
      const windowName = input.window ?? "weekly";
      const windowStart = windowStartDate(stamp, WINDOW_DAYS[windowName]);
      const minStars = input.min_stars ?? 100;
      const perPage = Math.min(input.limit ?? 15, 100);
      const languageTerm = input.language === undefined ? "" : ` language:${input.language}`;
      const risingQuery = `created:>${windowStart} stars:>${minStars}${languageTerm}`;
      const activeQuery = `pushed:>${windowStart} stars:>${minStars}${languageTerm}`;
      //? Snapshot keys name the lens, the language scope, and the window, so a
      //* rust:daily observation can never be diffed against an any:weekly one.
      const risingKey = `rising:${input.language ?? "any"}:${windowName}`;
      const activeKey = `active:${input.language ?? "any"}:${windowName}`;

      const dir = ctx.config.cacheDir ?? defaultCacheDir(env, platform, home);
      const store = defaultSnapshotStore(dir);
      const readSnapshot = injectedRead ?? store.readSnapshot;
      const writeSnapshot = injectedWrite ?? store.writeSnapshot;
      //? The store as a whole is best-effort: a rejecting injected fake degrades
      //* to "no prior" and a lost write, never to a failed call.
      const readPrior = async (key: string): Promise<SnapshotEntry | undefined> => {
        try {
          return await readSnapshot(key);
        } catch {
          return undefined;
        }
      };
      const writeFresh = async (key: string, entry: SnapshotEntry): Promise<void> => {
        try {
          await writeSnapshot(key, entry);
        } catch {
          //* The observation is lost; the next call simply starts without a prior.
        }
      };

      //? Two routed searches: the lenses always carry different qualifiers
      //* (created:> vs pushed:>), so both api invocations are issued on every
      //* call and meta.calls is exactly 2; a warm local cache still counts the
      //* invocation, matching the house definition of calls.
      const [risingCall, activeCall, risingPrior, activePrior] = await Promise.all([
        ctx.client.api<SearchPayload>(
          `/search/repositories${githubQuery({ q: risingQuery, sort: "stars", per_page: perPage })}`,
          { fresh: input.fresh, cacheTtlMs: 300_000 },
        ),
        ctx.client.api<SearchPayload>(
          `/search/repositories${githubQuery({ q: activeQuery, sort: "stars", per_page: perPage })}`,
          { fresh: input.fresh, cacheTtlMs: 300_000 },
        ),
        readPrior(risingKey),
        readPrior(activeKey),
      ]);

      const leanRow = (item: SearchRepoItem, prior: SnapshotEntry | undefined) => {
        const priorStars = prior?.stars[item.full_name];
        return {
          full_name: item.full_name,
          stars: item.stargazers_count,
          description: item.description,
          language: item.language,
          pushed_at: item.pushed_at,
          created_at: item.created_at,
          //? gained = current - prior exactly, so a negative delta passes
          //* through unclamped: stars can shrink, and clamping would lie.
          ...(priorStars !== undefined ? { stars_gained: item.stargazers_count - priorStars } : {}),
        };
      };

      //? The fresh observation is recorded AFTER the prior read, so the next
      //* call diffs against this moment. The two writes run SEQUENTIALLY, not
      //* in a Promise.all: the default store read-modify-writes the whole
      //* snapshot file, so overlapping writes would both read the same
      //* pre-state and the last writer's file would contain only its own key,
      //* silently dropping the other lens's observation.
      const date = stamp.toISOString();
      const starsOf = (items: SearchRepoItem[]): Record<string, number> =>
        Object.fromEntries(items.map((item) => [item.full_name, item.stargazers_count]));
      await writeFresh(risingKey, { date, stars: starsOf(risingCall.data.items) });
      await writeFresh(activeKey, { date, stars: starsOf(activeCall.data.items) });

      const meta = scarcestMeta([risingCall, activeCall], 2);
      return {
        window: windowName,
        language: input.language ?? null,
        lenses: {
          rising: risingCall.data.items.map((item) => leanRow(item, risingPrior)),
          active: activeCall.data.items.map((item) => leanRow(item, activePrior)),
        },
        rising_incomplete_results: risingCall.data.incomplete_results,
        active_incomplete_results: activeCall.data.incomplete_results,
        //? "computed+snapshot" when either lens had a prior observation; the
        //* flag is honest at the response level even when only one lens deltas.
        source: risingPrior !== undefined || activePrior !== undefined ? "computed+snapshot" : "computed",
        ...(meta !== undefined ? { meta } : {}),
      };
    },
  });
}

export const trendingTool: ToolDefinition = createTrendingTool();
