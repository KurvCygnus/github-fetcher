import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../../src/core/version.js";
import {
  daemonStatePath,
  daemonTokenPath,
} from "../../src/daemon/paths.js";
import type { DaemonHttpHandle, DaemonHttpOptions } from "../../src/daemon/http.js";
import type { DaemonState } from "../../src/daemon/state.js";
import { readDaemonState } from "../../src/daemon/state.js";
import {
  DEFAULT_DAEMON_PORT,
  ensureDaemon,
  runDaemonCommand,
  runServeDaemon,
} from "../../src/cli/daemon.js";
import type {
  DaemonChild,
  DaemonCliDeps,
  DaemonHealth,
  SpawnRequest,
  StartHttpResult,
} from "../../src/cli/daemon.js";

const PORT = 41999;
const DEAD_PID = 2147483647;
//* The fake child uses this process's PID so liveness checks stay offline and real.
const DAEMON_PID = process.pid;

function stream(): NodeJS.WritableStream & { write: ReturnType<typeof vi.fn> } {
  return { write: vi.fn() } as unknown as NodeJS.WritableStream & { write: ReturnType<typeof vi.fn> };
}

function state(pid: number, token: string): DaemonState {
  return { pid, port: PORT, token, startedAt: "2026-11-22T00:00:00.000Z", version: VERSION };
}

function healthy(pid: number = DAEMON_PID): DaemonHealth {
  return { pid, port: PORT, version: VERSION, sessionCount: 3, uptimeMs: 5000 };
}

interface Harness {
  deps: DaemonCliDeps;
  home: string;
  env: NodeJS.ProcessEnv;
  statePath: string;
  tokenPath: string;
  stdout: ReturnType<typeof stream>;
  stderr: ReturnType<typeof stream>;
  unref: ReturnType<typeof vi.fn>;
  spawn: ReturnType<typeof vi.fn<(request: SpawnRequest) => DaemonChild>>;
  kill: ReturnType<typeof vi.fn<(pid: number) => void>>;
  waitForHealth: ReturnType<typeof vi.fn<(request: { port: number; token: string; timeoutMs: number }) => Promise<DaemonHealth>>>;
  requestStop: ReturnType<typeof vi.fn<(request: { port: number; token: string }) => Promise<void>>>;
  startHttp: ReturnType<typeof vi.fn<(options: DaemonHttpOptions) => Promise<StartHttpResult>>>;
}

const dirs: string[] = [];

