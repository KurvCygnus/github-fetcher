import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const text = readFileSync(".github/workflows/release.yml", "utf8");

describe("release workflow", () => {
  it("runs on tags and manual dry-runs", () => {
    expect(text).toContain('tags: ["v*"]');
    expect(text).toContain("workflow_dispatch:");
    expect(text).toContain("dry_run:");
    expect(text).toContain("default: true");
  });

  it("has the permissions and environment gate npm publishing needs", () => {
    expect(text).toContain("contents: write");
    expect(text).toContain("id-token: write");
    expect(text).toContain("environment: npm-publish");
  });

  it("verifies on three platforms before publishing", () => {
    for (const os of ["ubuntu-latest", "windows-latest", "macos-latest"]) {
      expect(text).toContain(os);
    }
    expect(text).toContain("npm run typecheck");
    expect(text).toContain("npm test");
    expect(text).toContain("npm run build");
    expect(text).toContain("npm run smoke");
    expect(text).toContain("npm run verify:launch");
  });

  it("publishes with provenance and supports an optional token fallback", () => {
    expect(text).toContain("npm publish --provenance --access public");
    expect(text).toContain("Detect fallback token");
    expect(text).toContain("NPM_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(text).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(text).toContain("steps.auth.outputs.fallback == 'false'");
    expect(text).toContain("steps.auth.outputs.fallback == 'true'");
    expect(text).toContain("manual publish is only allowed from main");
    expect(text).toContain("github.ref != 'refs/heads/main'");
    expect(text).toContain("gh release create");
    expect(text).toContain("inputs.dry_run == false");
  });
});
