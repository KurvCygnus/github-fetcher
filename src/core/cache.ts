import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CacheMode } from "./config.js";

export interface CacheEntry {
  version: 1;
  url: string;
  etag: string | null;
  last_modified: string | null;
  link: string | null;
  fetched_at: number;
  status: number;
  content_type: string;
  body: string;
  //? Quota pair captured from the response that produced the body. Entries written
  //? before the quota fields existed omit them, so optional
  //? props spell out "undefined" and a missing pair reads as unknown quota — no
  //? cache migration, and a half pair is never stored.
  quota_resource?: string | undefined;
  quota_remaining?: number | undefined;
}

export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  prune(): Promise<void>;
}

export interface CacheOptions {
  mode: CacheMode;
  dir: string;
  now?: () => number;
}

export function cacheKey(url: string, authFingerprint: string): string {
  return createHash("sha256").update(`${url}\0${authFingerprint}`).digest("hex");
}

export function defaultCacheDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    return join(base, "github-fetcher", "cache");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Caches", "github-fetcher", "cache");
  }
  return join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "github-fetcher", "cache");
}

function emptyStore(): CacheStore {
  return {
    async get() {
      return null;
    },
    async set() {},
    async delete() {},
    async prune() {},
  };
}

function memoryStore(): CacheStore {
  const entries = new Map<string, CacheEntry>();
  return {
    async get(key) {
      return entries.get(key) ?? null;
    },
    async set(key, entry) {
      entries.set(key, entry);
    },
    async delete(key) {
      entries.delete(key);
    },
    async prune() {},
  };
}

function diskStore(dir: string, now: () => number): CacheStore {
  const file = (key: string) => join(dir, `${key}.json`);

  return {
    async get(key) {
      const target = file(key);
      let text: string;
      try {
        text = await readFile(target, "utf8");
      } catch {
        //* ENOENT is the normal miss; other read failures (EPERM, EBADF, EISDIR, ...)
        //* are not proof of corruption, so the entry is kept for a later retry.
        return null;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          (parsed as CacheEntry).version !== 1 ||
          typeof (parsed as CacheEntry).body !== "string" ||
          typeof (parsed as CacheEntry).url !== "string"
        ) {
          throw new Error("invalid cache entry");
        }
        return parsed as CacheEntry;
      } catch {
        //* Only a file that was readable but unusable counts as corrupt and gets
        //* deleted; the rm itself must never turn a miss into a rejection.
        await rm(target, { force: true }).catch(() => {});
        return null;
      }
    },

    async set(key, entry) {
      await mkdir(dir, { recursive: true });
      const target = file(key);
      const temp = `${target}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(entry), "utf8");
      await chmod(temp, 0o600).catch(() => {});
      await rename(temp, target);
    },

    async delete(key) {
      await rm(file(key), { force: true });
    },

    async prune() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return;
      }
      const cutoff = now() - 7 * 24 * 60 * 60 * 1000;
      const files: Array<{ name: string; mtime: number }> = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        try {
          const info = await stat(join(dir, name));
          if (info.mtimeMs < cutoff) await rm(join(dir, name), { force: true });
          else files.push({ name, mtime: info.mtimeMs });
        } catch {
          //* A file disappearing during pruning is harmless.
        }
      }
      files.sort((a, b) => b.mtime - a.mtime);
      for (const stale of files.slice(5000)) {
        await rm(join(dir, stale.name), { force: true });
      }
    },
  };
}

export function createCacheStore(options: CacheOptions): CacheStore {
  if (options.mode === "off") return emptyStore();
  if (options.mode === "memory") return memoryStore();
  return diskStore(options.dir, options.now ?? Date.now);
}
