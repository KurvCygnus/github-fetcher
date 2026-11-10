import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { defaultExecFile } from "../core/auth.js";
import { defaultCacheDir } from "../core/cache.js";
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
  probe?: (host: string, port: number) => Promise<boolean>;
  listCache?: (dir: string) => Promise<{ entries: number; bytes: number }>;
}

const PROBE_TIMEOUT_MS = 2000;

interface CacheWalkStats {
  entries: number;
  bytes: number;
}

//* The default probe opens exactly one TCP connection and always answers with a
//* boolean, never a rejection: connect = reachable; timeout, socket error, or a
//* close before connect = false. The settled guard keeps post-teardown events
//* (close after destroy) from flipping an already-resolved answer.
function defaultProbe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
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

export function createDoctorTool(deps?: DoctorDeps): ToolDefinition {
  const env = deps?.env ?? process.env;
  const home = deps?.homedir ?? osHomedir();
  const platform = deps?.platform ?? process.platform;
  const probe = deps?.probe ?? defaultProbe;
  const listCache = deps?.listCache ?? defaultListCache;
  return defineTool({
    name: "github_doctor",
    title: "GitHub health check",
    description:
      "One-screen health check of this server's own wiring: token presence, opt-in identity, proxy mode with a TCP reachability probe of the resolved proxy, local cache state, and current quota. Costs 1 core call. Returns {token{present}, identity?{authenticated_as, scopes}, proxy{mode, url, reachable}, cache{mode, dir, entries, bytes}, quota{core{limit, remaining, reset}, search{limit, remaining, reset}}, meta{cache}}.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async handler(_input, ctx) {
      const cacheDir = ctx.config.cacheDir ?? defaultCacheDir(env, platform, home);
      const [proxy, cacheStats, quotaCall] = await Promise.all([
        resolveProxy(ctx.config, defaultExecFile, console.error),
        //? Cache stats are best-effort diagnostics: a failing walk (missing or
        //* unreadable dir) degrades to zeros instead of failing the whole screen.
        listCache(cacheDir).catch(() => ({ entries: 0, bytes: 0 })),
        ctx.client.api<RateLimitPayload>("/rate_limit", { cacheTtlMs: 0 }),
      ]);

      //? Direct mode and proxy-less resolutions need no probe and are reachable
      //* by definition; anything else reports what the probe observed, with a
      //* rejection or a broken URL degrading to unreachable, never a throw.
      let reachable = true;
      if (proxy.url !== null) {
        try {
          const parsed = new URL(proxy.url);
          const port = parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port);
          reachable = await probe(parsed.hostname, port);
        } catch {
          reachable = false;
        }
      }

      const quota = Object.fromEntries(
        Object.entries(quotaCall.data.resources)
          .filter(([name]) => name === "core" || name === "search")
          .map(([name, bucket]) => [
            name,
            { limit: bucket.limit, remaining: bucket.remaining, reset: new Date(bucket.reset * 1000).toISOString() },
          ]),
      );

      //? Identity mirrors github_rate_limit's opt-in: scopes come from the quota
      //* response's x-oauth-scopes header, and the login needs one extra best-effort
      //* /user call, taken only when a token is actually configured.
      let identity: { authenticated_as: string | null; scopes: string[] } | undefined;
      if (ctx.config.exposeIdentity) {
        let authenticatedAs: string | null = null;
        if (ctx.authFingerprint !== "anonymous") {
          try {
            const user = await ctx.client.api<{ login: string }>("/user", { cacheTtlMs: 300_000 });
            authenticatedAs = user.data.login;
          } catch {
            authenticatedAs = null;
          }
        }
        identity = { authenticated_as: authenticatedAs, scopes: parseScopes(quotaCall.headers.get("x-oauth-scopes")) };
      }

      //? cacheTtlMs: 0 means the quota call never reads the cache, so the outcome
      //* is always a miss; the fallback keeps the envelope honest for callers that
      //* report no cache outcome at all. meta is spread last so it trails the
      //* fixed keys, and identity sits between token and proxy per the shape.
      const meta = responseMeta({ cache: quotaCall.cache }) ?? { cache: "miss" as const };
      return {
        token: { present: ctx.authFingerprint !== "anonymous" },
        ...(identity !== undefined ? { identity } : {}),
        proxy: { mode: ctx.config.proxyMode, url: proxy.url, reachable },
        cache: { mode: ctx.config.cacheMode, dir: cacheDir, entries: cacheStats.entries, bytes: cacheStats.bytes },
        quota,
        meta,
      };
    },
  });
}

export const doctorTool: ToolDefinition = createDoctorTool();
