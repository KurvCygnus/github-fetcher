import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface DaemonState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  version: string;
}

function isDaemonState(value: unknown): value is DaemonState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["pid"] === "number" &&
    typeof record["port"] === "number" &&
    typeof record["token"] === "string" &&
    typeof record["startedAt"] === "string" &&
    typeof record["version"] === "string"
  );
}

export async function readDaemonState(path: string): Promise<DaemonState | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isDaemonState(parsed) ? parsed : null;
}

export async function writeDaemonState(path: string, state: DaemonState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  //* writeFile's mode only applies at creation, so a leftover state file could
  //* stay world-readable. chmod tightens it; Windows ignores the read/write bits
  //* and can reject the call, which is non-fatal under the profile's ACLs.
  try {
    await chmod(path, 0o600);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

export async function removeDaemonState(path: string): Promise<void> {
  await unlink(path);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    //* ESRCH means the process is gone. Other failures (EPERM) mean it exists
    //* but is inaccessible; call it alive so a stale file is not overwritten.
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}
