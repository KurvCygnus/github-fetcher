import { stat, writeFile } from "node:fs/promises";
import { CliUsageError } from "./argv.js";
import { ADAPTERS } from "./clients/index.js";
import type { ClientAdapter } from "./clients/index.js";

export const DEFAULT_NAME = "github";

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new CliUsageError(
      `invalid --name: ${JSON.stringify(name)} (allowed: letters, digits, dot, underscore, hyphen)`,
    );
  }
}

export function validateClients(ids: readonly string[]): void {
  for (const id of ids) {
    if (!ADAPTERS.some((adapter) => adapter.id === id)) {
      throw new CliUsageError(`unknown client: ${id} (known: ${ADAPTERS.map((adapter) => adapter.id).join(", ")})`);
    }
  }
}

export function parseClientValue(raw: string): string[] {
  const ids = raw.split(",").map((part) => part.trim()).filter((part) => part !== "");
  if (ids.length === 0) throw new CliUsageError("--client requires at least one client id");
  validateClients(ids);
  return ids;
}

export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

//* An explicit --name is an exact instruction; otherwise the adapter reuses the key that
//* already belongs to this package, or reports a foreign-key conflict as null.
export function resolveTargetName(
  adapter: ClientAdapter,
  existing: unknown,
  preferred: string,
  explicit: boolean,
): string | null {
  return adapter.resolveName(existing, preferred, explicit);
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stamp(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "EEXIST";
}

//* The exclusive-create flag is load-bearing: a same-second rerun must never truncate the
//* previous backup. A collision walks a numeric suffix until a free name is found.
//* The source mode is copied when it can be read; a missing source (a unit-test caller) is
//* not a reason to refuse writing the backup.
export async function backupFile(path: string, raw: string, now: Date = new Date()): Promise<string> {
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    mode = undefined;
  }
  const base = `${path}.bak.${stamp(now)}`;
  for (let suffix = 0; ; suffix++) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    try {
      await writeFile(candidate, raw, {
        encoding: "utf8",
        flag: "wx",
        ...(mode === undefined ? {} : { mode }),
      });
      return candidate;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
}
