import { describe, expect, it } from "vitest";
import { CliUsageError, parseArgs } from "../../src/cli/argv.js";
import { SUBCOMMANDS } from "../../src/cli/subcommands.js";

describe("parseArgs", () => {
  it("maps positionals and converts flag kinds", () => {
    const parsed = parseArgs(SUBCOMMANDS.releases, ["o/r", "--per-page", "5", "--pretty"]);
    expect(parsed.input).toEqual({ repo: "o/r", per_page: 5 });
    expect(parsed.pretty).toBe(true);
    expect(parsed.help).toBe(false);
  });

  it("splits comma arrays for array flags and passes strings through for string flags", () => {
    const health = parseArgs(SUBCOMMANDS.health, ["o/r", "--labels", "bug,help-wanted", "--window-days", "7"]);
    expect(health.input).toEqual({ repo: "o/r", labels: ["bug", "help-wanted"], window_days: 7 });
    const issues = parseArgs(SUBCOMMANDS.issues, ["o/r", "--labels", "bug,help-wanted", "--page", "2"]);
    expect(issues.input).toEqual({ repo: "o/r", labels: "bug,help-wanted", page: 2 });
  });

  it("treats bare flags as booleans", () => {
    const parsed = parseArgs(SUBCOMMANDS.issue, ["o/r", "7", "--include-comments", "--fresh"]);
    expect(parsed.input).toEqual({ repo: "o/r", number: 7, include_comments: true, fresh: true });
  });

  it("rejects unknown flags, missing positionals, and extra tokens", () => {
    expect(() => parseArgs(SUBCOMMANDS.repo, ["o/r", "--nope"])).toThrow(CliUsageError);
    expect(() => parseArgs(SUBCOMMANDS.repo, [])).toThrow(CliUsageError);
    expect(() => parseArgs(SUBCOMMANDS.repo, ["o/r", "extra"])).toThrow(CliUsageError);
    expect(() => parseArgs(SUBCOMMANDS.releases, ["o/r", "--per-page", "abc"])).toThrow(CliUsageError);
  });

  it("leaves release's optional tag absent and maps it when provided", () => {
    const latest = parseArgs(SUBCOMMANDS.release, ["o/r"]);
    expect(latest.input).toEqual({ repo: "o/r" });
    const tagged = parseArgs(SUBCOMMANDS.release, ["o/r", "v1.2.3"]);
    expect(tagged.input).toEqual({ repo: "o/r", tag: "v1.2.3" });
  });

  it("covers all twenty tools", () => {
    expect(Object.keys(SUBCOMMANDS)).toHaveLength(20);
  });
});
