import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cacheKey, createCacheStore, defaultCacheDir } from "../../src/core/cache.js";

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

  it("deletes readable entries that fail validation", async () => {
    const dir = await tempDir();
    const store = createCacheStore({ mode: "disk", dir });
    const key = cacheKey(entry.url, "token-a");
    await writeFile(join(dir, `${key}.json`), "{\"version\":2}", "utf8");
    await expect(store.get(key)).resolves.toBeNull();
    await expect(readdir(dir)).resolves.not.toContain(`${key}.json`);
  });

  it("returns a miss and keeps an unreadable entry", async () => {
    const dir = await tempDir();
    const store = createCacheStore({ mode: "disk", dir });
    const key = cacheKey(entry.url, "token-a");
    //! chmod 0o000 does not make files unreadable on Windows (it only toggles
    //! the read-only flag), so the unreadable case is simulated mock-free by
    //! putting a directory at the entry path: readFile fails with a filesystem
    //! error (EISDIR/EPERM, not ENOENT) on every platform, and the entry must
    //! survive the miss instead of being deleted or making get() reject.
    await mkdir(join(dir, `${key}.json`));
    await expect(store.get(key)).resolves.toBeNull();
    await expect(readdir(dir)).resolves.toContain(`${key}.json`);
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

describe("disk store rename retries", () => {
  function eperm(): NodeJS.ErrnoException {
    const error: NodeJS.ErrnoException = new Error("EPERM: operation not permitted");
    error.code = "EPERM";
    return error;
  }

  //? Faked disk boundaries keep the retry cases offline and deterministic: no
  //* real socket, no real filesystem race, and the injected delay never sleeps.
  function fakeDisk() {
    const temps = new Set<string>();
    return {
      temps,
      writeFs: {
        async mkdir(_path: string) {},
        writeFile: vi.fn(async (path: string, _data: string) => {
          temps.add(path);
        }),
        chmod: vi.fn(async (_path: string, _mode: number) => {}),
        rename: vi.fn(async (_from: string, _to: string) => {}),
        rm: vi.fn(async (path: string) => {
          temps.delete(path);
        }),
      },
    };
  }

  it("retries an EPERM rename up to three attempts and leaves no temp file", async () => {
    const disk = fakeDisk();
    const retryDelay = vi.fn(async () => {});
    let attempts = 0;
    disk.writeFs.rename.mockImplementation(async (from, _to) => {
      attempts += 1;
      if (attempts < 3) throw eperm();
      disk.temps.delete(from);
    });
    const store = createCacheStore({
      mode: "disk",
      dir: await tempDir(),
      writeFs: disk.writeFs,
      retryDelay,
    });
    await store.set(cacheKey(entry.url, "token-a"), entry);
    expect(disk.writeFs.rename).toHaveBeenCalledTimes(3);
    expect(disk.writeFs.writeFile).toHaveBeenCalledTimes(3);
    expect(disk.writeFs.chmod).toHaveBeenCalledTimes(3);
    expect(disk.writeFs.rm).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledTimes(2);
    expect(disk.temps.size).toBe(0);
  });

  it("recreate uses the same temp path and content on every retry", async () => {
    const disk = fakeDisk();
    const retryDelay = vi.fn(async () => {});
    let attempts = 0;
    disk.writeFs.rename.mockImplementation(async (from, _to) => {
      attempts += 1;
      if (attempts < 3) throw eperm();
      disk.temps.delete(from);
    });
    const store = createCacheStore({
      mode: "disk",
      dir: await tempDir(),
      writeFs: disk.writeFs,
      retryDelay,
    });
    await store.set(cacheKey(entry.url, "token-a"), entry);
    const paths = disk.writeFs.writeFile.mock.calls.map((call) => call[0]);
    expect(new Set(paths).size).toBe(1);
    const bodies = disk.writeFs.writeFile.mock.calls.map((call) => call[1]);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('\\"ok\\":true');
  });

  it("leaves no temp file after the third EPERM still fails", async () => {
    const disk = fakeDisk();
    const retryDelay = vi.fn(async () => {});
    disk.writeFs.rename.mockImplementation(async () => {
      throw eperm();
    });
    const store = createCacheStore({
      mode: "disk",
      dir: await tempDir(),
      writeFs: disk.writeFs,
      retryDelay,
    });
    await expect(store.set(cacheKey(entry.url, "token-a"), entry)).rejects.toMatchObject({ code: "EPERM" });
    expect(disk.writeFs.rename).toHaveBeenCalledTimes(3);
    expect(disk.writeFs.rm).toHaveBeenCalledTimes(3);
    expect(retryDelay).toHaveBeenCalledTimes(2);
    expect(disk.temps.size).toBe(0);
  });

  it("throws a non-EPERM rename error immediately without retrying", async () => {
    const disk = fakeDisk();
    const retryDelay = vi.fn(async () => {});
    disk.writeFs.rename.mockImplementation(async () => {
      throw new Error("EACCES: permission denied");
    });
    const store = createCacheStore({
      mode: "disk",
      dir: await tempDir(),
      writeFs: disk.writeFs,
      retryDelay,
    });
    await expect(store.set(cacheKey(entry.url, "token-a"), entry)).rejects.toThrow("EACCES");
    expect(disk.writeFs.rename).toHaveBeenCalledTimes(1);
    expect(retryDelay).not.toHaveBeenCalled();
  });
});
