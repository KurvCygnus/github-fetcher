import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PACKAGE_COMMAND: [string, ...string[]] = ["npx", "-y", "@kurvcygnus/github-fetcher"];

export interface ClientAdapter {
  id: string;
  label: string;
  candidates(home: string, cwd: string): string[];
  load(path: string): unknown;
  entry(name: string): unknown;
  hasEntry(existing: unknown, name: string): boolean;
  merge(existing: unknown, name: string, entry: unknown): unknown;
  remove(existing: unknown, name: string): unknown;
  serialize(obj: unknown): string;
  write(path: string, obj: unknown): Promise<void>;
}

interface JsonSpec {
  id: string;
  label: string;
  candidates(home: string, cwd: string): string[];
  container: string[];
  build: (command: [string, ...string[]]) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

//? Own-property checks keep inherited prototype keys from masquerading as configured entries.
function jsonHasEntry(existing: unknown, container: readonly string[], name: string): boolean {
  let level: unknown = existing;
  for (const key of container) {
    if (!isRecord(level) || !Object.hasOwn(level, key)) return false;
    level = level[key];
  }
  return isRecord(level) && Object.hasOwn(level, name);
}

function jsonRemove(existing: unknown, container: readonly string[], name: string): unknown {
  const clone = structuredClone(existing);
  let level: unknown = clone;
  for (const key of container.slice(0, -1)) {
    if (!isRecord(level) || !Object.hasOwn(level, key)) return clone;
    level = level[key];
  }
  const leafKey = container.at(-1);
  if (leafKey === undefined || !isRecord(level) || !Object.hasOwn(level, leafKey)) return clone;
  const entries = level[leafKey];
  if (!isRecord(entries) || !Object.hasOwn(entries, name)) return clone;
  //? Deleting an own key only; inherited prototype names were never the configured entry.
  delete entries[name];
  return clone;
}

function jsonAdapter(spec: JsonSpec): ClientAdapter {
  const leafKey = spec.container.at(-1);
  if (leafKey === undefined) throw new Error(`empty container for ${spec.id}`);
  const serialize = (obj: unknown): string => `${JSON.stringify(obj, null, 2)}\n`;
  return {
    id: spec.id,
    label: spec.label,
    candidates: spec.candidates,
    load(path) {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    },
    //? The name is the container key, not part of a JSON entry; the parameter stays for
    //? the TOML adapter and future client shapes.
    entry(_name) {
      return spec.build(PACKAGE_COMMAND);
    },
    hasEntry(existing, name) {
      return jsonHasEntry(existing, spec.container, name);
    },
    merge(existing, name, entry) {
      const clone = structuredClone(existing);
      const root: Record<string, unknown> = isRecord(clone) ? clone : {};
      let level = root;
      for (const key of spec.container.slice(0, -1)) {
        const child = level[key];
        if (isRecord(child)) {
          level = child;
        } else {
          const created: Record<string, unknown> = {};
          level[key] = created;
          level = created;
        }
      }
      const container = level[leafKey];
      if (isRecord(container)) {
        //? defineProperty keeps names like "__proto__" as own data properties instead of
        //? triggering the prototype setter and silently losing the entry.
        Object.defineProperty(container, name, {
          value: entry,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else {
        level[leafKey] = { [name]: entry };
      }
      return root;
    },
    remove(existing, name) {
      return jsonRemove(existing, spec.container, name);
    },
    serialize,
    async write(path, obj) {
      await writeFile(path, serialize(obj), "utf8");
    },
  };
}

const opencode = jsonAdapter({
  id: "opencode",
  label: "OpenCode",
  candidates(home, cwd) {
    return [join(home, ".config", "opencode", "opencode.json"), join(cwd, "opencode.json")];
  },
  container: ["mcp"],
  build: (command) => ({ type: "local", command, enabled: true }),
});

const mcpServersSpec = (id: string, label: string, candidates: JsonSpec["candidates"]): ClientAdapter =>
  jsonAdapter({
    id,
    label,
    candidates,
    container: ["mcpServers"],
    build: ([command, ...args]) => ({ command, args, env: {} }),
  });

const claudeDesktop = mcpServersSpec("claude-desktop", "Claude Desktop", (home) => [
  //? Paths derive from the injected home so tests stay hermetic; with home = os.homedir() this
  //? is byte-identical to %APPDATA% on Windows.
  process.platform === "win32"
    ? join(home, "AppData", "Roaming", "Claude", "claude_desktop_config.json")
    : undefined,
  process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : undefined,
  process.platform !== "win32"
    ? join(home, ".config", "Claude", "claude_desktop_config.json")
    : undefined,
].filter((path): path is string => path !== undefined));

const claudeCode = mcpServersSpec("claude-code", "Claude Code", (home) => [join(home, ".claude.json")]);
const cursor = mcpServersSpec("cursor", "Cursor", (home, cwd) => [join(home, ".cursor", "mcp.json"), join(cwd, ".cursor", "mcp.json")]);
const gemini = mcpServersSpec("gemini", "Gemini CLI", (home) => [join(home, ".gemini", "settings.json")]);
const windsurf = mcpServersSpec("windsurf", "Windsurf", (home) => [join(home, ".codeium", "windsurf", "mcp_config.json")]);

const vscode = jsonAdapter({
  id: "vscode",
  label: "VS Code",
  candidates(home, cwd) {
    return [
      join(cwd, ".vscode", "mcp.json"),
      process.platform === "win32"
        ? join(home, "AppData", "Roaming", "Code", "User", "mcp.json")
        : undefined,
      process.platform === "darwin"
        ? join(home, "Library", "Application Support", "Code", "User", "mcp.json")
        : undefined,
      process.platform !== "win32"
        ? join(home, ".config", "Code", "User", "mcp.json")
        : undefined,
    ].filter((path): path is string => path !== undefined);
  },
  container: ["servers"],
  build: ([command, ...args]) => ({ type: "stdio", command, args }),
});

const [packageRunner, ...packageArgs] = PACKAGE_COMMAND;

const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/;

//? A dotted name must be quoted: `[mcp_servers.a.b]` is the nested table `b` under `a`.
function codexKey(name: string): string {
  return BARE_TOML_KEY.test(name) ? name : JSON.stringify(name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

//* Detecting, merging and removing all use this one pattern, so every accepted spelling of the
//* header behaves identically: bare or quoted key, interior whitespace, optional trailing comment.
function codexHeaderPattern(name: string): RegExp {
  const spellings = BARE_TOML_KEY.test(name) ? [name, JSON.stringify(name)] : [JSON.stringify(name)];
  const keys = spellings.map(escapeRegExp).join("|");
  return new RegExp(`^\\[\\s*mcp_servers\\s*\\.\\s*(?:${keys})\\s*\\]\\s*(?:#.*)?$`);
}

function codexHeaderIndex(lines: readonly string[], name: string): number {
  const pattern = codexHeaderPattern(name);
  return lines.findIndex((line) => pattern.test(line.trim()));
}

const codexEntry = (name: string): string => [
  `[mcp_servers.${codexKey(name)}]`,
  `command = ${JSON.stringify(packageRunner)}`,
  `args = [${packageArgs.map((arg) => JSON.stringify(arg)).join(", ")}]`,
].join("\n");

function codexText(existing: unknown): string {
  return typeof existing === "string" ? existing : "";
}

function codexHasEntry(existing: unknown, name: string): boolean {
  return codexHeaderIndex(codexText(existing).split(/\r?\n/), name) >= 0;
}

//? A table header starts a line; a bracket inside a value must not end the section. The one
//? ambiguous shape left is a bare multiline array element such as `["a"]`, which a generated
//? codex config never contains.
function isCodexTableHeader(line: string): boolean {
  return /^\s*\[\[?\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')/.test(line);
}

function codexRemove(existing: unknown, name: string): string {
  const text = codexText(existing);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const start = codexHeaderIndex(lines, name);
  if (start < 0) return text;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line === undefined || isCodexTableHeader(line)) break;
    end += 1;
  }

  const prefix = lines.slice(0, start);
  while (prefix.length > 0 && prefix[prefix.length - 1]?.trim() === "") prefix.pop();
  const suffix = lines.slice(end);
  //* Rebuild the seam with exactly one blank line between top-level blocks, then collapse any
  //* wider blank run so a removed section cannot leave three consecutive newlines behind.
  const kept = prefix.length === 0
    ? suffix
    : [...prefix, ...(suffix.length > 0 ? [""] : []), ...suffix];
  while (kept.length > 0 && kept[0]?.trim() === "") kept.shift();
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === "") kept.pop();
  const body = kept.join(eol).replace(/(?:\r?\n){3,}/g, `${eol}${eol}`);
  if (body === "") return "";
  return `${body}${eol}`;
}

const codex: ClientAdapter = {
  id: "codex",
  label: "Codex CLI",
  candidates: (home) => [join(home, ".codex", "config.toml")],
  load(path) {
    return readFileSync(path, "utf8");
  },
  entry: codexEntry,
  hasEntry: codexHasEntry,
  merge(existing, name) {
    const text = codexText(existing);
    if (codexHasEntry(text, name)) return text;
    const body = text.replace(/\s*$/, "");
    //* A fresh config (no candidate file) arrives as undefined; emit just the new table.
    return body === "" ? `${codexEntry(name)}\n` : `${body}\n\n${codexEntry(name)}\n`;
  },
  remove(existing, name) {
    return codexRemove(existing, name);
  },
  serialize(obj) {
    return String(obj);
  },
  async write(path, obj) {
    await writeFile(path, String(obj), "utf8");
  },
};

export const ADAPTERS: ClientAdapter[] = [opencode, claudeDesktop, claudeCode, cursor, vscode, gemini, windsurf, codex];

export function getAdapter(id: string): ClientAdapter {
  const adapter = ADAPTERS.find((candidate) => candidate.id === id);
  if (!adapter) throw new Error(`unknown client adapter: ${id}`);
  return adapter;
}
