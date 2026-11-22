import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeDaemonToken, writeDaemonToken } from "../../src/daemon/auth.js";
import { daemonConfigDir, daemonStatePath, daemonTokenPath } from "../../src/daemon/paths.js";
import type { DaemonState } from "../../src/daemon/state.js";
import { pidAlive, readDaemonState, removeDaemonState, writeDaemonState } from "../../src/daemon/state.js";

const APPDATA = "C:\\Users\\Test\\AppData\\Roaming";
const fakeHome = "C:\\Users\\Test";

describe("daemon config paths", () => {
  it("uses APPDATA on win32 for the state and token files", () => {
    const env: NodeJS.ProcessEnv = { APPDATA };
    expect(daemonConfigDir(env, "win32", fakeHome)).toBe(APPDATA);
    expect(daemonStatePath(env, "win32", fakeHome)).toBe(join(APPDATA, "github-fetcher", "daemon.json"));
    expect(daemonTokenPath(env, "win32", fakeHome)).toBe(join(APPDATA, "github-fetcher", "token"));
  });

  it("uses the macOS application support directory", () => {
    expect(daemonConfigDir({}, "darwin", "/Users/test")).toBe(join("/Users/test", "Library", "Application Support"));
  });

  it("uses XDG_CONFIG_HOME or ~/.config elsewhere", () => {
    expect(daemonConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/test")).toBe("/xdg");
    expect(daemonConfigDir({}, "linux", "/home/test")).toBe(join("/home/test", ".config"));
  });
});

const sample: DaemonState = {
  pid: 4242,
  port: 39117,
  token: "s3cr3t",
  startedAt: "2026-11-22T00:00:00.000Z",
  version: "0.6.0",
};

describe("daemon state files", () => {
  const dirs: string[] = [];

  async function tempStatePath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "ghf-state-"));
    dirs.push(dir);
    return join(dir, "nested", "daemon.json");
  }

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("round-trips a state object and creates the parent directory", async () => {
    const path = await tempStatePath();
    await writeDaemonState(path, sample);
    await expect(readDaemonState(path)).resolves.toEqual(sample);
  });

  it("returns null for a missing file", async () => {
    const path = await tempStatePath();
    await expect(readDaemonState(path)).resolves.toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    const path = await tempStatePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{not json");
    await expect(readDaemonState(path)).resolves.toBeNull();
  });

  it("returns null for a value whose shape is not DaemonState", async () => {
    const path = await tempStatePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ pid: 1, port: 2 }));
    await expect(readDaemonState(path)).resolves.toBeNull();
  });

  it("removes a state file", async () => {
    const path = await tempStatePath();
    await writeDaemonState(path, sample);
    await removeDaemonState(path);
    await expect(readDaemonState(path)).resolves.toBeNull();
  });
});

describe("daemon token files", () => {
  it("writes the exact header value with no trailing newline and removes it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghf-token-"));
    try {
      const path = join(dir, "token");
      await writeDaemonToken(path, "abc123");
      //* {file:...} substitution uses the whole file as the header value; a newline would corrupt it.
      expect(await readFile(path, "utf8")).toBe("Bearer abc123");
      await removeDaemonToken(path);
      await expect(readFile(path, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("pidAlive", () => {
  it("is true for the current process", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it("is false for an implausibly large pid", () => {
    //* INT32_MAX cannot be a live pid on supported platforms, so the OS reports ESRCH.
    expect(pidAlive(2147483647)).toBe(false);
  });
});
