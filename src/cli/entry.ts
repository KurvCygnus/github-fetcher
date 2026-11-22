import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "../core/version.js";
import { createGithubServer } from "../mcp/server.js";
import type { DaemonCliDeps } from "./daemon.js";
import { runDaemonCommand, runServeDaemon } from "./daemon.js";
import { runInit } from "./init.js";
import { runRemove } from "./remove.js";
import { runCli } from "./run.js";
import { subcommandSpec, usageFor } from "./subcommands.js";

export type EntryDeps = DaemonCliDeps;

export async function runEntry(argv: string[], deps: EntryDeps): Promise<number> {
  const [first, ...rest] = argv;
  if (first === "serve" && rest[0] === "--daemon") return runServeDaemon(deps);
  if (first === undefined || first === "serve") {
    const server = await createGithubServer();
    await server.connect(new StdioServerTransport());
    return 0;
  }
  if (first === "--help" || first === "-h" || first === "help") {
    deps.stdout.write(usageFor(undefined));
    return 0;
  }
  if (first === "--version" || first === "-v") {
    deps.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (first === "init") return runInit(rest, deps);
  if (first === "remove") return runRemove(rest, deps);
  if (first === "daemon") return runDaemonCommand(rest, deps);
  if (subcommandSpec(first) !== undefined) return runCli([first, ...rest], deps);
  deps.stderr.write(usageFor(first));
  return 2;
}
