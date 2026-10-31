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

  it("splits comma arrays and parses numbers", () => {
    const parsed = parseArgs(SUBCOMMANDS.issues, ["o/r", "--labels", "bug,help-wanted", "--page", "2"]);
    expect(parsed.input).toEqual({ repo: "o/r", labels: ["bug", "help-wanted"], page: 2 });
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

  it("covers all twenty tools", () => {
    expect(Object.keys(SUBCOMMANDS)).toHaveLength(20);
  });
});
