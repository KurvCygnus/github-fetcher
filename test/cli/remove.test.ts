import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupFile } from "../../src/cli/clients-flow.js";
import { runRemove } from "../../src/cli/remove.js";
import type { TuiItem } from "../../src/cli/tui.js";

const dirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function capture(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: {
      write: (chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      },
    } as NodeJS.WritableStream,
    text: () => chunks.join(""),
  };
}

async function backupsIn(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.includes(".bak."));
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runRemove", () => {
  it("removes only the tool entry, preserving siblings, with a backup", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    const configPath = join(home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(configPath), { recursive: true });
    const original = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        existing: { type: "local", command: ["x"] },
        github: { type: "local", command: ["npx"], enabled: true },
      },
    }, null, 2) + "\n";
    await writeFile(configPath, original, "utf8");
    const out = capture();
    const err = capture();

    const code = await runRemove(
      { clients: ["opencode"], name: "github" },
      { stdout: out.stream, stderr: err.stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.$schema).toBe("https://opencode.ai/config.json");
    expect(written.mcp.existing).toMatchObject({ type: "local" });
    expect(Object.hasOwn(written.mcp, "github")).toBe(false);
    const entries = JSON.parse(out.text());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ client: "opencode", path: configPath, action: "removed" });
    expect(await readFile(entries[0].backup, "utf8")).toBe(original);
    expect(err.text()).toBe("");
  }, 300000);

  it("deletes a config made empty by removal and keeps its backup", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    const configPath = join(home, ".cursor", "mcp.json");
    await mkdir(dirname(configPath), { recursive: true });
    const original = JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "@kurvcygnus/github-fetcher@latest"], env: {} },
      },
    }, null, 2) + "\n";
    await writeFile(configPath, original, "utf8");
    const out = capture();

    const code = await runRemove(
      { clients: ["cursor"], name: "github" },
      { stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    expect(existsSync(configPath)).toBe(false);
    const entries = JSON.parse(out.text());
    expect(entries[0]).toMatchObject({ client: "cursor", path: configPath, action: "removed" });
    expect(typeof entries[0].backup).toBe("string");
    expect(await readFile(entries[0].backup, "utf8")).toBe(original);
    expect(await backupsIn(dirname(configPath))).toHaveLength(1);
  }, 300000);

  it("keeps configs with another top-level key or a non-empty sibling", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    const cursorPath = join(home, ".cursor", "mcp.json");
    await mkdir(dirname(cursorPath), { recursive: true });
    await writeFile(cursorPath, JSON.stringify({
      $schema: "https://example.test/cursor.json",
      mcpServers: { github: { command: "npx", args: ["-y", "@kurvcygnus/github-fetcher@latest"] } },
    }, null, 2) + "\n", "utf8");
    const geminiPath = join(home, ".gemini", "settings.json");
    await mkdir(dirname(geminiPath), { recursive: true });
    await writeFile(geminiPath, JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "@kurvcygnus/github-fetcher@latest"] },
        other: { command: "npx", args: ["-y", "other"] },
      },
    }, null, 2) + "\n", "utf8");
    const out = capture();

    const code = await runRemove(
      { clients: ["cursor", "gemini"], name: "github" },
      { stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    const writtenCursor = JSON.parse(await readFile(cursorPath, "utf8"));
    expect(writtenCursor.$schema).toBe("https://example.test/cursor.json");
    expect(writtenCursor.mcpServers).toEqual({});
    const writtenGemini = JSON.parse(await readFile(geminiPath, "utf8"));
    expect(writtenGemini.mcpServers.other).toEqual({ command: "npx", args: ["-y", "other"] });
    expect(Object.hasOwn(writtenGemini.mcpServers, "github")).toBe(false);
    const entries = JSON.parse(out.text());
    expect(entries.every((entry: { action: string }) => entry.action === "removed")).toBe(true);
  }, 300000);

  it("removes a legacy entry under its resolved name", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    const configPath = join(home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      mcp: {
        "github-fetcher": {
          type: "local",
          command: ["node", "D:/Code/TS/github-fetcher/dist/index.js"],
          enabled: true,
        },
        existing: { type: "local", command: ["x"] },
      },
    }, null, 2) + "\n", "utf8");
    const out = capture();

    const code = await runRemove(
      { clients: ["opencode"], name: "github" },
      { stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(Object.hasOwn(written.mcp, "github-fetcher")).toBe(false);
    expect(written.mcp.existing).toBeDefined();
    expect(JSON.parse(out.text())[0]).toMatchObject({ client: "opencode", action: "removed" });
  }, 300000);

  it("removes exactly an explicit --name without resolving a legacy entry", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    const configPath = join(home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      mcp: {
        custom: { type: "local", command: ["x"] },
        "github-fetcher": {
          type: "local",
          command: ["node", "D:/Code/TS/github-fetcher/dist/index.js"],
          enabled: true,
        },
      },
    }, null, 2) + "\n", "utf8");
    const out = capture();

    const code = await runRemove(
      ["--client", "opencode", "--name", "custom"],
      { stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(Object.hasOwn(written.mcp, "custom")).toBe(false);
    expect(written.mcp["github-fetcher"]).toBeDefined();
    expect(JSON.parse(out.text())[0]).toMatchObject({ client: "opencode", action: "removed" });
  }, 300000);

  it("reports skipped when the entry is absent without writing or backing up", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    const configPath = join(home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(configPath), { recursive: true });
    const original = JSON.stringify({ mcp: { existing: { type: "local", command: ["x"] } } }, null, 2) + "\n";
    await writeFile(configPath, original, "utf8");
    const out = capture();

    const code = await runRemove(
      { clients: ["opencode"], name: "github" },
      { stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    expect(await readFile(configPath, "utf8")).toBe(original);
    const entries = JSON.parse(out.text());
    expect(entries[0]).toMatchObject({ client: "opencode", path: configPath, action: "skipped" });
    expect(entries[0].backup).toBeUndefined();
    expect(await backupsIn(dirname(configPath))).toHaveLength(0);
  }, 300000);

  it("excises the codex TOML section, keeping surrounding lines", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    const configPath = join(home, ".codex", "config.toml");
    await mkdir(dirname(configPath), { recursive: true });
    const original = [
      'model = "gpt"',
      "",
      "[mcp_servers.github]",
      'command = "npx"',
      'args = ["-y", "@kurvcygnus/github-fetcher@latest"]',
      "",
      "[mcp_servers.other]",
      'command = "x"',
      "",
    ].join("\n");
    await writeFile(configPath, original, "utf8");
    const out = capture();

    const code = await runRemove(
      { clients: ["codex"], name: "github" },
      { stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    const text = await readFile(configPath, "utf8");
    expect(text).not.toContain("[mcp_servers.github]");
    expect(text).not.toContain("github-fetcher");
    expect(text).toContain('model = "gpt"');
    expect(text).toContain("[mcp_servers.other]");
    expect(text).toContain('command = "x"');
    expect(text).not.toMatch(/\n{3,}/);
    const entries = JSON.parse(out.text());
    expect(entries[0]).toMatchObject({ client: "codex", path: configPath, action: "removed" });
    expect(await readFile(entries[0].backup, "utf8")).toBe(original);
  }, 300000);

  it("reports not-installed clients without creating files", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    const out = capture();

    const code = await runRemove(
      { clients: ["cursor"], name: "github" },
      { stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    const entries = JSON.parse(out.text());
    expect(entries[0]).toMatchObject({
      client: "cursor",
      path: join(home, ".cursor", "mcp.json"),
      action: "not-installed",
    });
    expect(existsSync(join(home, ".cursor"))).toBe(false);
    expect(existsSync(join(cwd, ".cursor"))).toBe(false);
  }, 300000);

  it("reports invalid JSON as an error and continues with other adapters", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    const cursorPath = join(home, ".cursor", "mcp.json");
    await mkdir(dirname(cursorPath), { recursive: true });
    await writeFile(cursorPath, "not json", "utf8");
    const opencodePath = join(home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(opencodePath), { recursive: true });
    await writeFile(
      opencodePath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: { github: { type: "local", command: ["x"] } },
      }, null, 2) + "\n",
      "utf8",
    );
    const out = capture();

    const code = await runRemove(
      { clients: ["cursor", "opencode"], name: "github" },
      { stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    const entries = JSON.parse(out.text());
    const cursor = entries.find((entry: { client: string }) => entry.client === "cursor");
    expect(cursor).toMatchObject({ client: "cursor", path: cursorPath, action: "error" });
    expect(typeof cursor.message).toBe("string");
    const opencode = entries.find((entry: { client: string }) => entry.client === "opencode");
    expect(opencode).toMatchObject({ client: "opencode", path: opencodePath, action: "removed" });
    expect(JSON.parse(await readFile(opencodePath, "utf8")).mcp.github).toBeUndefined();
    expect(await backupsIn(dirname(cursorPath))).toHaveLength(0);
  }, 300000);

  it("sweeps every adapter with --all, reporting removed, skipped, and not-installed", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    const opencodePath = join(home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(opencodePath), { recursive: true });
    await writeFile(
      opencodePath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: { github: { type: "local", command: ["x"] } },
      }, null, 2) + "\n",
      "utf8",
    );
    const cursorPath = join(home, ".cursor", "mcp.json");
    await mkdir(dirname(cursorPath), { recursive: true });
    const cursorOriginal = JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2) + "\n";
    await writeFile(cursorPath, cursorOriginal, "utf8");
    const out = capture();

    const code = await runRemove(
      { clients: [], all: true, name: "github" },
      { stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    const entries = JSON.parse(out.text()) as { client: string; action: string }[];
    expect(entries).toHaveLength(8);
    const byClient = new Map(entries.map((entry) => [entry.client, entry.action]));
    expect(byClient.get("opencode")).toBe("removed");
    expect(byClient.get("cursor")).toBe("skipped");
    expect(byClient.get("codex")).toBe("not-installed");
    expect(await readFile(cursorPath, "utf8")).toBe(cursorOriginal);
    expect(await backupsIn(dirname(cursorPath))).toHaveLength(0);
    expect(JSON.parse(await readFile(opencodePath, "utf8")).mcp.github).toBeUndefined();
  }, 300000);

  it("TUI lists only adapters that already contain the entry and removes them", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    const opencodePath = join(home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(opencodePath), { recursive: true });
    await writeFile(
      opencodePath,
      JSON.stringify({ mcp: { existing: {}, github: { type: "local", command: ["x"] } } }, null, 2) + "\n",
      "utf8",
    );
    const cursorPath = join(home, ".cursor", "mcp.json");
    await mkdir(dirname(cursorPath), { recursive: true });
    const cursorOriginal = JSON.stringify({ mcpServers: { other: { command: "x" } } }, null, 2) + "\n";
    await writeFile(cursorPath, cursorOriginal, "utf8");
    const codexPath = join(home, ".codex", "config.toml");
    await mkdir(dirname(codexPath), { recursive: true });
    await writeFile(codexPath, 'model = "gpt"\n\n[mcp_servers.github]\ncommand = "x"\n', "utf8");
    const seen: { items: readonly TuiItem[]; preselected: readonly string[] } = { items: [], preselected: [] };
    const out = capture();

    const code = await runRemove(
      { name: "github" },
      {
        stdout: out.stream,
        stderr: capture().stream,
        home,
        cwd,
        interactive: true,
        select: async (items, _deps, preselected = []) => {
          seen.items = items;
          seen.preselected = preselected;
          return [...preselected];
        },
      },
    );

    expect(code).toBe(0);
    expect(seen.items.map((item) => item.id)).toEqual(["opencode", "codex"]);
    expect(seen.preselected).toEqual(["opencode", "codex"]);
    const entries = JSON.parse(out.text());
    expect(entries.map((entry: { client: string }) => entry.client)).toEqual(["opencode", "codex"]);
    expect(entries.every((entry: { action: string }) => entry.action === "removed")).toBe(true);
    expect(await readFile(cursorPath, "utf8")).toBe(cursorOriginal);
    expect(JSON.parse(await readFile(opencodePath, "utf8")).mcp.github).toBeUndefined();
    expect(await readFile(codexPath, "utf8")).not.toContain("[mcp_servers.github]");
  }, 300000);

  it("prints [] without starting the TUI when no adapter contains the entry", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    let called = false;
    const out = capture();

    const code = await runRemove(
      { name: "github" },
      {
        stdout: out.stream,
        stderr: capture().stream,
        home,
        cwd,
        interactive: true,
        select: async () => {
          called = true;
          return null;
        },
      },
    );

    expect(code).toBe(0);
    expect(called).toBe(false);
    expect(out.text()).toBe("[]\n");
  }, 300000);

  it("a cancelled TUI performs no writes and reports cancelled", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    const configPath = join(home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(configPath), { recursive: true });
    const original = JSON.stringify({ mcp: { github: { type: "local", command: ["x"] } } }, null, 2) + "\n";
    await writeFile(configPath, original, "utf8");
    const out = capture();

    const code = await runRemove(
      { name: "github" },
      {
        stdout: out.stream,
        stderr: capture().stream,
        home,
        cwd,
        interactive: true,
        select: async () => null,
      },
    );

    expect(code).toBe(0);
    expect(JSON.parse(out.text())).toEqual([{ action: "cancelled" }]);
    expect(await readFile(configPath, "utf8")).toBe(original);
    expect(await backupsIn(dirname(configPath))).toHaveLength(0);
  }, 300000);

  it("a same-second backup collision keeps the older backup under a suffix", async () => {
    const dir = await tempDir("ghf-remove-backup-");
    const path = join(dir, "config.json");
    const now = new Date(2026, 9, 31, 12, 0, 0);

    const first = await backupFile(path, "one", now);
    const second = await backupFile(path, "two", now);

    expect(first.endsWith(".bak.20261031-120000")).toBe(true);
    expect(second.endsWith(".bak.20261031-120000-1")).toBe(true);
    expect(await readFile(first, "utf8")).toBe("one");
    expect(await readFile(second, "utf8")).toBe("two");
  }, 300000);

  it("--help prints usage to stdout and exits 0", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    const out = capture();
    const err = capture();

    const code = await runRemove(["--help"], {
      stdout: out.stream,
      stderr: err.stream,
      home,
      cwd,
      interactive: false,
    });

    expect(code).toBe(0);
    expect(out.text()).toContain("Usage: github-fetcher remove");
    expect(err.text()).toBe("");
  }, 300000);

  it("rejects unknown clients, flags, names, and flagless non-TTY runs with usage", async () => {
    const home = await tempDir("ghf-remove-home-");
    const cwd = await tempDir("ghf-remove-cwd-");
    const deps = { stdout: capture().stream, stderr: capture().stream, home, cwd, interactive: false };

    const unknownClient = capture();
    expect(await runRemove(["--client", "nope"], { ...deps, stderr: unknownClient.stream })).toBe(2);
    expect(unknownClient.text()).toContain("unknown client: nope");

    const unknownFlag = capture();
    expect(await runRemove(["--bogus"], { ...deps, stderr: unknownFlag.stream })).toBe(2);
    expect(unknownFlag.text()).toContain("unknown flag: --bogus");

    const badName = capture();
    expect(await runRemove(["--name", "bad name"], { ...deps, stderr: badName.stream })).toBe(2);
    expect(badName.text()).toContain("invalid --name");

    const noFlags = capture();
    expect(await runRemove({ name: "github" }, { ...deps, stderr: noFlags.stream })).toBe(2);
    expect(noFlags.text()).toContain("Usage: github-fetcher remove");
  }, 300000);
});
