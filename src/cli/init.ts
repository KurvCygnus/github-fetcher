import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { createTokenResolver } from "../core/auth.js";
import { loadConfig } from "../core/config.js";
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

export interface InitOptions {
  clients?: string[] | undefined;
  all?: boolean | undefined;
  name: string;
  nameExplicit?: boolean | undefined;
  dryRun: boolean;
}

export type SelectFn = (
  items: readonly TuiItem[],
  deps: TuiDeps,
  preselected?: readonly string[],
) => Promise<string[] | null>;

export interface InitDeps {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  home?: string | undefined;
  cwd?: string | undefined;
  interactive?: boolean | undefined;
  input?: NodeJS.ReadStream | undefined;
  //? Injection seam for the TUI: tests exercise cancel/confirm without a real terminal.
  select?: SelectFn | undefined;
}

export type InitAction =
  | "created"
  | "updated"
  | "skipped"
  | "not-installed"
  | "error"
  | "would-create"
  | "would-update"
  | "would-skip"
  | "cancelled";

export interface InitResult {
  client?: string | undefined;
  path?: string | undefined;
  action: InitAction;
  backup?: string | undefined;
  entry?: unknown;
  message?: string | undefined;
  hint?: string | undefined;
}

interface SelectedAdapter {
  adapter: ClientAdapter;
  explicit: boolean;
}

export const INIT_USAGE = "Usage: github-fetcher init [--client id,id] [--all] [--name github] [--dry-run]";

export function parseInitArgs(argv: string[]): InitOptions {
  const clients: string[] = [];
  let all = false;
  let name = DEFAULT_NAME;
  let nameExplicit = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index++) {
    //? The loop bound guarantees the token exists; noUncheckedIndexedAccess cannot see it.
    const token = argv[index] as string;
    if (token === "--all") {
      all = true;
      continue;
    }
    if (token === "--dry-run") {
      dryRun = true;
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
  return { clients, all, name, nameExplicit, dryRun };
}

function usageError(deps: InitDeps, message: string): number {
  deps.stderr.write(`error: ${message}\n${INIT_USAGE}\n`);
  return 2;
}

function selectByFlags(requested: readonly string[], all: boolean): SelectedAdapter[] {
  const named = new Set(requested);
  //* No ids and no --all (for example bare --dry-run) sweeps every adapter without consent,
  //* so those adapters stay explicit: false and undetected ones are reported not-installed.
  return ADAPTERS
    .filter((adapter) => all || named.size === 0 || named.has(adapter.id))
    .map((adapter) => ({ adapter, explicit: named.has(adapter.id) }));
}

async function selectInteractively(
  home: string,
  cwd: string,
  deps: InitDeps,
): Promise<SelectedAdapter[] | null> {
  const detected = new Set(
    ADAPTERS
      .filter((adapter) => adapter.candidates(home, cwd).some((path) => existsSync(path)))
      .map((adapter) => adapter.id),
  );
  const items: TuiItem[] = ADAPTERS.map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    note: detected.has(adapter.id) ? "detected" : "not detected, will create",
  }));
  const select = deps.select ?? selectFromMenu;
  const picked = await select(
    items,
    { input: deps.input ?? process.stdin, output: deps.stderr },
    [...detected],
  );
  if (picked === null) return null;
  const pickedIds = new Set(picked);
  return ADAPTERS
    .filter((adapter) => pickedIds.has(adapter.id))
    .map((adapter) => ({ adapter, explicit: true }));
}

interface ApplyContext {
  name: string;
  nameExplicit: boolean;
  dryRun: boolean;
  home: string;
  cwd: string;
}

async function createFresh(adapter: ClientAdapter, path: string, context: ApplyContext): Promise<InitResult> {
  const entry = adapter.entry(context.name);
  //* Fresh configs arrive as undefined; every adapter's merge treats that as an empty target.
  const merged = adapter.merge(undefined, context.name, entry);
  if (context.dryRun) return { client: adapter.id, path, action: "would-create", entry };
  await mkdir(dirname(path), { recursive: true });
  await adapter.write(path, merged);
  return { client: adapter.id, path, action: "created" };
}

