import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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
  //* The mode applies at file creation on POSIX; Windows ignores it, which is
  //* non-fatal because the user profile's ACLs guard the file there.
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
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
