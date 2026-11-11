import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("issue templates", () => {
  it("asks for a redacted reproduction, never a token", () => {
    const bug = readFileSync(".github/ISSUE_TEMPLATE/bug_report.yml", "utf8");
    expect(bug).toContain("name: Bug report");
    expect(bug).toContain("OS");
    expect(bug).toContain("Client");
    expect(bug).toContain("Version");
    expect(bug).toContain("redact");
    expect(bug.toLowerCase()).not.toContain("paste your token");
    expect(bug.toLowerCase()).not.toContain("github_token:");
  });

  it("offers a focused feature request form", () => {
    const feature = readFileSync(".github/ISSUE_TEMPLATE/feature_request.yml", "utf8");
    expect(feature).toContain("name: Feature request");
    expect(feature).toContain("Problem");
    expect(feature).toContain("Proposal");
    expect(feature).toContain("read-only");
  });

  it("disables blank issues and links the README", () => {
    const config = readFileSync(".github/ISSUE_TEMPLATE/config.yml", "utf8");
    expect(config).toContain("blank_issues_enabled: false");
    expect(config).toContain("https://github.com/KurvCygnus/github-fetcher#readme");
  });
});

describe("social preview", () => {
  it("is a 1280x640 PNG", () => {
    const png = readFileSync("assets/social-preview.png");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(1280);
    expect(png.readUInt32BE(20)).toBe(640);
  });
});

describe("directory descriptions", () => {
  it("has a short English and Chinese directory description", () => {
    const en = readFileSync("assets/registry/description-en.md", "utf8").trim();
    const zh = readFileSync("assets/registry/description-zh.md", "utf8").trim();
    expect(en.split(/\s+/).length).toBeGreaterThanOrEqual(50);
    expect(en.split(/\s+/).length).toBeLessThanOrEqual(100);
    expect(zh.length).toBeGreaterThan(80);
    expect(zh.length).toBeLessThan(300);
  });
});

const launchKitPaths = [
  ".superpowers/launch/directories.md",
  ".superpowers/launch/facts.md",
  ".superpowers/launch/metrics.md",
];
const hasLaunchKit = launchKitPaths.every((path) => existsSync(path));
if (process.env.REQUIRE_LAUNCH_KIT === "1" && !hasLaunchKit) {
  throw new Error(`missing launch kit: ${launchKitPaths.filter((path) => !existsSync(path)).join(", ")}`);
}
const canCheckLaunchKit = hasLaunchKit;

describe.skipIf(!canCheckLaunchKit)("launch kit", () => {
  it("tracks the required directory targets and facts", () => {
    const directories = readFileSync(".superpowers/launch/directories.md", "utf8");
    for (const target of ["Official MCP Registry", "awesome-mcp-servers", "Smithery", "Glama", "mcp.so", "mcp.directory"]) {
      expect(directories).toContain(target);
    }
    const facts = readFileSync(".superpowers/launch/facts.md", "utf8");
    expect(facts).toContain("32 tools");
    expect(facts).toContain("60 requests/hour");
    expect(facts).toContain("5000 requests/hour");
    expect(existsSync(".superpowers/launch/metrics.md")).toBe(true);
  });
});
