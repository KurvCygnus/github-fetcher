import { z } from "zod";
import { describe, expect, it } from "vitest";
import { CliUsageError, parseArgs } from "../../src/cli/argv.js";
import { SUBCOMMANDS } from "../../src/cli/subcommands.js";
import { tools } from "../../src/tools/index.js";

//? Zod 4 wraps .optional() fields in a ZodOptional schema and instanceof cannot see through
//? the wrapper, so a number flag whose schema is z.number().optional() would fail a bare
//? ZodNumber check. Strip the wrapper first; this is the same optionality the signature
//? guard in capabilities.test.ts derives its "?" marker from.
function bareType(field: z.ZodType): z.ZodType {
  return field instanceof z.ZodOptional ? bareType(field.unwrap() as z.ZodType) : field;
}

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

  it("returns help without required positionals so per-tool --help is reachable", () => {
    const bare = parseArgs(SUBCOMMANDS.release, ["--help"]);
    expect(bare.help).toBe(true);
    expect(bare.input).toEqual({});
    expect(bare.pretty).toBe(false);
  });

  it("keeps positionals parsed before the --help token", () => {
    const parsed = parseArgs(SUBCOMMANDS.repo, ["o/r", "--help"]);
    expect(parsed.help).toBe(true);
    expect(parsed.input.repo).toBe("o/r");
  });

  it("leaves release's optional tag absent and maps it when provided", () => {
    const latest = parseArgs(SUBCOMMANDS.release, ["o/r"]);
    expect(latest.input).toEqual({ repo: "o/r" });
    const tagged = parseArgs(SUBCOMMANDS.release, ["o/r", "v1.2.3"]);
    expect(tagged.input).toEqual({ repo: "o/r", tag: "v1.2.3" });
  });

  it("parses variadic compare-repos values and the new v0.3 parameters", () => {
    const compare = parseArgs(SUBCOMMANDS["compare-repos"], ["o/a", "o/b", "o/c", "--window-days", "7"]);
    expect(compare.input).toEqual({ repos: ["o/a", "o/b", "o/c"], window_days: 7 });
    expect(parseArgs(SUBCOMMANDS.capabilities, []).input).toEqual({});
    expect(parseArgs(SUBCOMMANDS.rate, ["--resource", "core"]).input).toEqual({ resource: "core" });
    expect(parseArgs(SUBCOMMANDS.issues, ["o/r", "--type", "all", "--labels", "bug"]).input).toEqual({ repo: "o/r", type: "all", labels: "bug" });
    expect(parseArgs(SUBCOMMANDS.issue, ["o/r", "7", "--comment-limit", "5", "--max-comment-chars", "80"]).input).toEqual({
      repo: "o/r",
      number: 7,
      comment_limit: 5,
      max_comment_chars: 80,
    });
    expect(parseArgs(SUBCOMMANDS["compare-repos"], ["o/a", "--fresh", "o/b"]).input).toEqual({ repos: ["o/a", "o/b"], fresh: true });
    expect(() => parseArgs(SUBCOMMANDS["compare-repos"], [])).toThrow(CliUsageError);
  });

  it("covers all twenty-two tools", () => {
    expect(Object.keys(SUBCOMMANDS)).toHaveLength(22);
  });

  it("parses the 0.2.1 parameters", () => {
    expect(parseArgs(SUBCOMMANDS["search-repos"], ["q", "--public-only"]).input).toEqual({
      query: "q",
      public_only: true,
    });
    expect(parseArgs(SUBCOMMANDS.file, ["o/r", "README.md", "--start-line", "2", "--end-line", "4"]).input).toEqual({
      repo: "o/r",
      path: "README.md",
      start_line: 2,
      end_line: 4,
    });
    expect(parseArgs(SUBCOMMANDS.tree, ["o/r", "--max-entries", "50"]).input).toEqual({
      repo: "o/r",
      max_entries: 50,
    });
  });

  it("covers every tool input with a positional or flag of a compatible kind", () => {
    for (const [name, spec] of Object.entries(SUBCOMMANDS)) {
      const tool = tools.find((definition) => definition.name === spec.tool);
      expect(tool, name).toBeDefined();
      const shape = tool!.inputSchema as Record<string, z.ZodType>;
      const cliKeys = new Set<string>([
        ...spec.positional.map((slot) => slot.key),
        ...Object.keys(spec.flags).map((flag) => flag.replace(/-/g, "_")),
      ]);
      expect([...cliKeys].sort(), `${name} keys`).toEqual(Object.keys(shape).sort());
      for (const [flag, kind] of Object.entries(spec.flags)) {
        const field = bareType(shape[flag.replace(/-/g, "_")]!);
        if (kind === "number") expect(field instanceof z.ZodNumber, `${name}.${flag}`).toBe(true);
        if (kind === "boolean") expect(field instanceof z.ZodBoolean, `${name}.${flag}`).toBe(true);
        //? github_api_get's --query takes comma-joined key=value pairs that run.ts folds into
        //? a record before validation, so a record schema is as compatible with a string-array
        //? flag as an array schema is.
        if (kind === "string-array") {
          expect(field instanceof z.ZodArray || field instanceof z.ZodRecord, `${name}.${flag}`).toBe(true);
        }
      }
      for (const slot of spec.positional) {
        if (slot.kind === "number") {
          const field = bareType(shape[slot.key]!);
          expect(field instanceof z.ZodNumber, `${name}.${slot.key}`).toBe(true);
        }
      }
    }
  });
});
