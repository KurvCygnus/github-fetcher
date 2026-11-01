import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../../src/cli/init.js";

const dirs: string[] = [];
const TOKEN = "dummy-init-token";

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

let previousToken: string | undefined;

beforeEach(() => {
  previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = TOKEN;
});

afterEach(async () => {
  if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = previousToken;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runInit", () => {
  it("creates entries with backups for existing configs (flag path)", async () => {
    const home = await tempDir("ghf-init-home-");
    const cwd = await tempDir("ghf-init-cwd-");
    const configPath = join(home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(configPath), { recursive: true });
    const original = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: { existing: { type: "local", command: ["x"] } },
    }, null, 2);
    await writeFile(configPath, original, "utf8");

    const out = capture();
    const err = capture();
    const code = await runInit(
      { clients: ["opencode"], name: "github", dryRun: false },
      { stdout: out.stream, stderr: err.stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.mcp.github).toMatchObject({ type: "local", enabled: true });
    expect(written.mcp.existing).toBeDefined();
    const entries = JSON.parse(out.text());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ client: "opencode", action: "created", path: configPath });
    expect(typeof entries[0].backup).toBe("string");
    expect(await readFile(entries[0].backup, "utf8")).toBe(original);
    expect(err.text()).toContain("auth: token");
    expect(err.text()).not.toContain(TOKEN);
  }, 300000);

  it("reports skipped when the entry already matches", async () => {
    const home = await tempDir("ghf-init-home-");
    const cwd = await tempDir("ghf-init-cwd-");
    const configPath = join(home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ mcp: { existing: { type: "local", command: ["x"] } } }, null, 2), "utf8");
    const options = { clients: ["opencode"], name: "github", dryRun: false };

    const first = capture();
    expect(await runInit(options, {
      stdout: first.stream, stderr: capture().stream, home, cwd, interactive: false,
    })).toBe(0);
    const directory = dirname(configPath);
    const backups = async (): Promise<string[]> =>
      (await readdir(directory)).filter((name) => name.includes(".bak."));
    expect(await backups()).toHaveLength(1);

    const out = capture();
    const code = await runInit(options, {
      stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false,
    });

    expect(code).toBe(0);
    const entries = JSON.parse(out.text());
    expect(entries[0]).toMatchObject({ client: "opencode", action: "skipped", path: configPath });
    expect(entries[0].backup).toBeUndefined();
    expect(await backups()).toHaveLength(1);
  }, 300000);

  it("reports not-installed for clients without candidate files", async () => {
    const home = await tempDir("ghf-init-home-");
    const cwd = await tempDir("ghf-init-cwd-");
    const out = capture();
    const code = await runInit(
      { all: true, name: "github", dryRun: false },
      { stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    const entries = JSON.parse(out.text());
    expect(entries).toHaveLength(8);
    expect(entries.every((entry: { action: string }) => entry.action === "not-installed")).toBe(true);
    const cursor = entries.find((entry: { client: string }) => entry.client === "cursor");
    expect(cursor).toMatchObject({
      client: "cursor",
      path: join(home, ".cursor", "mcp.json"),
      action: "not-installed",
    });
    expect(typeof cursor.hint).toBe("string");
    expect(cursor.hint.length).toBeGreaterThan(0);
    expect(existsSync(join(home, ".cursor"))).toBe(false);
    expect(existsSync(join(cwd, ".cursor"))).toBe(false);
  }, 300000);

  it("creates a fresh config for an explicitly selected undetected client", async () => {
    const home = await tempDir("ghf-init-home-");
    const cwd = await tempDir("ghf-init-cwd-");
    const out = capture();
    const code = await runInit(
      { clients: ["cursor"], name: "github", dryRun: false },
      { stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    const configPath = join(home, ".cursor", "mcp.json");
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.mcpServers.github).toMatchObject({ command: "npx" });
    const entries = JSON.parse(out.text());
    expect(entries[0]).toMatchObject({ client: "cursor", path: configPath, action: "created" });
    expect(entries[0].backup).toBeUndefined();
    expect((await readdir(dirname(configPath))).filter((name) => name.includes(".bak."))).toHaveLength(0);
  }, 300000);

  it("dry-run writes nothing and reports would-*", async () => {
    const home = await tempDir("ghf-init-home-");
    const cwd = await tempDir("ghf-init-cwd-");
    const fresh = capture();
    const freshCode = await runInit(
      { clients: ["cursor"], name: "github", dryRun: true },
      { stdout: fresh.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(freshCode).toBe(0);
    const freshEntries = JSON.parse(fresh.text());
    expect(freshEntries[0]).toMatchObject({
      client: "cursor",
      path: join(home, ".cursor", "mcp.json"),
      action: "would-create",
    });
    expect(freshEntries[0].entry).toMatchObject({ command: "npx" });
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
    expect(existsSync(join(home, ".cursor"))).toBe(false);

    const configPath = join(home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(configPath), { recursive: true });
    const stale = JSON.stringify({ mcp: { github: { type: "local", command: ["stale"] } } }, null, 2);
    await writeFile(configPath, stale, "utf8");
    const update = capture();
    const updateCode = await runInit(
      { clients: ["opencode"], name: "github", dryRun: true },
      { stdout: update.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(updateCode).toBe(0);
    const updateEntries = JSON.parse(update.text());
    expect(updateEntries[0]).toMatchObject({ client: "opencode", action: "would-update", path: configPath });
    expect(updateEntries[0].backup).toBeUndefined();
    expect(await readFile(configPath, "utf8")).toBe(stale);
    expect((await readdir(dirname(configPath))).filter((name) => name.includes(".bak."))).toHaveLength(0);
  }, 300000);

  it("errors gracefully on invalid JSON targets and continues", async () => {
    const home = await tempDir("ghf-init-home-");
    const cwd = await tempDir("ghf-init-cwd-");
    const cursorPath = join(home, ".cursor", "mcp.json");
    await mkdir(dirname(cursorPath), { recursive: true });
    await writeFile(cursorPath, "not json", "utf8");
    const opencodePath = join(home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(opencodePath), { recursive: true });
    await writeFile(opencodePath, JSON.stringify({ mcp: { existing: { type: "local", command: ["x"] } } }, null, 2), "utf8");
    const out = capture();
    const code = await runInit(
      { clients: ["cursor", "opencode"], name: "github", dryRun: false },
      { stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    const entries = JSON.parse(out.text());
    const cursor = entries.find((entry: { client: string }) => entry.client === "cursor");
    expect(cursor).toMatchObject({ client: "cursor", action: "error", path: cursorPath });
    expect(typeof cursor.message).toBe("string");
    const opencode = entries.find((entry: { client: string }) => entry.client === "opencode");
    expect(opencode).toMatchObject({ client: "opencode", action: "created", path: opencodePath });
    expect(JSON.parse(await readFile(opencodePath, "utf8")).mcp.github).toBeDefined();
  }, 300000);

  it("non-TTY without flags is a usage error", async () => {
    const home = await tempDir("ghf-init-home-");
    const cwd = await tempDir("ghf-init-cwd-");
    const out = capture();
    const err = capture();
    const code = await runInit(
      { name: "github", dryRun: false },
      { stdout: out.stream, stderr: err.stream, home, cwd, interactive: false },
    );

    expect(code).toBe(2);
    expect(out.text()).toBe("");
    expect(err.text()).toContain("--client");
    expect(err.text()).toContain("--all");
    expect(err.text()).toContain("Usage: github-fetcher init");
  }, 300000);

  it("parses repeated and comma-separated --client values; --dry-run alone sweeps all adapters", async () => {
    const home = await tempDir("ghf-init-home-");
    const cwd = await tempDir("ghf-init-cwd-");
    const selected = capture();
    const selectedCode = await runInit(
      ["--client", "cursor,gemini", "--client", "opencode", "--name", "gh", "--dry-run"],
      { stdout: selected.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(selectedCode).toBe(0);
    expect(JSON.parse(selected.text()).map((entry: { client: string }) => entry.client)).toEqual([
      "opencode",
      "cursor",
      "gemini",
    ]);

    const swept = capture();
    const sweptCode = await runInit(
      ["--dry-run"],
      { stdout: swept.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(sweptCode).toBe(0);
    const sweptEntries = JSON.parse(swept.text());
    expect(sweptEntries).toHaveLength(8);
    expect(sweptEntries.every((entry: { action: string }) => entry.action === "not-installed")).toBe(true);
  }, 300000);

  it("a cancelled TUI performs no writes and reports cancelled", async () => {
    const home = await tempDir("ghf-init-home-");
    const cwd = await tempDir("ghf-init-cwd-");
    const out = capture();
    const code = await runInit(
      { name: "github", dryRun: false },
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
    expect(existsSync(join(home, ".config", "opencode"))).toBe(false);
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  }, 300000);

  it("--help prints usage to stdout and exits 0", async () => {
    const home = await tempDir("ghf-init-home-");
    const cwd = await tempDir("ghf-init-cwd-");
    const out = capture();
    const err = capture();

    const code = await runInit(["--help"], {
      stdout: out.stream,
      stderr: err.stream,
      home,
      cwd,
      interactive: false,
    });

    expect(code).toBe(0);
    expect(out.text()).toContain("Usage: github-fetcher init");
    expect(err.text()).toBe("");
  }, 300000);

  it("updates a legacy local-dist entry instead of adding a second name", async () => {
    const home = await tempDir("ghf-init-home-");
    const cwd = await tempDir("ghf-init-cwd-");
    const configPath = join(home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(configPath), { recursive: true });
    const legacy = {
      type: "local",
      command: ["node", "D:/Code/TS/github-fetcher/dist/index.js"],
      enabled: true,
    };
    await writeFile(configPath, JSON.stringify({ mcp: { "github-fetcher": legacy } }, null, 2), "utf8");
    const out = capture();

    const code = await runInit(
      { clients: ["opencode"], name: "github", dryRun: false },
      { stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(Object.keys(written.mcp)).toEqual(["github-fetcher"]);
    expect(written.mcp["github-fetcher"].command).toEqual(["npx", "-y", "@kurvcygnus/github-fetcher@latest"]);
    expect(Object.hasOwn(written.mcp, "github")).toBe(false);
    const entries = JSON.parse(out.text());
    expect(entries[0]).toMatchObject({ client: "opencode", action: "updated", path: configPath });
    expect(await readFile(entries[0].backup, "utf8")).toContain("dist/index.js");
  }, 300000);

  it("respects an explicit --name and leaves a legacy entry untouched", async () => {
    const home = await tempDir("ghf-init-home-");
    const cwd = await tempDir("ghf-init-cwd-");
    const configPath = join(home, ".config", "opencode", "opencode.json");
    await mkdir(dirname(configPath), { recursive: true });
    const legacy = {
      type: "local",
      command: ["node", "D:/Code/TS/github-fetcher/dist/index.js"],
      enabled: true,
    };
    await writeFile(configPath, JSON.stringify({ mcp: { "github-fetcher": legacy } }, null, 2), "utf8");
    const out = capture();

    const code = await runInit(
      ["--client", "opencode", "--name", "custom"],
      { stdout: out.stream, stderr: capture().stream, home, cwd, interactive: false },
    );

    expect(code).toBe(0);
    const written = JSON.parse(await readFile(configPath, "utf8"));
    expect(written.mcp["github-fetcher"]).toEqual(legacy);
    expect(written.mcp.custom.command).toEqual(["npx", "-y", "@kurvcygnus/github-fetcher@latest"]);
    expect(Object.keys(written.mcp).sort()).toEqual(["custom", "github-fetcher"]);
    expect(JSON.parse(out.text())[0]).toMatchObject({ client: "opencode", action: "created" });
  }, 300000);

  it("rejects unknown clients and invalid names with a usage error", async () => {
    const home = await tempDir("ghf-init-home-");
    const cwd = await tempDir("ghf-init-cwd-");
    const unknownErr = capture();
    const unknownCode = await runInit(
      ["--client", "nope"],
      { stdout: capture().stream, stderr: unknownErr.stream, home, cwd, interactive: false },
    );
    expect(unknownCode).toBe(2);
    expect(unknownErr.text()).toContain("unknown client: nope");

    const nameErr = capture();
    const nameCode = await runInit(
      ["--name", "bad name"],
      { stdout: capture().stream, stderr: nameErr.stream, home, cwd, interactive: false },
    );
    expect(nameCode).toBe(2);
    expect(nameErr.text()).toContain("invalid --name");
  }, 300000);
});
