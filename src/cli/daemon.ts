import { spawn as spawnProcess } from "node:child_process";
import { VERSION } from "../core/version.js";
import { newBearerToken, removeDaemonToken, writeDaemonToken } from "../daemon/auth.js";
import { startDaemonHttp } from "../daemon/http.js";
import type { DaemonHttpHandle, DaemonHttpOptions } from "../daemon/http.js";
import { daemonStatePath, daemonTokenPath } from "../daemon/paths.js";
import { pidAlive, readDaemonState, removeDaemonState, writeDaemonState } from "../daemon/state.js";
import type { DaemonState } from "../daemon/state.js";

export const DEFAULT_DAEMON_PORT = 41873;

const HEALTH_TIMEOUT_MS = 5000;
const HEALTH_POLL_MS = 100;
const HEALTH_REQUEST_TIMEOUT_MS = 1500;
const STOP_REQUEST_TIMEOUT_MS = 3000;

export type StartHttpResult = DaemonHttpHandle;

//* This mirrors the full /health payload so status can cross-check the PID and
//* report the daemon's own port and uptime without consulting the state file.
export interface DaemonHealth {
  pid: number;
  port: number;
  version: string;
  sessionCount: number;
  uptimeMs: number;
}

export interface DaemonChild {
  pid?: number | undefined;
  unref(): void;
}

export interface SpawnRequest {
  command: string;
  args: string[];
  detached: boolean;
  stdio: "ignore";
  env: NodeJS.ProcessEnv;
}

export interface HealthRequest {
  port: number;
  token: string;
  timeoutMs: number;
}

export interface StopRequest {
  port: number;
  token: string;
}

export interface DaemonCliDeps {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  spawn?: (request: SpawnRequest) => DaemonChild;
  kill?: (pid: number) => void;
  waitForHealth?: (request: HealthRequest) => Promise<DaemonHealth>;
  requestStop?: (request: StopRequest) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  startHttp?: (options: DaemonHttpOptions) => Promise<DaemonHttpHandle>;
}

export interface EnsureDaemonOptions {
  env: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  //* The seam keeps ensureDaemon's own tests offline while preserving the
  //* three-field call shape.
  deps?: Omit<DaemonCliDeps, "env" | "home" | "platform">;
}

interface ResolvedDeps {
  env: NodeJS.ProcessEnv;
  statePath: string;
  tokenPath: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  spawn: (request: SpawnRequest) => DaemonChild;
  kill: (pid: number) => void;
  waitForHealth: (request: HealthRequest) => Promise<DaemonHealth>;
  requestStop: (request: StopRequest) => Promise<void>;
  startHttp: (options: DaemonHttpOptions) => Promise<DaemonHttpHandle>;
}

function resolveDeps(deps: DaemonCliDeps): ResolvedDeps {
  const env = deps.env ?? process.env;
  return {
    env,
    statePath: daemonStatePath(env, deps.platform, deps.home),
    tokenPath: daemonTokenPath(env, deps.platform, deps.home),
    stdout: deps.stdout,
    stderr: deps.stderr,
    spawn: deps.spawn ?? realSpawn,
    kill: deps.kill ?? realKill,
    waitForHealth: deps.waitForHealth ?? ((request) => realWaitForHealth(request, deps.sleep ?? realSleep)),
    requestStop: deps.requestStop ?? realRequestStop,
    startHttp: deps.startHttp ?? startDaemonHttp,
  };
}

function realSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function realSpawn(request: SpawnRequest): DaemonChild {
  return spawnProcess(request.command, request.args, {
    detached: request.detached,
    stdio: request.stdio,
    env: request.env,
  });
}

function realKill(pid: number): void {
  //* A child that already exited needs no signal; ESRCH is the expected race.
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function asHealth(value: unknown): DaemonHealth | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const pid = record["pid"];
  const port = record["port"];
  const version = record["version"];
  const sessionCount = record["sessionCount"];
  const uptimeMs = record["uptimeMs"];
  if (
    typeof pid !== "number" ||
    typeof port !== "number" ||
    typeof version !== "string" ||
    typeof sessionCount !== "number" ||
    typeof uptimeMs !== "number"
  ) return null;
  return { pid, port, version, sessionCount, uptimeMs };
}

