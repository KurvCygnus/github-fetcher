import { mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheKey, createCacheStore, defaultCacheDir } from "../src/cache.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gh-fetcher-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const entry = {
  version: 1 as const,
  url: "https://api.github.com/repos/a/b",
  etag: "\"abc\"",
  last_modified: null,
  link: null,
  fetched_at: 1000,
  status: 200,
  content_type: "application/json",
  body: "{\"ok\":true}",
};

describe("cacheKey", () => {
  it("is stable and separates token identities", () => {
    expect(cacheKey("https://api.github.com/x", "token-a")).toBe(
      cacheKey("https://api.github.com/x", "token-a"),
    );
    expect(cacheKey("https://api.github.com/x", "token-a")).not.toBe(
      cacheKey("https://api.github.com/x", "token-b"),
    );
    expect(cacheKey("https://api.github.com/x", "token-a")).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("defaultCacheDir", () => {
  it("uses LOCALAPPDATA on Windows", () => {
    expect(defaultCacheDir({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a")).toBe(
      join("C:\\Users\\a\\AppData\\Local", "github-fetcher", "cache"),
    );
  });

  it("uses XDG_CACHE_HOME on Linux", () => {
    expect(defaultCacheDir({ XDG_CACHE_HOME: "/home/a/.cache" }, "linux", "/home/a")).toBe(
      join("/home/a/.cache", "github-fetcher", "cache"),
    );
  });

  it("uses Library/Caches on macOS", () => {
    expect(defaultCacheDir({}, "darwin", "/Users/a")).toBe(
      join("/Users/a", "Library", "Caches", "github-fetcher", "cache"),
    );
  });
});

describe("createCacheStore", () => {
  it("round-trips a disk entry", async () => {
    const dir = await tempDir();
    const store = createCacheStore({ mode: "disk", dir });
    const key = cacheKey(entry.url, "token-a");
    await store.set(key, entry);
    await expect(store.get(key)).resolves.toEqual(entry);
  });

  it("deletes corrupt entries", async () => {
    const dir = await tempDir();
    const store = createCacheStore({ mode: "disk", dir });
    const key = cacheKey(entry.url, "token-a");
    await writeFile(join(dir, `${key}.json`), "not json", "utf8");
    await expect(store.get(key)).resolves.toBeNull();
    await expect(readdir(dir)).resolves.not.toContain(`${key}.json`);
  });

  it("writes atomically without leaving temp files", async () => {
    const dir = await tempDir();
    const store = createCacheStore({ mode: "disk", dir });
    const key = cacheKey(entry.url, "token-a");
    await store.set(key, entry);
    const files = await readdir(dir);
    expect(files).toEqual([`${key}.json`]);
    //! JSON.stringify escapes the quotes in body, so the file holds \"ok\":true, not "ok":true.
    expect(await readFile(join(dir, `${key}.json`), "utf8")).toContain('\\"ok\\":true');
  });

  it("keeps entries in memory mode without writing files", async () => {
    const dir = await tempDir();
    const store = createCacheStore({ mode: "memory", dir });
    const key = cacheKey(entry.url, "token-a");
    await store.set(key, entry);
    await expect(store.get(key)).resolves.toEqual(entry);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("returns misses in off mode", async () => {
    const dir = await tempDir();
    const store = createCacheStore({ mode: "off", dir });
    const key = cacheKey(entry.url, "token-a");
    await store.set(key, entry);
    await expect(store.get(key)).resolves.toBeNull();
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("prunes entries older than seven days", async () => {
    const dir = await tempDir();
    const store = createCacheStore({ mode: "disk", dir });
    const key = cacheKey(entry.url, "token-a");
    await store.set(key, entry);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(dir, `${key}.json`), old, old);
    await store.prune();
    await expect(readdir(dir)).resolves.toEqual([]);
  });
});
