import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { Writable } from "node:stream";
import { createTokenResolver } from "../core/auth.js";
import { loadConfig } from "../core/config.js";
import { daemonTokenPath } from "../daemon/paths.js";
import { CliUsageError } from "./argv.js";
import { DEFAULT_DAEMON_PORT, ensureDaemon } from "./daemon.js";
import { ADAPTERS } from "./clients/index.js";
import type { ClientAdapter } from "./clients/index.js";
import {
  DEFAULT_NAME,
  backupFile,
  describeError,
  parseClientValue,
  resolveTargetName,
  uniqueIds,
  validateClients,
  validateName,
} from "./clients-flow.js";
import { createClackAdapter } from "./prompts.js";
import type { PromptAdapter } from "./prompts.js";

export interface InitOptions {
  clients?: string[] | undefined;
  all?: boolean | undefined;
  name: string;
  nameExplicit?: boolean | undefined;
  dryRun: boolean;
  transport?: "stdio" | "http" | undefined;
}

export interface InitDeps {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  home?: string | undefined;
  cwd?: string | undefined;
  interactive?: boolean | undefined;
  input?: NodeJS.ReadStream | undefined;
  //? Injection seam for the wizard: tests drive the full prompt sequence without a terminal.
  prompts?: PromptAdapter | undefined;
  //* Both seams keep the HTTP path offline: no daemon spawn and no real adapter set
  //* is required to verify the config that would be written.
  ensureDaemon?: typeof ensureDaemon | undefined;
  adapters?: readonly ClientAdapter[] | undefined;
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
  name?: string | undefined;
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

export const INIT_USAGE = "Usage: github-fetcher init [--client id,id] [--all] [--name github] [--dry-run] [--transport stdio|http]";

export function parseInitArgs(argv: string[]): InitOptions {
  const clients: string[] = [];
  let all = false;
  let name = DEFAULT_NAME;
  let nameExplicit = false;
  let dryRun = false;
  let transport: "stdio" | "http" = "stdio";

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
    if (token === "--transport") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliUsageError(`flag ${token} requires a value`);
      }
      if (value !== "stdio" && value !== "http") {
        throw new CliUsageError(`invalid --transport: ${value}`);
      }
      transport = value;
      index += 1;
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
  return { clients, all, name, nameExplicit, dryRun, transport };
}

function usageError(deps: InitDeps, message: string): number {
  deps.stderr.write(`error: ${message}\n${INIT_USAGE}\n`);
  return 2;
}

function selectByFlags(adapters: readonly ClientAdapter[], requested: readonly string[], all: boolean): SelectedAdapter[] {
  const named = new Set(requested);
  //* No ids and no --all (for example bare --dry-run) sweeps every adapter without consent,
  //* so those adapters stay explicit: false and undetected ones are reported not-installed.
  return adapters
    .filter((adapter) => all || named.size === 0 || named.has(adapter.id))
    .map((adapter) => ({ adapter, explicit: named.has(adapter.id) }));
}

function wizardPrompts(deps: InitDeps): PromptAdapter {
  //* Production writes prompts to stderr so that stdout stays a clean JSON result stream.
  return deps.prompts ?? createClackAdapter(deps.stderr, deps.input);
}

function previewLines(
  selected: readonly SelectedAdapter[],
  name: string,
  nameExplicit: boolean,
  home: string,
  cwd: string,
): string[] {
  return selected.map(({ adapter }) => {
    const candidates = adapter.candidates(home, cwd);
    const path = candidates.find((candidate) => existsSync(candidate));
    if (path === undefined) {
      return `${adapter.label} (${adapter.id}): ${candidates[0] ?? "(no candidate path)"} - create config with entry "${name}"`;
    }
    try {
      const existing = adapter.load(path);
      const target = resolveTargetName(adapter, existing, name, nameExplicit);
      if (target === null) {
        return `${adapter.label} (${adapter.id}): ${path} - skip, entry "${name}" belongs to another server`;
      }
      const action = adapter.hasEntry(existing, target) ? "update" : "create";
      return `${adapter.label} (${adapter.id}): ${path} - ${action} entry "${target}"`;
    } catch {
      return `${adapter.label} (${adapter.id}): ${path} - skip, config could not be read`;
    }
  });
}

