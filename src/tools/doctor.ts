import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { defaultExecFile } from "../core/auth.js";
import { defaultCacheDir } from "../core/cache.js";
import type { ApiResult } from "../core/github.js";
import { resolveProxy } from "../core/proxy.js";
import { defineTool } from "./define.js";
import type { ToolDefinition } from "./define.js";
import { responseMeta } from "./meta.js";

//? Injectable boundaries so the diagnostic stays offline-testable: every real
//* net/fs touch lives behind a dep that tests replace with fakes.
export interface DoctorDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
  listCache?: (dir: string) => Promise<{ entries: number; bytes: number }>;
  logger?: (message: string) => void;
}

interface CacheWalkStats {
  entries: number;
  bytes: number;
}

//* The default walk counts *.json files (recursively) and sums their sizes. A
//* missing or unreadable directory contributes zeros, and entries that vanish
//* between readdir and stat are skipped, so the walk itself never rejects.
async function defaultListCache(dir: string): Promise<CacheWalkStats> {
  let entries = 0;
  let bytes = 0;
  const walk = async (current: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(current, name);
      let info: Stats | undefined;
      try {
        info = await stat(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await walk(full);
      } else if (name.endsWith(".json")) {
        entries += 1;
        bytes += info.size;
      }
    }
  };
  await walk(dir);
  return { entries, bytes };
}

//? Only the fields this tool reads are typed; the REST payload carries more.
interface RateBucket {
  limit: number;
  remaining: number;
  reset: number;
}

interface RateLimitPayload {
  resources: Record<string, RateBucket>;
}

//* Duplicated from rate.ts (kept private there) so this file stays self-contained:
//* a comma-separated scope header becomes a trimmed list without empty items.
function parseScopes(header: string | null): string[] {
  if (header === null) return [];
  return header.split(",").map((part) => part.trim()).filter((part) => part !== "");
}

//* Reachability diagnostics carry a bounded one-line reason so a verbose
//* upstream error cannot flood the server log through the doctor's own call.
function shortMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

export function createDoctorTool(deps?: DoctorDeps): ToolDefinition {
  const env = deps?.env ?? process.env;
  const home = deps?.homedir ?? osHomedir();
  const platform = deps?.platform ?? process.platform;
  const listCache = deps?.listCache ?? defaultListCache;
  const logger = deps?.logger ?? console.error;
  return defineTool({
    name: "github_doctor",
    title: "GitHub health check",
    description:
      "One-screen health check of this server's own wiring: token presence, opt-in identity, proxy mode with reachability derived from the doctor's own API probe, local cache state, current quota, and pinned_repos listing this session's pinned repositories. Costs 1 core call, or 2 with opt-in identity. Returns {token{present}, identity?{authenticated_as, scopes}, proxy{mode, url, reachable}, cache{mode, dir, entries, bytes}, quota{core{limit, remaining, reset}, search{limit, remaining, reset}}, pinned_repos, meta{cache}}.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async handler(_input, ctx) {
      const cacheDir = ctx.config.cacheDir ?? defaultCacheDir(env, platform, home);
      const [proxy, cacheStats] = await Promise.all([
        resolveProxy(ctx.config, defaultExecFile, logger),
        //? Cache stats are best-effort diagnostics: a failing walk (missing or
        //* unreadable dir) degrades to zeros instead of failing the whole screen.
        listCache(cacheDir).catch(() => ({ entries: 0, bytes: 0 })),
      ]);

      let quotaCall: ApiResult<RateLimitPayload> | undefined;
      let rateError: unknown;
      try {
        quotaCall = await ctx.client.api<RateLimitPayload>("/rate_limit", { cacheTtlMs: 0 });
      } catch (error) {
        rateError = error;
        //* Direct mode keeps its existing contract: a failed quota call is a
        //* real failure, so it still rejects instead of reporting an empty screen.
        if (proxy.url === null) throw error;
      }

      //* Reachability is the outcome of this call's own quota probe, not a
      //* separate TCP connection: no proxy is reachable by definition, a proxy
      //* that answered /rate_limit is reachable, and a rejected one reports
      //* unreachable with a short reason instead of failing the whole screen.
      let reachable = true;
      if (proxy.url !== null && quotaCall === undefined) {
        reachable = false;
        logger(`github_doctor: proxy ${proxy.url} did not answer /rate_limit: ${shortMessage(rateError)}`);
      }

      const quota = Object.fromEntries(
        Object.entries(quotaCall?.data.resources ?? {})
          .filter(([name]) => name === "core" || name === "search")
          .map(([name, bucket]) => [
            name,
            { limit: bucket.limit, remaining: bucket.remaining, reset: new Date(bucket.reset * 1000).toISOString() },
          ]),
      );

      //? Identity mirrors github_rate_limit's opt-in: scopes come from the quota
      //* response's x-oauth-scopes header, and the login needs one extra best-effort
      //* /user call, taken only when a token is actually configured. That lookup
      //* adds a second upstream request whenever it fires; a failed /user still
      //* spent the request, so the count below stays exact either way.
      let calls = 1;
      let identity: { authenticated_as: string | null; scopes: string[] } | undefined;
      if (ctx.config.exposeIdentity) {
        let authenticatedAs: string | null = null;
        if (ctx.authFingerprint !== "anonymous") {
          calls += 1;
          try {
            const user = await ctx.client.api<{ login: string }>("/user", { cacheTtlMs: 300_000 });
            authenticatedAs = user.data.login;
          } catch {
            authenticatedAs = null;
          }
        }
        identity = {
          authenticated_as: authenticatedAs,
          scopes: parseScopes(quotaCall?.headers.get("x-oauth-scopes") ?? null),
        };
      }

      //? cacheTtlMs: 0 means the quota call never reads the cache, so the outcome
      //* is always a miss; the fallback keeps the envelope honest for callers that
      //* report no cache outcome at all. Pins come from this context's own store,
      //* so one session never lists another's pins. meta trails the fixed keys,
      //* and identity sits between token and proxy per the shape.
      const meta = responseMeta({ cache: quotaCall?.cache }, calls) ?? { cache: "miss" as const, calls };
      return {
        token: { present: ctx.authFingerprint !== "anonymous" },
        ...(identity !== undefined ? { identity } : {}),
        proxy: { mode: ctx.config.proxyMode, url: proxy.url, reachable },
        cache: { mode: ctx.config.cacheMode, dir: cacheDir, entries: cacheStats.entries, bytes: cacheStats.bytes },
        quota,
        pinned_repos: ctx.pins?.keys() ?? [],
        meta,
      };
    },
  });
}

export const doctorTool: ToolDefinition = createDoctorTool();
