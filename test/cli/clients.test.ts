import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADAPTERS, getAdapter } from "../../src/cli/clients/index.js";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ghf-clients-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("client adapters", () => {
  it("has unique ids covering the documented clients and merges into documented containers", () => {
    const ids = ADAPTERS.map((adapter) => adapter.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const required of ["opencode", "claude-desktop", "claude-code", "cursor", "vscode", "gemini", "windsurf", "codex"]) {
      expect(ids).toContain(required);
    }
    for (const adapter of ADAPTERS) {
      expect(adapter.candidates("/home/test", "/work").length).toBeGreaterThan(0);
      expect(adapter.label.length).toBeGreaterThan(0);
      expect(JSON.stringify(adapter.entry("github"))).toContain("@kurvcygnus/github-fetcher");
    }
    expect(() => getAdapter("missing")).toThrow("unknown client adapter: missing");

    const containers: Record<string, string> = {
      opencode: "mcp",
      "claude-desktop": "mcpServers",
      "claude-code": "mcpServers",
      cursor: "mcpServers",
      vscode: "servers",
      gemini: "mcpServers",
      windsurf: "mcpServers",
    };
    for (const adapter of ADAPTERS) {
      const container = containers[adapter.id];
      //? Codex stores TOML text rather than a JSON container; its own test covers the merge.
      if (container === undefined) continue;
      const merged = adapter.merge(
        { [container]: { existing: { command: "x" } } },
        "github",
        adapter.entry("github"),
      ) as Record<string, Record<string, unknown> | undefined>;
      expect(merged[container]?.existing).toBeDefined();
      expect(merged[container]?.github).toBeDefined();
    }
  });

  it("opencode merges into the mcp container preserving siblings", async () => {
    const dir = await tempDir();
    const path = join(dir, "opencode.json");
    await writeFile(path, JSON.stringify({
      "$schema": "https://opencode.ai/config.json",
      "mcp": { "existing": { "type": "local", "command": ["x"] } },
    }, null, 2));
    const adapter = getAdapter("opencode");
    const existing = adapter.load(path);
    const merged = adapter.merge(existing, "github", adapter.entry("github"));
    expect((merged as { mcp: Record<string, unknown> }).mcp.existing).toBeDefined();
    expect((merged as { mcp: Record<string, unknown> }).mcp.github).toMatchObject({ type: "local", enabled: true });
    await adapter.write(path, merged);
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.mcp.existing).toBeDefined();
  });

  it("derives Windows candidates from home, never process.env.APPDATA", () => {
    const previous = process.env.APPDATA;
    process.env.APPDATA = join(tmpdir(), "ghf-appdata-sentinel");
    const home = join(tmpdir(), "ghf-home-sentinel");
    try {
      for (const id of ["claude-desktop", "vscode"]) {
        const paths = getAdapter(id).candidates(home, join(tmpdir(), "ghf-cwd-sentinel"));
        expect(paths.length).toBeGreaterThan(0);
        expect(paths.some((path) => path.includes("ghf-appdata-sentinel"))).toBe(false);
        if (process.platform === "win32") {
          expect(paths.some((path) => path.startsWith(join(home, "AppData", "Roaming")))).toBe(true);
        }
      }
    } finally {
      if (previous === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = previous;
    }
  }, 300000);

  it("codex appends a TOML section and skips when present", async () => {
    const dir = await tempDir();
    const path = join(dir, "config.toml");
    await writeFile(path, 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n');
    const adapter = getAdapter("codex");
    const merged = adapter.merge(adapter.load(path), "github", adapter.entry("github"));
    await adapter.write(path, merged);
    const text = await readFile(path, "utf8");
    expect(text).toContain("[mcp_servers.github]");
    expect(text).toContain('model = "gpt"');
    const again = adapter.merge(adapter.load(path), "github", adapter.entry("github"));
    expect(again).toBe(text); // idempotent: section exists, text unchanged
    expect(adapter.hasEntry(text, "github")).toBe(true);
    expect(adapter.hasEntry("[mcp_servers.github] # managed\n", "github")).toBe(true);
    expect(adapter.hasEntry("[mcp_servers.github_extra]\n", "github")).toBe(false);
    expect(adapter.hasEntry('note = "[mcp_servers.github]"\n', "github")).toBe(false);
  });

  it("keeps __proto__ names as own JSON properties", () => {
    const adapter = getAdapter("opencode");
    const merged = adapter.merge({}, "__proto__", adapter.entry("github"));
    expect(JSON.stringify(merged)).toContain('"__proto__"');
  });
});
