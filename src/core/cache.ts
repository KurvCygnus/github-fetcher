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
  //* The write-path fs boundary and retry pacing are injectable so Windows
  //* EPERM retries are testable offline without real locks or real sleeps.
  writeFs?: CacheWriteFs | undefined;
  retryDelay?: (() => Promise<void>) | undefined;
}

export interface CacheWriteFs {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
}

const defaultWriteFs: CacheWriteFs = {
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  async writeFile(path, data) {
    await writeFile(path, data, "utf8");
  },
  async chmod(path, mode) {
    await chmod(path, mode).catch(() => {});
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async rm(path) {
    await rm(path, { force: true });
  },
};

const RENAME_ATTEMPTS = 3;
const RETRY_DELAY_MS = 20;

//? A short bounded pause gives Windows time to release an exclusive lock on
//* the target before the identical temp file is written and renamed again.
function defaultRetryDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
}

export function cacheKey(url: string, authFingerprint: string): string {
  return createHash("sha256").update(`${url}\0${authFingerprint}`).digest("hex");
}

//? Cache-only read for the 404 recovery hints: looks up one key, parses the
//* stored body, and returns the listing's entry paths, or null when the key is
//* missing, the body is not a tree listing, or the read itself fails. It never
//* performs a network request — CacheStore is purely local storage.
export async function readCachedTree(cache: CacheStore, key: string): Promise<string[] | null> {
  let entry: CacheEntry | null;
  try {
    entry = await cache.get(key);
  } catch {
    return null;
  }
  if (entry === null) return null;
  try {
    const parsed: unknown = JSON.parse(entry.body);
    if (typeof parsed !== "object" || parsed === null) return null;
    const tree = (parsed as { tree?: unknown }).tree;
    if (!Array.isArray(tree)) return null;
    const paths: string[] = [];
    for (const item of tree) {
      if (typeof item !== "object" || item === null) continue;
      const path = (item as { path?: unknown }).path;
      if (typeof path === "string") paths.push(path);
    }
    return paths;
  } catch {
    return null;
  }
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

function diskStore(
  dir: string,
  now: () => number,
  writeFs: CacheWriteFs,
  retryDelay: () => Promise<void>,
): CacheStore {
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
      await writeFs.mkdir(dir);
      const target = file(key);
      const temp = `${target}.${randomUUID()}.tmp`;
      const body = JSON.stringify(entry);
      const writeTemp = async (): Promise<void> => {
        await writeFs.writeFile(temp, body);
        await writeFs.chmod(temp, 0o600).catch(() => {});
      };
      await writeTemp();
      for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
        try {
          await writeFs.rename(temp, target);
          return;
        } catch (error) {
          //* Only Windows EPERM is a transient lock; every other failure is
          //* reported immediately. Each EPERM removes the temp so a failed
          //* attempt leaves nothing on disk; the last one rethrows after cleanup.
          const isEperm = error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM";
          if (!isEperm) throw error;
          await writeFs.rm(temp);
          if (attempt === RENAME_ATTEMPTS) throw error;
          await retryDelay();
          await writeTemp();
        }
      }
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
  return diskStore(
    options.dir,
    options.now ?? Date.now,
    options.writeFs ?? defaultWriteFs,
    options.retryDelay ?? defaultRetryDelay,
  );
}
