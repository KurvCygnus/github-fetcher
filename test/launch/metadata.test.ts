import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  name: string;
  version: string;
  description: string;
  mcpName?: string;
  keywords: string[];
  author: { name: string; url?: string };
  publishConfig?: { access?: string };
  files: string[];
};
const server = JSON.parse(readFileSync("server.json", "utf8")) as {
  $schema: string;
  name: string;
  title: string;
  description: string;
  websiteUrl: string;
  repository: { url: string; source: string };
  version: string;
  packages: Array<{
    registryType: string;
    identifier: string;
    version: string;
    transport: { type: string };
    environmentVariables?: Array<{
      name: string;
      isRequired: boolean;
      isSecret: boolean;
      format?: string;
    }>;
  }>;
};

describe("package metadata", () => {
  it("identifies the published package and its registry name", () => {
    expect(pkg.name).toBe("@kurvcygnus/github-fetcher");
    expect(pkg.version).toBe("0.2.1");
    expect(pkg.mcpName).toBe("io.github.KurvCygnus/github-fetcher");
    expect(pkg.publishConfig?.access).toBe("public");
    expect(pkg.author).toEqual({ name: "Kurv Cygnus", url: "https://github.com/KurvCygnus" });
  });

  it("describes the narrow, read-only positioning", () => {
    expect(pkg.description).toContain("Read-only GitHub MCP server");
    expect(pkg.description).toContain("unreliable networks");
    expect(pkg.description).toContain("34 tools");
  });

  it("ships the intended files only", () => {
    expect(pkg.files).toEqual(["dist", "README.md", "README.zh-CN.md", "LICENSE", "CHANGELOG.md"]);
    for (const forbidden of ["docs", "test", ".superpowers", "scripts"]) {
      expect(pkg.files).not.toContain(forbidden);
    }
  });

  it("lists the launch keywords", () => {
    for (const keyword of [
      "mcp", "mcp-server", "model-context-protocol", "github", "github-mcp",
      "read-only", "proxy", "rate-limit", "etag-cache", "china", "typescript", "cli", "ai-agents",
    ]) {
      expect(pkg.keywords).toContain(keyword);
    }
  });
});

describe("server.json", () => {
  it("matches the package identity and version", () => {
    expect(server.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
    expect(server.name).toBe(pkg.mcpName);
    expect(server.title).toBe("GitHub Fetcher");
    expect(server.websiteUrl).toBe("https://github.com/KurvCygnus/github-fetcher#readme");
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.repository).toEqual({
      url: "https://github.com/KurvCygnus/github-fetcher",
      source: "github",
    });
    expect(server.version).toBe(pkg.version);
  });

  it("publishes the npm package over stdio with optional secrets", () => {
    expect(server.packages).toHaveLength(1);
    const entry = server.packages[0]!;
    expect(entry).toMatchObject({
      registryType: "npm",
      identifier: "@kurvcygnus/github-fetcher",
      version: "0.2.1",
      transport: { type: "stdio" },
    });
    const env = entry.environmentVariables ?? [];
    expect(env.map((item) => item.name)).toEqual(["GITHUB_TOKEN", "GH_TOKEN"]);
    for (const item of env) {
      expect(item.isRequired).toBe(false);
      expect(item.isSecret).toBe(true);
      expect(item.format).toBe("string");
    }
  });
});
