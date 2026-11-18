import { matchFileLines, type GrepResult } from "./file-grep.js";

//? Wire format of the eval worker: the handler posts exactly one GrepJob and
//* receives exactly one GrepMessage back. A thrown RegExp syntax error inside
//* matchFileLines lands on the error channel carrying the engine's raw message.
export interface GrepJob {
  pattern: string;
  text: string;
  contextLines: number;
  maxMatches: number;
}

export type GrepMessage = { ok: true; result: GrepResult } | { ok: false; error: string };

//? Eval-worker source. node:worker_threads has no `self` global, so the source
//* aliases the parent port to the web-worker-shaped name and uses the web event
//* form (onmessage receives an event whose .data is the posted job). The match
//* loop is embedded via toString() so the algorithm exists once in typechecked
//* source: tsc emits plain JavaScript without minification and vitest's
//* transform strips types the same way, so the serialized body is the compiled
//* function itself in both environments — `new Worker(WORKER_SOURCE,
//* { eval: true })` needs no file URL. This is only sound because
//* matchFileLines never references module scope (RegExp, Math, Set are globals);
//* the function's doc comment pins that invariant. The circular import is safe:
//* WORKER_SOURCE is consumed inside the handler body, never at module load, and
//* matchFileLines is a hoisted function declaration, so whichever module body
//* runs first finds it initialized.
export const WORKER_SOURCE = `const self = require("node:worker_threads").parentPort;
const matchFileLines = ${matchFileLines.toString()};
self.onmessage = (job) => {
  try {
    self.postMessage({ ok: true, result: matchFileLines(job.data.pattern, job.data.text, job.data.contextLines, job.data.maxMatches) });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
`;
