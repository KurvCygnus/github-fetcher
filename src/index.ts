#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runCli } from "./cli/run.js";
import { subcommandSpec, usageFor } from "./cli/subcommands.js";
import { createGithubServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const [, , first, ...rest] = process.argv;
  if (first === undefined || first === "serve") {
    const server = await createGithubServer();
    await server.connect(new StdioServerTransport());
    return;
  }
  if (first === "--help" || first === "-h" || first === "help") {
    process.stdout.write(usageFor(undefined));
    process.exitCode = 0;
    return;
  }
  if (subcommandSpec(first) !== undefined) {
    //? exitCode (not exit) lets the event loop drain so piped stdout always flushes;
    //? undici keep-alive sockets may delay exit by a few seconds, which is acceptable.
    process.exitCode = await runCli([first, ...rest], {
      stdout: process.stdout,
      stderr: process.stderr,
    });
    return;
  }
  process.stderr.write(usageFor(first));
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