async function selectInteractively(
  home: string,
  cwd: string,
  deps: InitDeps,
  prompts: PromptAdapter,
  name: string,
  nameExplicit: boolean,
): Promise<{ selected: SelectedAdapter[]; transport: "stdio" | "http" } | null> {
  const adapters = deps.adapters ?? ADAPTERS;
  const detected = new Set(
    adapters
      .filter((adapter) => adapter.candidates(home, cwd).some((path) => existsSync(path)))
      .map((adapter) => adapter.id),
  );

  prompts.intro("github-fetcher init");

  const picked = await prompts.multiselect({
    message: "Select MCP clients to configure",
    options: adapters.map((adapter) => ({
      value: adapter.id,
      label: adapter.label,
      ...(detected.has(adapter.id) ? { hint: "(detected)" } : {}),
    })),
    initialValues: [...detected],
  });
  if (picked === null) return null;

  const transport = await prompts.select<"stdio" | "http">({
    message: "Choose a transport",
    options: [
      { value: "stdio", label: "stdio", hint: "recommended" },
      { value: "http", label: "http" },
    ],
    initialValue: "stdio",
  });
  if (transport === null) return null;

  const pickedIds = new Set(picked);
  const selected = adapters
    .filter((adapter) => pickedIds.has(adapter.id))
    .map((adapter) => ({ adapter, explicit: true }));

  prompts.note(
    [`Entry name: "${name}"`, "", ...previewLines(selected, name, nameExplicit, home, cwd)].join("\n"),
    "config paths",
  );

  const confirmed = await prompts.confirm({
    message: "Write these configurations?",
    initialValue: true,
  });
  if (confirmed !== true) return null;

  return { selected, transport };
}

interface ApplyContext {
  name: string;
  nameExplicit: boolean;
  dryRun: boolean;
  home: string;
  cwd: string;
  stderr: NodeJS.WritableStream;
  remote?: { url: string; tokenPath: string } | undefined;
}

function entryFor(adapter: ClientAdapter, name: string, context: ApplyContext): unknown | null {
  if (context.remote === undefined) return adapter.entry(name);
  const entry = adapter.remoteEntry?.(name, context.remote) ?? null;
  if (entry === null) {
    context.stderr.write(`warning: ${adapter.label} (${adapter.id}) cannot represent a remote HTTP server; skipped\n`);
  }
  return entry;
}

async function createFresh(adapter: ClientAdapter, path: string, context: ApplyContext): Promise<InitResult> {
  const entry = entryFor(adapter, context.name, context);
  if (context.remote !== undefined && entry === null) {
    return {
      client: adapter.id,
      path,
      name: context.name,
      action: "skipped",
      message: `${adapter.label} cannot represent a remote HTTP server`,
    };
  }
  //* Fresh configs arrive as undefined; every adapter's merge treats that as an empty target.
  const merged = adapter.merge(undefined, context.name, entry);
  if (context.dryRun) {
    return { client: adapter.id, path, name: context.name, action: "would-create", entry };
  }
  await mkdir(dirname(path), { recursive: true });
  await adapter.write(path, merged);
  return { client: adapter.id, path, name: context.name, action: "created" };
}

async function mergeTarget(adapter: ClientAdapter, path: string, context: ApplyContext): Promise<InitResult> {
  const raw = await readFile(path, "utf8");
  const existing = adapter.load(path);
  const name = resolveTargetName(adapter, existing, context.name, context.nameExplicit);
  if (name === null) {
    return {
      client: adapter.id,
      path,
      name: context.name,
      action: context.dryRun ? "would-skip" : "skipped",
      message: `entry "${context.name}" already exists and belongs to another server; left unchanged`,
      hint: `pass --name <key> to install under a different key`,
    };
  }
  const entry = entryFor(adapter, name, context);
  if (context.remote !== undefined && entry === null) {
    return {
      client: adapter.id,
      path,
      name,
      action: "skipped",
      message: `${adapter.label} cannot represent a remote HTTP server`,
    };
  }
  const merged = adapter.merge(existing, name, entry);
  if (adapter.serialize(merged) === raw) {
    return { client: adapter.id, path, name, action: context.dryRun ? "would-skip" : "skipped" };
  }
  const existed = adapter.hasEntry(existing, name);
  if (context.dryRun) {
    return { client: adapter.id, path, name, action: existed ? "would-update" : "would-create", entry };
  }
  //* The backup is written before the target changes; a failed write must still leave the
  //* original recoverable next to it.
  const backup = await backupFile(path, raw);
  await adapter.write(path, merged);
  return { client: adapter.id, path, name, action: existed ? "updated" : "created", backup };
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
          name: context.name,
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
    return { client: adapter.id, path, name: context.name, action: "error", message: describeError(error) };
  }
}

