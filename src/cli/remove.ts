import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { CliUsageError } from "./argv.js";
import { ADAPTERS } from "./clients/index.js";
import type { ClientAdapter } from "./clients/index.js";
import {
  DEFAULT_NAME,
  backupFile,
  describeError,
  parseClientValue,
  uniqueIds,
  validateClients,
  validateName,
} from "./clients-flow.js";
import { selectFromMenu } from "./tui.js";
import type { TuiDeps, TuiItem } from "./tui.js";

export interface RemoveOptions {
  clients?: string[] | undefined;
  all?: boolean | undefined;
  name: string;
  nameExplicit?: boolean | undefined;
}

export type SelectFn = (
  items: readonly TuiItem[],
  deps: TuiDeps,
  preselected?: readonly string[],
) => Promise<string[] | null>;

export interface RemoveDeps {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  home?: string | undefined;
  cwd?: string | undefined;
  interactive?: boolean | undefined;
  input?: NodeJS.ReadStream | undefined;
  //? Injection seam for the TUI: tests exercise cancel/confirm without a real terminal.
  select?: SelectFn | undefined;
}

export type RemoveAction = "removed" | "skipped" | "not-installed" | "error" | "cancelled";

export interface RemoveResult {
  client?: string | undefined;
  path?: string | undefined;
  action: RemoveAction;
  backup?: string | undefined;
  message?: string | undefined;
}

export const REMOVE_USAGE = "Usage: github-fetcher remove [--client id,id] [--all] [--name github]";

export function parseRemoveArgs(argv: string[]): RemoveOptions {
  const clients: string[] = [];
  let all = false;
  let name = DEFAULT_NAME;
  let nameExplicit = false;

  for (let index = 0; index < argv.length; index++) {
    //? The loop bound guarantees the token exists; noUncheckedIndexedAccess cannot see it.
    const token = argv[index] as string;
    if (token === "--all") {
      all = true;
      continue;
    }
    if (token === "--client" || token === "--name") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(`flag ${token} requires a value`);
      }
      if (token === "--client") {
        clients.push(...parseClientValue(value));
      } else {
        name = value;
        nameExplicit = true;
      }
      index += 1;
      continue;
    }
    if (token.startsWith("--")) throw new CliUsageError(`unknown flag: ${token}`);
    throw new CliUsageError(`unexpected argument: ${token}`);
  }

  validateName(name);
  return { clients, all, name, nameExplicit };
}

function usageError(deps: RemoveDeps, message: string): number {
  deps.stderr.write(`error: ${message}\n${REMOVE_USAGE}\n`);
  return 2;
}

function findExisting(adapter: ClientAdapter, home: string, cwd: string): string | undefined {
  return adapter.candidates(home, cwd).find((candidate) => existsSync(candidate));
}

interface RemoveTarget {
  name: string;
  nameExplicit: boolean;
  home: string;
  cwd: string;
}

function targetContainsEntry(adapter: ClientAdapter, target: RemoveTarget): boolean {
  const path = findExisting(adapter, target.home, target.cwd);
  if (path === undefined) return false;
  try {
    const existing = adapter.load(path);
    const name = target.nameExplicit ? target.name : adapter.resolveName(existing, target.name);
    return adapter.hasEntry(existing, name);
  } catch {
    //* An unreadable target cannot be offered as removable; the flag path reports the error.
    return false;
  }
}

async function removeFromAdapter(adapter: ClientAdapter, target: RemoveTarget): Promise<RemoveResult> {
  let path = "";
  try {
    const candidates = adapter.candidates(target.home, target.cwd);
    path = candidates.find((candidate) => existsSync(candidate)) ?? "";
    if (path === "") {
      return { client: adapter.id, path: candidates[0] ?? "", action: "not-installed" };
    }
    const raw = await readFile(path, "utf8");
    const existing = adapter.load(path);
    const name = target.nameExplicit ? target.name : adapter.resolveName(existing, target.name);
    if (!adapter.hasEntry(existing, name)) {
      return { client: adapter.id, path, action: "skipped" };
    }
    const removed = adapter.remove(existing, name);
    //* The backup completes before the target changes, so a failed write still leaves the
    //* original recoverable next to it.
    const backup = await backupFile(path, raw);
    //* Removing the only entry must not leave an empty container behind; the backup still
    //* preserves the original file.
    if (adapter.isEmpty(removed)) await unlink(path);
    else await adapter.write(path, removed);
    return { client: adapter.id, path, action: "removed", backup };
  } catch (error) {
    return { client: adapter.id, path, action: "error", message: describeError(error) };
  }
}

export async function runRemove(arg: RemoveOptions | string[], deps: RemoveDeps): Promise<number> {
  //? Help wins over every validation; the parser would otherwise reject the flag as unknown.
  if (Array.isArray(arg) && (arg.includes("--help") || arg.includes("-h"))) {
    deps.stdout.write(`${REMOVE_USAGE}\n`);
    return 0;
  }

  let options: RemoveOptions;
  try {
    options = Array.isArray(arg) ? parseRemoveArgs(arg) : arg;
    validateName(options.name);
    validateClients(options.clients ?? []);
  } catch (error) {
    if (error instanceof CliUsageError) return usageError(deps, error.message);
    throw error;
  }

  const requested = uniqueIds(options.clients ?? []);
  const all = options.all === true;
  const interactive = deps.interactive ?? process.stdin.isTTY === true;
  const home = deps.home ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  const target: RemoveTarget = {
    name: options.name,
    nameExplicit: options.nameExplicit === true,
    home,
    cwd,
  };

  let selected: ClientAdapter[];
  if (requested.length > 0 || all) {
    const named = new Set(requested);
    selected = ADAPTERS.filter((adapter) => all || named.has(adapter.id));
  } else if (interactive) {
    const matches = ADAPTERS.filter((adapter) => targetContainsEntry(adapter, target));
    if (matches.length === 0) {
      //* Nothing to offer: the empty array is the complete answer, so the TUI never starts.
      deps.stdout.write("[]\n");
      return 0;
    }
    const items: TuiItem[] = matches.map((adapter) => ({ id: adapter.id, label: adapter.label }));
    //* Every listed adapter already contains the entry, so all of them start selected.
    const preselected = matches.map((adapter) => adapter.id);
    const select = deps.select ?? selectFromMenu;
    const picked = await select(
      items,
      { input: deps.input ?? process.stdin, output: deps.stderr },
      preselected,
    );
    if (picked === null) {
      deps.stdout.write(`${JSON.stringify([{ action: "cancelled" }])}\n`);
      return 0;
    }
    const pickedIds = new Set(picked);
    selected = matches.filter((adapter) => pickedIds.has(adapter.id));
  } else {
    return usageError(deps, "remove needs --client or --all in a non-interactive session");
  }

  const results: RemoveResult[] = [];
  for (const adapter of selected) {
    results.push(await removeFromAdapter(adapter, target));
  }
  deps.stdout.write(`${JSON.stringify(results)}\n`);
  return 0;
}
