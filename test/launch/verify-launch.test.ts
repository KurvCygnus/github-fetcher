import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyLaunch } from "../../scripts/verify-launch.mjs";

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "launch-verify-"));
  roots.push(root);
  await mkdir(join(root, "src/core"), { recursive: true });
  await mkdir(join(root, "src/tools"), { recursive: true });

  const pkg = {
    name: "@kurvcygnus/github-fetcher",
    version: "0.2.0",
    mcpName: "io.github.KurvCygnus/github-fetcher",
    engines: { node: ">=22.19.0" },
    files: ["dist", "README.md", "README.zh-CN.md", "LICENSE", "CHANGELOG.md"],
    scripts: { "verify:launch": "node scripts/verify-launch.mjs" },
  };
  await writeFile(join(root, "package.json"), JSON.stringify(pkg));
  await writeFile(join(root, "src/core/version.ts"), 'export const VERSION = "0.2.0";\n');
  await writeFile(join(root, "src/tools/registry.ts"), "export const EXPECTED_TOOL_COUNT = 22;\n");

  const tools = Array.from({ length: 22 }, (_, index) => `github_tool_${index}`).join(", ");
  await writeFile(join(root, "README.md"), [
    "# Test",
    "## Built for mainland China networks",
    "## Comparison with the official server",
    "## Limitations",
    "npx -y @kurvcygnus/github-fetcher@latest",
    tools,
  ].join("\n"));
  await writeFile(join(root, "README.zh-CN.md"), [
    "# Test",
    "## 为中国大陆网络而构建",
    "## 与官方 server 的对比",
    "## 限制",
    "npx -y @kurvcygnus/github-fetcher@latest",
    "https://github.com/KurvCygnus/github-fetcher/blob/main/README.zh-CN.md",
    tools,
  ].join("\n"));
  await writeFile(join(root, "CHANGELOG.md"), "## [0.2.0]\n");
  await writeFile(join(root, "SECURITY.md"), "# Security\n");
  await writeFile(join(root, "CONTRIBUTING.md"), "# Contributing\n");
  await writeFile(join(root, "server.json"), JSON.stringify({
    name: "io.github.KurvCygnus/github-fetcher",
    version: "0.2.0",
    packages: [{ identifier: "@kurvcygnus/github-fetcher", version: "0.2.0", transport: { type: "stdio" } }],
  }));
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("verifyLaunch", () => {
  it("accepts a consistent fixture", async () => {
    const result = await verifyLaunch({ root: await fixture(), offline: true });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects a stale tool count", async () => {
    const root = await fixture();
    const current = await readFile(join(root, "README.md"), "utf8");
    await writeFile(join(root, "README.md"), current.replace("github_tool_21", "20 tools"));
    const result = await verifyLaunch({ root, offline: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("stale tool count");
  });

  it("rejects a missing China section", async () => {
    const root = await fixture();
    const current = await readFile(join(root, "README.md"), "utf8");
    await writeFile(join(root, "README.md"), current.replace("## Built for mainland China networks", "## Introduction"));
    const result = await verifyLaunch({ root, offline: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("README.md missing heading");
  });

  it("rejects a Node floor below the runtime dependency", async () => {
    const root = await fixture();
    const current = await readFile(join(root, "package.json"), "utf8");
    await writeFile(join(root, "package.json"), current.replace(">=22.19.0", ">=20.18"));
    const result = await verifyLaunch({ root, offline: true });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("engines.node must be >=22.19.0");
  });
});
