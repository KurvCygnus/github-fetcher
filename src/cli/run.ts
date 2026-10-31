import { z } from "zod";
import { createToolContext } from "../core/context.js";
import type { ToolContext } from "../core/context.js";
import { GithubError, toGithubError } from "../core/errors.js";
import type { ErrorCode } from "../core/errors.js";
import { tools } from "../tools/index.js";
import { CliUsageError, parseArgs } from "./argv.js";
import type { ParsedArgs } from "./argv.js";
import type { SubcommandSpec } from "./subcommands.js";
import { subcommandSpec, usageFor } from "./subcommands.js";

export interface RunCliDeps {
  createRuntime?: typeof createToolContext;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

//* Family exit codes: usage 2, rate limit 3, auth 4, not found 5, network 6, upstream 7.
//* Exhaustive over ErrorCode, which makes `code in EXIT_CODES` a complete validity check.
const EXIT_CODES: Record<ErrorCode, number> = {
  invalid_params: 2,
  rate_limited: 3,
  auth_missing: 4,
  auth_failed: 4,
  not_found: 5,
  network: 6,
  upstream: 7,
  unsupported: 7,
};

function reportError(deps: RunCliDeps, error: GithubError): number {
  deps.stderr.write(JSON.stringify(error.toResult()) + "\n");
  return EXIT_CODES[error.code] ?? 1;
}

function isErrorCode(code: string): code is ErrorCode {
  return code in EXIT_CODES;
}

//? Some layers surface plain Errors that already carry a family code; toGithubError would
//? collapse those to "network", so lift the code back onto the family first. Real
//? GithubError instances never reach this path (the instanceof branch handles them).
function codedError(error: unknown): GithubError | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !isErrorCode(code)) return undefined;
  return new GithubError(code, error.message);
}

//? Two tools take composite values the argv layer cannot express directly: github_api_get
//? wants a key/value record, and github_issues documents labels as one comma-joined string
//? (unlike github_repo_health, whose schema takes a real array). Both arrive as string
//? arrays because the flag kinds are string-array; reshape them before schema validation
//? so the tools keep their MCP-facing schemas untouched. Flag values containing commas
//? are unsupported, which the usage text documents.
function reshapeFlagValues(spec: SubcommandSpec, parsed: ParsedArgs): void {
  if (spec.tool === "github_api_get" && Array.isArray(parsed.input.query)) {
    const record: Record<string, string> = {};
    //? string-array flags only ever carry strings out of convertValue
    for (const pair of parsed.input.query as string[]) {
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new GithubError("invalid_params", `--query entries must be key=value: ${pair}`);
      record[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    parsed.input.query = record;
  }
  if (spec.tool === "github_issues" && Array.isArray(parsed.input.labels)) {
    //? string-array flags only ever carry strings out of convertValue
    parsed.input.labels = (parsed.input.labels as string[]).join(",");
  }
}

export async function runCli(argv: string[], deps: RunCliDeps): Promise<number> {
  const [subcommand, ...rest] = argv;
  const spec = subcommandSpec(subcommand);
  if (!spec) {
    deps.stderr.write(usageFor(subcommand));
    return 2;
  }
  try {
    const parsed = parseArgs(spec, rest);
    reshapeFlagValues(spec, parsed);
    if (parsed.help) {
      deps.stdout.write(usageFor(subcommand));
      return 0;
    }
    const tool = tools.find((definition) => definition.name === spec.tool);
    if (!tool) throw new GithubError("unsupported", `tool ${spec.tool} is not registered`);
    const validated = z.object(tool.inputSchema).safeParse(parsed.input);
    if (!validated.success) {
      const detail = validated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      throw new GithubError("invalid_params", detail);
    }
    const createRuntime = deps.createRuntime ?? createToolContext;
    const ctx: ToolContext = await createRuntime();
    const result = await tool.handler(validated.data as never, ctx);
    deps.stdout.write(JSON.stringify(result, null, parsed.pretty ? 2 : 0) + "\n");
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      //? Usage mistakes are the CLI's invalid_params: same family and exit code as a
      //? schema rejection, so scripts can treat both identically.
      return reportError(deps, new GithubError("invalid_params", error.message));
    }
    if (error instanceof GithubError) {
      return reportError(deps, error);
    }
    if (error instanceof Error && error.name === "ZodError") {
      return reportError(deps, new GithubError("invalid_params", error.message));
    }
    const coded = codedError(error);
    if (coded) {
      return reportError(deps, coded);
    }
    return reportError(deps, toGithubError(error));
  }
}