async function writeAuthStatus(stderr: NodeJS.WritableStream): Promise<void> {
  const config = loadConfig(process.env);
  const auth = createTokenResolver(config);
  const token = await auth.get();
  stderr.write(`auth: ${token ? "token" : "anonymous"}\n`);
}

//* A dry run must stay side-effect free, so it resolves the port from the environment
//* instead of starting a daemon to discover the live one.
function configuredPort(env: NodeJS.ProcessEnv): number {
  const raw = env["GITHUB_MCP_DAEMON_PORT"];
  if (raw === undefined || raw === "") return DEFAULT_DAEMON_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_DAEMON_PORT;
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
  let transport: "stdio" | "http" = options.transport ?? "stdio";
  const interactive = deps.interactive ?? process.stdin.isTTY === true;
  const home = deps.home ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  const adapters = deps.adapters ?? ADAPTERS;

  let selected: SelectedAdapter[];
  let wizard: PromptAdapter | undefined;
  if (requested.length > 0 || all || dryRun) {
    selected = selectByFlags(adapters, requested, all);
  } else if (interactive) {
    wizard = wizardPrompts(deps);
    const picked = await selectInteractively(
      home,
      cwd,
      deps,
      wizard,
      options.name,
      options.nameExplicit === true,
    );
    if (picked === null) {
      deps.stdout.write(`${JSON.stringify([{ action: "cancelled" }])}\n`);
      return 0;
    }
    selected = picked.selected;
    transport = picked.transport;
  } else {
    return usageError(deps, "init needs --client or --all in a non-interactive session");
  }

  const applyAll = async (): Promise<{ remote: { url: string; tokenPath: string } | undefined; results: InitResult[] }> => {
    let remote: { url: string; tokenPath: string } | undefined;
    if (transport === "http") {
      let port: number;
      if (dryRun) {
        port = configuredPort(process.env);
      } else {
        //* ensureDaemon prints a start JSON line; a silent stdout keeps init's stdout
        //* reserved for its own JSON result array.
        const silentStdout = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
        port = (await (deps.ensureDaemon ?? ensureDaemon)({
          env: process.env,
          home,
          platform: process.platform,
          deps: { stdout: silentStdout, stderr: deps.stderr },
        })).port;
      }
      remote = {
        url: `http://127.0.0.1:${port}/mcp`,
        tokenPath: daemonTokenPath(process.env, process.platform, home),
      };
    }

    const context: ApplyContext = {
      name: options.name,
      nameExplicit: options.nameExplicit === true,
      dryRun,
      home,
      cwd,
      stderr: deps.stderr,
      remote,
    };
    const results: InitResult[] = [];
    for (const { adapter, explicit } of selected) {
      results.push(await applyAdapter(adapter, explicit, context));
    }
    return { remote, results };
  };

  let results: InitResult[];
  if (wizard === undefined) {
    results = (await applyAll()).results;
  } else {
    results = (await wizard.spinner("Writing configuration", applyAll)).results;
    wizard.note(
      results.length === 0
        ? "No configuration changes"
        : results.map((result) => `${result.client ?? "?"}: ${result.action}`).join("\n"),
      "result",
    );
    wizard.outro("init complete");
  }
  deps.stdout.write(`${JSON.stringify(results)}\n`);
  await writeAuthStatus(deps.stderr);
  return 0;
}
