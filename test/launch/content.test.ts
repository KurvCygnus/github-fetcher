import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const draftPaths = [
  ".superpowers/launch/video-script.md",
  ".superpowers/launch/video-shotlist.md",
  ".superpowers/launch/article-draft.md",
] as const;
const hasDrafts = draftPaths.every((path) => existsSync(path));
if (process.env.REQUIRE_LAUNCH_DRAFTS === "1" && !hasDrafts) {
  throw new Error(`missing launch drafts: ${draftPaths.filter((path) => !existsSync(path)).join(", ")}`);
}
const canCheckDrafts = hasDrafts;
const script = hasDrafts ? readFileSync(draftPaths[0], "utf8") : "";
const shots = hasDrafts ? readFileSync(draftPaths[1], "utf8") : "";
const article = hasDrafts ? readFileSync(draftPaths[2], "utf8") : "";

describe.skipIf(!canCheckDrafts)("video script", () => {
  it("has the required beats and a real install command", () => {
    for (const marker of ["0:00", "0:20", "1:00", "2:00", "3:30", "4:30"]) {
      expect(script).toContain(marker);
    }
    expect(script).toContain("npx -y @kurvcygnus/github-fetcher@latest init");
    expect(script).toContain("作者自荐");
    expect(script).not.toMatch(/求\s*star|点个\s*star|star\s*支持/i);
  });

  it("has a shot list with screen and narration columns", () => {
    expect(shots).toContain("| Time | Screen | Narration |");
    expect(shots).toContain("1080p");
  });
});

describe.skipIf(!canCheckDrafts)("article draft", () => {
  it("is a problem-first post with sourced numbers", () => {
    expect(article).toContain("403");
    expect(article).toContain("60 requests per hour");
    expect(article).toContain("raw.githubusercontent.com");
    expect(article).toContain("## Limitations");
    expect(article).toContain("docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api");
  });
});
