#!/usr/bin/env node
import { runEntry } from "./cli/entry.js";

runEntry(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
}).then(
  (code) => {
    //? exitCode (not exit) lets the event loop drain so piped stdout always flushes;
    //? undici keep-alive sockets may delay exit by a few seconds, which is acceptable.
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
