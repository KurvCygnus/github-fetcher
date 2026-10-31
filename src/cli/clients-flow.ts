import { writeFile } from "node:fs/promises";
import { CliUsageError } from "./argv.js";
import { ADAPTERS } from "./clients/index.js";

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
export async function backupFile(path: string, raw: string, now: Date = new Date()): Promise<string> {
  const base = `${path}.bak.${stamp(now)}`;
  for (let suffix = 0; ; suffix++) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    try {
      await writeFile(candidate, raw, { encoding: "utf8", flag: "wx" });
      return candidate;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
}
