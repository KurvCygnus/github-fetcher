import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ADAPTERS, PACKAGE_COMMAND, getAdapter } from "../../src/cli/clients/index.js";

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
    expect(PACKAGE_COMMAND).toEqual(["npx", "-y", "@kurvcygnus/github-fetcher@latest"]);
    for (const adapter of ADAPTERS) {
      expect(adapter.candidates("/home/test", "/work").length).toBeGreaterThan(0);
      expect(adapter.label.length).toBeGreaterThan(0);
      expect(JSON.stringify(adapter.entry("github"))).toContain("@kurvcygnus/github-fetcher@latest");
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

  it("codex recognizes quoted and interior-whitespace headers without duplicating", () => {
    const adapter = getAdapter("codex");
    const texts = [
      '[mcp_servers."github"]\ncommand = "x"\n',
      "[ mcp_servers.github ]\ncommand = \"x\"\n",
      "[ mcp_servers . github ] # managed\ncommand = \"x\"\n",
      "[mcp_servers.'github'] # literal\ncommand = \"x\"\n",
    ];
    for (const text of texts) {
      expect(adapter.hasEntry(text, "github")).toBe(true);
      const merged = String(adapter.merge(text, "github", adapter.entry("github")));
      expect(merged.split("\n")[0]).toBe(text.split("\n")[0]);
      expect(merged).toContain('command = "npx"');
      expect(merged).not.toContain('command = "x"');
      expect(adapter.merge(merged, "github", adapter.entry("github"))).toBe(merged);
    }
    expect(adapter.hasEntry('[mcp_servers."github_extra"]\n', "github")).toBe(false);
  });

  it("codex quotes dotted names and removes their whole section", () => {
    const adapter = getAdapter("codex");
    const text = 'model = "gpt"\n\n[mcp_servers."my.github"]\ncommand = "x"\nargs = ["-y"]\n\n[other]\nkey = 1\n';
    expect(adapter.entry("my.github")).toContain('[mcp_servers."my.github"]');
    expect(adapter.hasEntry(text, "my.github")).toBe(true);
    expect(adapter.hasEntry("[mcp_servers.my.github]\n", "my.github")).toBe(false);
    const removed = adapter.remove(text, "my.github");
    expect(removed).toBe('model = "gpt"\n\n[other]\nkey = 1\n');
    expect(adapter.remove('[mcp_servers."my.github"]\ncommand = "x"\n\n[other]\nkey = 1\n', "my.github"))
      .toBe("[other]\nkey = 1\n");
    expect(adapter.remove('[mcp_servers."my.github"]\ncommand = "x"\n\n', "my.github")).toBe("");
  });

  it("codex recognizes literal-quoted headers and removes them", () => {
    const adapter = getAdapter("codex");
    const text = "model = \"gpt\"\n\n[mcp_servers.'github']\ncommand = \"x\"\n\n[other]\nkey = 1\n";
    expect(adapter.hasEntry(text, "github")).toBe(true);
    const merged = adapter.merge(text, "github", adapter.entry("github"));
    expect(merged).toContain("[mcp_servers.'github']");
    expect(merged).toContain('command = "npx"');
    expect(adapter.remove(text, "github")).toBe('model = "gpt"\n\n[other]\nkey = 1\n');
  });

  it("codex refreshes a section body in place and preserves sub-tables and siblings", () => {
    const adapter = getAdapter("codex");
    const text = [
      'model = "gpt"',
      "",
      "[mcp_servers.github]",
      'command = "old"',
      'args = ["old"]',
      "",
      "[mcp_servers.github.env]",
      'TOKEN = "a"',
      "",
      "[mcp_servers.github.env.deep]",
      "LEVEL = 2",
      "",
      "[mcp_servers.other]",
      'command = "y"',
      "",
    ].join("\n");
    const merged = adapter.merge(text, "github", adapter.entry("github"));
    expect(merged).toContain('command = "npx"');
    expect(merged).not.toContain('"old"');
    expect(merged).toContain('model = "gpt"');
    expect(merged).toContain("[mcp_servers.github.env]");
    expect(merged).toContain('TOKEN = "a"');
    expect(merged).toContain("[mcp_servers.github.env.deep]");
    expect(merged).toContain("LEVEL = 2");
    expect(merged).toContain("[mcp_servers.other]");
    expect(merged).toContain('command = "y"');
    expect(merged).toContain('\n\n[mcp_servers.github.env]');
    expect(adapter.merge(merged, "github", adapter.entry("github"))).toBe(merged);
  });

  it("codex resolves legacy sections by their body and refuses foreign preferred keys", () => {
    const adapter = getAdapter("codex");
    const foreign = '[mcp_servers.github]\ncommand = "x"\nargs = []\n';
    expect(adapter.resolveName(foreign, "github", false)).toBeNull();
    expect(adapter.resolveName(foreign, "github", true)).toBeNull();

    const owned = '[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "@kurvcygnus/github-fetcher@latest"]\n';
    expect(adapter.resolveName(owned, "github", false)).toBe("github");
    expect(adapter.resolveName(owned, "github", true)).toBe("github");

    const legacy = `${foreign}\n[mcp_servers.github-fetcher]\ncommand = "node"\nargs = ["D:/Code/TS/github-fetcher/dist/index.js"]\n`;
    expect(adapter.resolveName(legacy, "github", false)).toBe("github-fetcher");
    expect(adapter.resolveName(legacy, "github", true)).toBeNull();
  });

  it("codex ignores package-like comments inside an argument array", () => {
    const adapter = getAdapter("codex");
    const foreign = [
      "[mcp_servers.github]",
      'command = "node"',
      "args = [",
      '  # "@kurvcygnus/github-fetcher@latest"',
      '  "other-server"',
      "]",
      "",
    ].join("\n");
    expect(adapter.resolveName(foreign, "github", false)).toBeNull();
    expect(adapter.resolveName(foreign, "github", true)).toBeNull();
  });

  it("codex keeps multiline array elements in the body while finding the next section", () => {
    const adapter = getAdapter("codex");
    const text = [
      "[mcp_servers.github]",
      'command = "x"',
      "values = [",
      '  ["a"],',
      "  [1,2],",
      "]",
      "",
      "[mcp_servers.other]",
      "values = [",
      '  ["keep"],',
      "]",
      "",
    ].join("\n");
    const removed = adapter.remove(text, "github");
    expect(removed).not.toContain("[mcp_servers.github]");
    expect(removed).not.toContain('"a"');
    expect(removed).toBe('[mcp_servers.other]\nvalues = [\n  ["keep"],\n]\n');
  });

  it("codex removes sub-tables that belong to the removed entry", () => {
    const adapter = getAdapter("codex");
    const text = [
      "[mcp_servers.github]",
      'command = "x"',
      "",
      "[mcp_servers.github.env]",
      'TOKEN = "a"',
      "",
      "[mcp_servers.github.env.deep]",
      "LEVEL = 2",
      "",
      "[mcp_servers.other]",
      'command = "y"',
      "",
    ].join("\n");
    const removed = adapter.remove(text, "github");
    expect(removed).toBe('[mcp_servers.other]\ncommand = "y"\n');
    expect(removed).not.toMatch(/\[mcp_servers\.github[.\]]/);
  });

  it("codex normalizes only the section seam and preserves CRLF", () => {
    const adapter = getAdapter("codex");
    const lf = '[mcp_servers.github]\ncommand = "x"\n\n[keep]\na = 1\n\n\nb = 2\n';
    expect(adapter.remove(lf, "github")).toBe("[keep]\na = 1\n\n\nb = 2\n");
    const crlf = 'model = "gpt"\r\n\r\n[mcp_servers.github]\r\ncommand = "x"\r\n\r\n[mcp_servers.other]\r\nkey = 1\r\n';
    expect(adapter.remove(crlf, "github")).toBe('model = "gpt"\r\n\r\n[mcp_servers.other]\r\nkey = 1\r\n');
  });

  it("codex ignores brackets in comments before the entry", () => {
    const adapter = getAdapter("codex");
    const text = '# see [docs\n[mcp_servers.github]\ncommand = "x"\n';
    expect(adapter.hasEntry(text, "github")).toBe(true);
    const merged = adapter.merge(text, "github", adapter.entry("github"));
    expect(merged).toContain("# see [docs");
    expect(merged).toContain('command = "npx"');
  });

  it("codex keeps the next section when a comment has an unmatched bracket", () => {
    const adapter = getAdapter("codex");
    const text = '[mcp_servers.github]\ncommand = "x" # [note\n\n[other]\nkey = 1\n';
    expect(adapter.remove(text, "github")).toBe("[other]\nkey = 1\n");
  });

  it("codex ignores header-like text inside multiline strings", () => {
    const adapter = getAdapter("codex");
    const basic = 'note = """\n[mcp_servers.github]\n"""\n\n[mcp_servers.other]\ncommand = "y"\n';
    expect(adapter.hasEntry(basic, "github")).toBe(false);
    const merged = String(adapter.merge(basic, "github", adapter.entry("github")));
    expect(merged.match(/\[mcp_servers\.github\]/g)).toHaveLength(2);
    expect(merged).toContain("[mcp_servers.other]");
    const literal = "note = '''\n[mcp_servers.github]\n'''\n\n[mcp_servers.other]\ncommand = \"y\"\n";
    expect(adapter.hasEntry(literal, "github")).toBe(false);
    expect(adapter.remove(literal, "github")).toBe(literal);
  });

  it("resolves legacy entry names from package and local-dist commands", () => {
    const opencode = getAdapter("opencode");
    expect(opencode.resolveName({
      mcp: { "github-fetcher": { type: "local", command: ["node", "D:/Code/TS/github-fetcher/dist/index.js"] } },
    }, "github", false)).toBe("github-fetcher");
    expect(opencode.resolveName({
      mcp: {
        "github-fetcher": {
          type: "local",
          command: ["node", "D:/cache/node_modules/@kurvcygnus/github-fetcher/dist/index.js"],
        },
      },
    }, "github", false)).toBe("github-fetcher");
    expect(opencode.resolveName({
      mcp: { pinned: { type: "local", command: ["npx", "-y", "@kurvcygnus/github-fetcher"] } },
    }, "github", false)).toBe("pinned");
    expect(opencode.resolveName({ mcp: { other: { command: ["node"] } } }, "github", false)).toBe("github");
    expect(opencode.resolveName({ mcp: { github: { command: ["node", "/x/github-fetcher/dist/index.js"] } } }, "github", false))
      .toBe("github");
    expect(opencode.resolveName({ mcp: { github: { command: ["node", "/x/github-fetcher/dist/index.js"] } } }, "github", true))
      .toBe("github");

    const cursor = getAdapter("cursor");
    expect(cursor.resolveName({
      mcpServers: { legacy: { command: "npx", args: ["-y", "@kurvcygnus/github-fetcher@latest"] } },
    }, "github", false)).toBe("legacy");
    expect(cursor.resolveName({
      mcpServers: { legacy: { command: "node", args: ["C:\\tools\\github-fetcher\\dist\\index.js"] } },
    }, "github", false)).toBe("legacy");
    expect(cursor.resolveName({
      mcpServers: { legacy: { command: "node", args: ["C:\\tools\\dist\\index.js"] } },
    }, "github", false)).toBe("github");
    expect(getAdapter("codex").resolveName("[mcp_servers.legacy]\n", "github", false)).toBe("github");
    expect(getAdapter("codex").resolveName("[mcp_servers.legacy]\n", "github", true)).toBe("github");
  });

  it("refuses to overwrite a foreign preferred key and reuses an owned legacy key", () => {
    const opencode = getAdapter("opencode");
    const foreignOnly = { mcp: { github: { type: "local", command: ["stale"] } } };
    expect(opencode.resolveName(foreignOnly, "github", false)).toBeNull();
    expect(opencode.resolveName(foreignOnly, "github", true)).toBeNull();

    const foreignAndLegacy = {
      mcp: {
        github: { type: "local", command: ["stale"] },
        "github-fetcher": { type: "local", command: ["node", "D:/Code/TS/github-fetcher/dist/index.js"] },
      },
    };
    expect(opencode.resolveName(foreignAndLegacy, "github", false)).toBe("github-fetcher");
    expect(opencode.resolveName(foreignAndLegacy, "github", true)).toBeNull();
    expect(opencode.resolveName({ mcp: { other: { command: ["node"] } } }, "custom", true)).toBe("custom");
  });

  it("does not resolve unrelated dist builds or package lookalikes", () => {
    const opencode = getAdapter("opencode");
    expect(opencode.resolveName({
      mcp: {
        "other-server": {
          type: "local",
          command: ["node", "D:/Code/TS/other-server/dist/index.js"],
        },
      },
    }, "github", false)).toBe("github");
    expect(opencode.resolveName({
      mcp: { clone: { type: "local", command: ["npx", "-y", "@kurvcygnus/github-fetcher-clone"] } },
    }, "github", false)).toBe("github");
    expect(opencode.resolveName({
      mcp: { legacy: { type: "local", command: ["node", "D:/Code/TS/my-github-fetcher/dist/index.js"] } },
    }, "github", false)).toBe("github");
  });

  it("detects empty configs without discarding surviving keys", () => {
    const opencode = getAdapter("opencode");
    expect(opencode.isEmpty({ mcp: {} })).toBe(true);
    expect(opencode.isEmpty({ mcp: {}, $schema: "x" })).toBe(false);
    expect(opencode.isEmpty({ mcp: { other: { command: ["x"] } } })).toBe(false);
    expect(getAdapter("cursor").isEmpty({ mcpServers: {} })).toBe(true);
    expect(getAdapter("cursor").isEmpty({ mcpServers: { other: { command: "x" } } })).toBe(false);
    expect(getAdapter("codex").isEmpty("")).toBe(true);
    expect(getAdapter("codex").isEmpty("  \n")).toBe(true);
    expect(getAdapter("codex").isEmpty('model = "gpt"\n')).toBe(false);
  });

  it("keeps __proto__ names as own JSON properties", () => {
    const adapter = getAdapter("opencode");
    const merged = adapter.merge({}, "__proto__", adapter.entry("github"));
    expect(JSON.stringify(merged)).toContain('"__proto__"');
  });
});