async function realWaitForHealth(request: HealthRequest, sleep: (ms: number) => Promise<void>): Promise<DaemonHealth> {
  const deadline = Date.now() + request.timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${request.port}/health`, {
        headers: { authorization: `Bearer ${request.token}` },
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const health = asHealth(await response.json());
        if (health !== null) return health;
      }
    } catch {
      //* A refused connection during startup is expected; retry until the deadline.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`daemon health check timed out after ${request.timeoutMs}ms`);
    await sleep(Math.min(HEALTH_POLL_MS, remaining));
  }
}

async function realRequestStop(request: StopRequest): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${request.port}/daemon/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${request.token}` },
    signal: AbortSignal.timeout(STOP_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`daemon stop failed with HTTP ${response.status}`);
}

function portFor(env: NodeJS.ProcessEnv): number {
  const raw = env["GITHUB_MCP_DAEMON_PORT"];
  if (raw === undefined || raw === "") return DEFAULT_DAEMON_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`GITHUB_MCP_DAEMON_PORT must be a port number, got ${raw}`);
  }
  return port;
}

function isLive(pid: number): boolean {
  //* Zero is the pre-spawn placeholder written before the child exists.
  return pid > 0 && pidAlive(pid);
}

async function removeFiles(statePath: string, tokenPath: string): Promise<void> {
  await Promise.all([
    removeDaemonState(statePath).catch(ignoreMissing),
    removeDaemonToken(tokenPath).catch(ignoreMissing),
  ]);
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function startDaemon(d: ResolvedDeps): Promise<number> {
  const existing = await readDaemonState(d.statePath);
  if (existing !== null) {
    if (isLive(existing.pid)) {
      let confirmed = false;
      let staleReason = "unknown health failure";
      try {
        const health = asHealth(
          await d.waitForHealth({ port: existing.port, token: existing.token, timeoutMs: HEALTH_TIMEOUT_MS }),
        );
        if (health === null) {
          staleReason = "malformed health payload";
        } else if (health.pid !== existing.pid) {
          staleReason = `health pid ${health.pid} does not match state pid ${existing.pid}`;
        } else {
          confirmed = true;
        }
      } catch (error) {
        staleReason = `health check failed: ${failureMessage(error)}`;
      }
      if (confirmed) {
        d.stdout.write(JSON.stringify({ alreadyRunning: true, pid: existing.pid, port: existing.port }) + "\n");
        return 0;
      }
      //* A live PID that cannot answer health holds a port and a token file but
      //* serves nothing; report why and drop the state before starting fresh.
      d.stderr.write(`stale daemon state removed: ${staleReason}\n`);
    }
    await removeFiles(d.statePath, d.tokenPath);
  }

  let port: number;
  let token: string;
  let state: DaemonState;
  let spawnedPid: number | undefined;
  try {
    port = portFor(d.env);
    token = newBearerToken();
    state = { pid: 0, port, token, startedAt: new Date().toISOString(), version: VERSION };
    //* Both files exist before spawn so a child that checks in immediately sees
    //* its token, and a health failure can be cleaned up by removing them.
    await writeDaemonState(d.statePath, state);
    await writeDaemonToken(d.tokenPath, token);

    const childEnv = {
      ...d.env,
      GITHUB_MCP_DAEMON_TOKEN: token,
      GITHUB_MCP_DAEMON_PORT: String(port),
    };
    const child = d.spawn({
      command: process.execPath,
      args: ["dist/index.js", "serve", "--daemon"],
      detached: true,
      stdio: "ignore",
      env: childEnv,
    });
    child.unref();

    //* The pre-spawn file has a placeholder PID; rewrite it with the real child
    //* PID now that spawn has returned, keeping the same state shape.
    spawnedPid = child.pid;
    if (spawnedPid !== undefined && spawnedPid > 0) {
      state = { ...state, pid: spawnedPid };
      await writeDaemonState(d.statePath, state);
    }

    const health = await d.waitForHealth({ port, token, timeoutMs: HEALTH_TIMEOUT_MS });
    const finalPid = health.pid > 0 ? health.pid : (child.pid ?? 0);
    state = { ...state, pid: finalPid };
    await writeDaemonState(d.statePath, state);
    const confirmed = await readDaemonState(d.statePath);
    if (confirmed === null || !isLive(confirmed.pid)) throw new Error("daemon state missing after start");
  } catch (error) {
    //* Signal the child before cleanup so a survivor cannot keep serving with
    //* the token that is about to be removed.
    if (spawnedPid !== undefined && spawnedPid > 0) {
      try {
        d.kill(spawnedPid);
      } catch {
        //* File cleanup must still happen if signalling the child fails.
      }
    }
    await removeFiles(d.statePath, d.tokenPath);
    d.stderr.write(`daemon start failed: ${failureMessage(error)}\n`);
    return 1;
  }

  d.stdout.write(JSON.stringify({ started: true, pid: state.pid, port }) + "\n");
  return 0;
}

async function stopDaemon(d: ResolvedDeps): Promise<number> {
  const state = await readDaemonState(d.statePath);
  if (state === null) {
    d.stdout.write('{"stopped":false}\n');
    return 0;
  }
  try {
    await d.requestStop({ port: state.port, token: state.token });
  } catch (error) {
    d.stderr.write(`daemon stop failed: ${failureMessage(error)}\n`);
    return 1;
  }
  await removeFiles(d.statePath, d.tokenPath);
  d.stdout.write('{"stopped":true}\n');
  return 0;
}

async function statusDaemon(d: ResolvedDeps): Promise<number> {
  const state = await readDaemonState(d.statePath);
  if (state === null || !isLive(state.pid)) {
    if (state !== null) await removeFiles(d.statePath, d.tokenPath);
    d.stdout.write('{"running":false}\n');
    return 0;
  }

  let health: DaemonHealth;
  try {
    health = await d.waitForHealth({ port: state.port, token: state.token, timeoutMs: HEALTH_TIMEOUT_MS });
  } catch {
    await removeFiles(d.statePath, d.tokenPath);
    d.stdout.write('{"running":false}\n');
    return 0;
  }
  if (health.pid !== state.pid) {
    await removeFiles(d.statePath, d.tokenPath);
    d.stdout.write('{"running":false}\n');
    return 0;
  }

  const status = {
    running: true,
    pid: state.pid,
    port: state.port,
    version: health.version,
    sessionCount: health.sessionCount,
    uptimeMs: health.uptimeMs,
  };
  d.stdout.write(JSON.stringify(status) + "\n");
  return 0;
}

export async function runDaemonCommand(argv: string[], deps: DaemonCliDeps): Promise<number> {
  const [action] = argv;
  const d = resolveDeps(deps);
  if (action === "start") return startDaemon(d);
  if (action === "stop") return stopDaemon(d);
  if (action === "status") return statusDaemon(d);
  d.stderr.write("Usage: github-fetcher daemon <start|stop|status>\n");
  return 2;
}

export async function runServeDaemon(deps: DaemonCliDeps): Promise<number> {
  const d = resolveDeps(deps);
  const token = d.env["GITHUB_MCP_DAEMON_TOKEN"];
  if (token === undefined || token === "") {
    d.stderr.write("serve --daemon requires GITHUB_MCP_DAEMON_TOKEN\n");
    return 2;
  }
  let port: number;
  try {
    port = portFor(d.env);
  } catch (error) {
    d.stderr.write(`${failureMessage(error)}\n`);
    return 2;
  }

  let handle: DaemonHttpHandle | undefined;
  const onStop = async (): Promise<void> => {
    await removeFiles(d.statePath, d.tokenPath);
    await handle?.close();
  };
  handle = await d.startHttp({ env: d.env, token, port, version: VERSION, onStop });
  //* The listener holds the event loop open, so returning here keeps the daemon
  //* resident without an extra await that tests would have to unblock.
  return 0;
}

export async function ensureDaemon(options: EnsureDaemonOptions): Promise<DaemonState> {
  const deps: DaemonCliDeps = {
    stdout: process.stdout,
    stderr: process.stderr,
    env: options.env,
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.deps ?? {}),
  };
  const d = resolveDeps(deps);
  const state = await readDaemonState(d.statePath);
  if (state !== null && isLive(state.pid)) return state;

  const code = await startDaemon(d);
  if (code !== 0) throw new Error("daemon failed to start");
  const started = await readDaemonState(d.statePath);
  if (started === null || !isLive(started.pid)) throw new Error("daemon state missing after start");
  return started;
}
