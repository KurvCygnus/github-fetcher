import { z } from "zod";
import { createToolContext } from "../core/context.js";
import type { ToolContext } from "../core/context.js";
import { GithubError, toGithubError } from "../core/errors.js";
import type { ErrorCode } from "../core/errors.js";
import { tools } from "../tools/index.js";
import { CliUsageError, parseArgs } from "./argv.js";
import { subcommandSpec, usageFor } from "./subcommands.js";

export interface RunCliDeps {
  createRuntime?: typeof createToolContext;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

//* Family exit codes: usage 2, rate limit 3, auth 4, not found 5, network 6, upstream 7.
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

export async function runCli(argv: string[], deps: RunCliDeps): Promise<number> {
  const [subcommand, ...rest] = argv;
  const spec = subcommandSpec(subcommand);
  if (!spec) {
    deps.stderr.write(usageFor(subcommand));
    return 2;
  }
  try {
    const parsed = parseArgs(spec, rest);
    if (spec.tool === "github_api_get" && Array.isArray(parsed.input.query)) {
      //? github_api_get wants a key/value record while the CLI accepts comma-joined pairs;
      //? values containing commas are unsupported, which the usage text documents.
      const record: Record<string, string> = {};
      //? string-array flags only ever carry strings out of convertValue
      for (const pair of parsed.input.query as string[]) {
        const eq = pair.indexOf("=");
        if (eq <= 0) throw new GithubError("invalid_params", `--query entries must be key=value: ${pair}`);
        record[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
      parsed.input.query = record;
    }
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
    return reportError(deps, toGithubError(error));
  }
}
