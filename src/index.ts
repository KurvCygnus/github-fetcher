#!/usr/bin/env node
import { runEntry } from "./cli/entry.js";

runEntry(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
