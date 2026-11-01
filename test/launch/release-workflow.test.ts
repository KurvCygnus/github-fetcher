import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const text = readFileSync(".github/workflows/release.yml", "utf8").replace(/\r\n/g, "\n");

describe("release workflow", () => {
  it("runs on tags and manual dry-runs", () => {
    expect(text).toContain('tags: ["v*"]');
    expect(text).toContain("workflow_dispatch:");
    expect(text).toContain("dry_run:");
    expect(text).toContain("default: true");
  });

  it("scopes write permissions and environment gating to publishing", () => {
    expect(text).toContain("permissions:\n  contents: read");
    expect(text).toContain("needs: verify");
    expect(text).toContain("environment: npm-publish");
    expect(text).toContain("permissions:\n      contents: write\n      id-token: write");
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
    expect(text).toContain("timeout-minutes:");
  });

  it("publishes safely with provenance and a token fallback", () => {
    expect(text).toContain("npm publish --provenance --access public");
    expect(text).toContain("Detect fallback token");
    expect(text).toContain("NPM_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(text).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(text).toContain('NODE_AUTH_TOKEN: ""');
    expect(text).toContain("::warning::NPM_TOKEN");
    expect(text).toContain("ACTIONS_ID_TOKEN_REQUEST_URL");
    expect(text).toContain("steps.auth.outputs.fallback == 'false'");
    expect(text).toContain("steps.auth.outputs.fallback == 'true'");
    expect(text).toContain("steps.published.outputs.exists == 'false'");
    expect(text).toContain("npm view");
    expect(text).toContain("manual publish is only allowed from main");
    expect(text).toContain("github.ref != 'refs/heads/main'");
    expect(text).toContain("fetch-depth: 0");
    expect(text).toContain("git merge-base --is-ancestor \"$GITHUB_SHA\" origin/main");
    expect(text).toContain('test "$(git rev-parse "$TAG^{commit}")" = "$GITHUB_SHA"');
    expect(text).toContain('test "v$VERSION" = "$TAG_NAME"');
    expect(text).toContain("missing changelog version");
    expect(text).toContain("Tarball:");
    expect(text).toContain("SHA-256:");
    expect(text).toContain("sha256sum");
    expect(text).toContain("Would run: npm publish --provenance --access public");
    expect(text).toContain("--verify-tag");
    expect(text).toContain("gh release create");
    expect(text).toContain("inputs.dry_run == false");
    expect(text).toContain("release-npm");
    expect(text).toContain("persist-credentials: false");
    const publishJob = text.indexOf("  publish:");
    expect(text.indexOf("- run: npm ci", publishJob)).toBeGreaterThan(text.indexOf("Guard release ancestry", publishJob));
    expect(text.indexOf("- run: npm ci", publishJob)).toBeGreaterThan(text.indexOf("Verify release tag", publishJob));
  });
});
