import { readFileSync } from "node:fs";
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