async function mergeTarget(adapter: ClientAdapter, path: string, context: ApplyContext): Promise<InitResult> {
  const raw = await readFile(path, "utf8");
  const existing = adapter.load(path);
  const name = context.nameExplicit ? context.name : adapter.resolveName(existing, context.name);
  const entry = adapter.entry(name);
  const merged = adapter.merge(existing, name, entry);
  if (adapter.serialize(merged) === raw) {
    return { client: adapter.id, path, action: context.dryRun ? "would-skip" : "skipped" };
  }
  const existed = adapter.hasEntry(existing, name);
  if (context.dryRun) {
    return { client: adapter.id, path, action: existed ? "would-update" : "would-create", entry };
  }
  //* The backup is written before the target changes; a failed write must still leave the
  //* original recoverable next to it.
  const backup = await backupFile(path, raw);
  await adapter.write(path, merged);
  return { client: adapter.id, path, action: existed ? "updated" : "created", backup };
}

async function applyAdapter(
  adapter: ClientAdapter,
  explicit: boolean,
  context: ApplyContext,
): Promise<InitResult> {
  let path = "";
  try {
    const candidates = adapter.candidates(context.home, context.cwd);
    path = candidates.find((candidate) => existsSync(candidate)) ?? "";
    if (path === "") {
      if (!explicit) {
        return {
          client: adapter.id,
          path: candidates[0] ?? "",
          action: "not-installed",
          hint: `no config found; pass --client ${adapter.id} to create one`,
        };
      }
      path = candidates[0] ?? "";
      if (path === "") throw new Error("adapter has no candidate paths");
      return await createFresh(adapter, path, context);
    }
    return await mergeTarget(adapter, path, context);
  } catch (error) {
    return { client: adapter.id, path, action: "error", message: describeError(error) };
  }
}

async function writeAuthStatus(stderr: NodeJS.WritableStream): Promise<void> {
  const config = loadConfig(process.env);
  const auth = createTokenResolver(config);
  const token = await auth.get();
  stderr.write(`auth: ${token ? "token" : "anonymous"}\n`);
}

export async function runInit(arg: InitOptions | string[], deps: InitDeps): Promise<number> {
  //? Help wins over every validation; the parser would otherwise reject the flag as unknown.
  if (Array.isArray(arg) && (arg.includes("--help") || arg.includes("-h"))) {
    deps.stdout.write(`${INIT_USAGE}\n`);
    return 0;
  }

  let options: InitOptions;
  try {
    options = Array.isArray(arg) ? parseInitArgs(arg) : arg;
    validateName(options.name);
    validateClients(options.clients ?? []);
  } catch (error) {
    if (error instanceof CliUsageError) return usageError(deps, error.message);
    throw error;
  }

  const requested = uniqueIds(options.clients ?? []);
  const all = options.all === true;
  const dryRun = options.dryRun === true;
  const interactive = deps.interactive ?? process.stdin.isTTY === true;
  const home = deps.home ?? homedir();
  const cwd = deps.cwd ?? process.cwd();

  let selected: SelectedAdapter[];
  if (requested.length > 0 || all || dryRun) {
    selected = selectByFlags(requested, all);
  } else if (interactive) {
    const picked = await selectInteractively(home, cwd, deps);
    if (picked === null) {
      deps.stdout.write(`${JSON.stringify([{ action: "cancelled" }])}\n`);
      return 0;
    }
    selected = picked;
  } else {
    return usageError(deps, "init needs --client or --all in a non-interactive session");
  }

  const context: ApplyContext = {
    name: options.name,
    nameExplicit: options.nameExplicit === true,
    dryRun,
    home,
    cwd,
  };
  const results: InitResult[] = [];
  for (const { adapter, explicit } of selected) {
    results.push(await applyAdapter(adapter, explicit, context));
  }
  deps.stdout.write(`${JSON.stringify(results)}\n`);
  await writeAuthStatus(deps.stderr);
  return 0;
}