async function harness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "ghf-daemon-cli-"));
  dirs.push(dir);
  const env: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: dir,
    GITHUB_MCP_DAEMON_PORT: String(PORT),
  };
  const statePath = daemonStatePath(env, "linux", dir);
  const tokenPath = daemonTokenPath(env, "linux", dir);
  await mkdir(dirname(statePath), { recursive: true });
  const stdout = stream();
  const stderr = stream();
  const unref = vi.fn();
  const spawn = vi.fn<(request: SpawnRequest) => DaemonChild>().mockImplementation(() => ({ pid: DAEMON_PID, unref }));
  const kill = vi.fn<(pid: number) => void>();
  const waitForHealth = vi
    .fn<(request: { port: number; token: string; timeoutMs: number }) => Promise<DaemonHealth>>()
    .mockImplementation(async () => healthy());
  const requestStop = vi.fn<(request: { port: number; token: string }) => Promise<void>>().mockResolvedValue(undefined);
  const handle: DaemonHttpHandle = { port: PORT, close: vi.fn(async () => {}), sessionCount: () => 0 };
  const startHttp = vi
    .fn<(options: DaemonHttpOptions) => Promise<StartHttpResult>>()
    .mockResolvedValue(handle);
  return {
    home: dir,
    env,
    statePath,
    tokenPath,
    stdout,
    stderr,
    unref,
    spawn,
    kill,
    waitForHealth,
    requestStop,
    startHttp,
    deps: {
      stdout,
      stderr,
      env,
      home: dir,
      platform: "linux",
      spawn,
      kill,
      waitForHealth,
      requestStop,
      startHttp,
    },
  };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("daemon start", () => {
  it("replaces stale files with a fresh token, spawns detached, and waits for health", async () => {
    const h = await harness();
    await writeFile(h.statePath, JSON.stringify(state(DEAD_PID, "stale-token")), "utf8");
    await writeFile(h.tokenPath, "Bearer stale-token", "utf8");

    await expect(runDaemonCommand(["start"], h.deps)).resolves.toBe(0);

    const fresh = await readDaemonState(h.statePath);
    expect(fresh).not.toBeNull();
    expect(fresh?.token).not.toBe("stale-token");
    expect(fresh?.pid).toBe(DAEMON_PID);
    expect(fresh?.port).toBe(PORT);
    expect(fresh?.version).toBe(VERSION);
    await expect(readFile(h.tokenPath, "utf8")).resolves.toBe(`Bearer ${fresh?.token}`);

    expect(h.spawn).toHaveBeenCalledTimes(1);
    const request = h.spawn.mock.calls[0]?.[0];
    expect(request?.command).toBe(process.execPath);
    expect(request?.args).toEqual(["dist/index.js", "serve", "--daemon"]);
    expect(request?.detached).toBe(true);
    expect(request?.stdio).toBe("ignore");
    expect(request?.env["GITHUB_MCP_DAEMON_TOKEN"]).toBe(fresh?.token);
    expect(request?.env["GITHUB_MCP_DAEMON_PORT"]).toBe(String(PORT));
    expect(h.unref).toHaveBeenCalledTimes(1);
    expect(h.waitForHealth).toHaveBeenCalledWith({
      port: PORT,
      token: fresh?.token,
      timeoutMs: 5000,
    });
    expect(h.stdout.write).toHaveBeenCalledWith(
      JSON.stringify({ started: true, pid: DAEMON_PID, port: PORT }) + "\n",
    );
  });

  it("reports a live state as already running without spawning", async () => {
    const h = await harness();
    const live = state(process.pid, "live-token");
    await writeFile(h.statePath, JSON.stringify(live), "utf8");
    await writeFile(h.tokenPath, "Bearer live-token", "utf8");

    await expect(runDaemonCommand(["start"], h.deps)).resolves.toBe(0);

    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.waitForHealth).not.toHaveBeenCalled();
    expect(h.stdout.write).toHaveBeenCalledWith(
      JSON.stringify({ alreadyRunning: true, pid: process.pid, port: PORT }) + "\n",
    );
    await expect(readFile(h.tokenPath, "utf8")).resolves.toBe("Bearer live-token");
  });

  it("kills the spawned child, removes both files, and fails when health never arrives", async () => {
    const h = await harness();
    h.waitForHealth.mockRejectedValueOnce(new Error("health timeout"));

    await expect(runDaemonCommand(["start"], h.deps)).resolves.toBe(1);

    expect(h.kill).toHaveBeenCalledWith(DAEMON_PID);
    await expect(readDaemonState(h.statePath)).resolves.toBeNull();
    await expect(readFile(h.tokenPath, "utf8")).rejects.toThrow();
    expect(h.stderr.write).toHaveBeenCalledWith(expect.stringContaining("health timeout"));
  });

  it("records the spawned child PID in the state file before waiting for health", async () => {
    const h = await harness();
    h.waitForHealth.mockImplementationOnce(async () => {
      const beforeHealth = await readDaemonState(h.statePath);
      expect(beforeHealth?.pid).toBe(DAEMON_PID);
      return healthy();
    });

    await expect(runDaemonCommand(["start"], h.deps)).resolves.toBe(0);

    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it("defaults the port to 41873 when the env var is absent", async () => {
    const h = await harness();
    delete h.env["GITHUB_MCP_DAEMON_PORT"];

    await expect(runDaemonCommand(["start"], h.deps)).resolves.toBe(0);

    expect(h.waitForHealth).toHaveBeenCalledWith(
      expect.objectContaining({ port: DEFAULT_DAEMON_PORT }),
    );
    expect(h.stdout.write).toHaveBeenCalledWith(
      JSON.stringify({ started: true, pid: DAEMON_PID, port: DEFAULT_DAEMON_PORT }) + "\n",
    );
  });
});

describe("daemon status", () => {
  it("reports running false and removes a stale state and token file", async () => {
    const h = await harness();
    await writeFile(h.statePath, JSON.stringify(state(DEAD_PID, "stale-token")), "utf8");
    await writeFile(h.tokenPath, "Bearer stale-token", "utf8");

    await expect(runDaemonCommand(["status"], h.deps)).resolves.toBe(0);

    expect(h.stdout.write).toHaveBeenCalledWith('{"running":false}\n');
    expect(h.waitForHealth).not.toHaveBeenCalled();
    await expect(readDaemonState(h.statePath)).resolves.toBeNull();
    await expect(readFile(h.tokenPath, "utf8")).rejects.toThrow();
  });

  it("reports not running and cleans up when the health PID differs from the state", async () => {
    const h = await harness();
    await writeFile(h.statePath, JSON.stringify(state(process.pid, "live-token")), "utf8");
    await writeFile(h.tokenPath, "Bearer live-token", "utf8");
    h.waitForHealth.mockResolvedValueOnce(healthy(9999));

    await expect(runDaemonCommand(["status"], h.deps)).resolves.toBe(0);

    expect(h.stdout.write).toHaveBeenCalledWith('{"running":false}\n');
    await expect(readDaemonState(h.statePath)).resolves.toBeNull();
    await expect(readFile(h.tokenPath, "utf8")).rejects.toThrow();
  });

  it("reports the PID, port, version, uptime and session count when healthy", async () => {
    const h = await harness();
    await writeFile(h.statePath, JSON.stringify(state(process.pid, "live-token")), "utf8");
    await writeFile(h.tokenPath, "Bearer live-token", "utf8");

    await expect(runDaemonCommand(["status"], h.deps)).resolves.toBe(0);

    expect(h.waitForHealth).toHaveBeenCalledWith({
      port: PORT,
      token: "live-token",
      timeoutMs: 5000,
    });
    expect(h.stdout.write).toHaveBeenCalledWith(
      '{"running":true,"pid":' + String(process.pid) + ',"port":' + String(PORT) +
        ',"version":"' + VERSION + '","sessionCount":3,"uptimeMs":5000}\n',
    );
  });
});

describe("daemon stop", () => {
  it("posts the stop route with the bearer token and removes both files", async () => {
    const h = await harness();
    await writeFile(h.statePath, JSON.stringify(state(process.pid, "live-token")), "utf8");
    await writeFile(h.tokenPath, "Bearer live-token", "utf8");

    await expect(runDaemonCommand(["stop"], h.deps)).resolves.toBe(0);

    expect(h.requestStop).toHaveBeenCalledWith({ port: PORT, token: "live-token" });
    expect(h.stdout.write).toHaveBeenCalledWith('{"stopped":true}\n');
    await expect(readDaemonState(h.statePath)).resolves.toBeNull();
    await expect(readFile(h.tokenPath, "utf8")).rejects.toThrow();
  });
});

describe("serve --daemon", () => {
  it("starts the HTTP listener from the injected token and port", async () => {
    const h = await harness();
    h.env["GITHUB_MCP_DAEMON_TOKEN"] = "daemon-token";
    await writeFile(h.statePath, JSON.stringify(state(DAEMON_PID, "daemon-token")), "utf8");
    await writeFile(h.tokenPath, "Bearer daemon-token", "utf8");

    await expect(runServeDaemon(h.deps)).resolves.toBe(0);

    expect(h.startHttp).toHaveBeenCalledTimes(1);
    const options = h.startHttp.mock.calls[0]?.[0];
    expect(options).toMatchObject({ env: h.env, token: "daemon-token", port: PORT, version: VERSION });
    expect(options?.["onStop"]).toBeTypeOf("function");
    await (options?.["onStop"] as () => Promise<void>)();
    await expect(readDaemonState(h.statePath)).resolves.toBeNull();
    await expect(readFile(h.tokenPath, "utf8")).rejects.toThrow();
  });

  it("rejects a missing token without starting a listener", async () => {
    const h = await harness();
    await expect(runServeDaemon(h.deps)).resolves.toBe(2);
    expect(h.startHttp).not.toHaveBeenCalled();
    expect(h.stderr.write).toHaveBeenCalledWith(expect.stringContaining("GITHUB_MCP_DAEMON_TOKEN"));
  });
});

describe("ensureDaemon", () => {
  it("returns a live state without spawning", async () => {
    const h = await harness();
    const live = state(process.pid, "live-token");
    await writeFile(h.statePath, JSON.stringify(live), "utf8");

    await expect(
      ensureDaemon({ env: h.env, home: h.home, platform: "linux", deps: h.deps }),
    ).resolves.toEqual(live);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("starts a daemon when no state file exists and returns the new state", async () => {
    const h = await harness();

    const result = await ensureDaemon({ env: h.env, home: h.home, platform: "linux", deps: h.deps });

    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(result.pid).toBe(DAEMON_PID);
    expect(result.port).toBe(PORT);
    expect(result.version).toBe(VERSION);
    expect(await readDaemonState(h.statePath)).toEqual(result);
  });
});
