import { Worker } from "node:worker_threads";
import { z } from "zod";
import { GithubError } from "../core/errors.js";
import { withGrepSlot } from "../core/grep-queue.js";
import { type ContentsPayload, decodeContents } from "./contents.js";
import { defineTool } from "./define.js";
import { type GrepJob, type GrepMessage, WORKER_SOURCE } from "./file-grep-worker.js";
import { responseMeta } from "./meta.js";
import { getPinnedRef } from "./pin.js";
import { resolveRef } from "./ref.js";
import { decodeUtf8, encodePath, githubQuery, parseRepo, truncateText } from "./util.js";

export interface GrepMatch {
  line: number;
  column: number;
  line_text: string;
  context: Array<{ line: number; text: string }>;
}

export interface GrepResult {
  matches: GrepMatch[];
  matches_truncated: boolean;
  total_lines: number;
}

//? The match loop is a pure function with a single home: the tool executes it
//? inside an eval worker (file-grep-worker.ts embeds it via toString()) and the
//? unit tests call it directly. It MUST stay self-contained — the worker
//? receives only this function's serialized source, so any reference to a
//? module-scope import here would be undefined in the worker context.
export function matchFileLines(pattern: string, text: string, contextLines: number, maxMatches: number): GrepResult {
  //? Invalid patterns throw the engine's raw message; the worker shell routes
  //* it to the error channel and the handler maps it to invalid_params.
  const regex = new RegExp(pattern, "gm");
  //* A line is a newline-separated segment (github_file semantics; a trailing
  //* newline produces a final empty line). lineStarts[i] is the text offset of
  //* segment i's first character, built once so the match loop maps each match
  //* to its line with a forward cursor instead of rescanning offsets.
  const segments = text.split("\n");
  const totalLines = segments.length;
  const lineStarts: number[] = [];
  let offset = 0;
  for (const segment of segments) {
    lineStarts.push(offset);
    offset += segment.length + 1;
  }

  const matches: GrepMatch[] = [];
  //* Every context line ever emitted is remembered, so a later match's range
  //* never repeats a line an earlier match already showed: overlap merges
  //* forward, the earlier match owning the shared lines. Match lines themselves
  //* stay outside the set — only context entries deduplicate.
  const emittedContext = new Set<number>();
  let truncated = false;
  let cursor = 0;
  for (let found = regex.exec(text); found !== null; found = regex.exec(text)) {
    if (matches.length === maxMatches) {
      //* The window is full and this exec still found a match, so more matches
      //* exist beyond the cap — the flag reports that honestly. Exactly at the
      //* cap with no further match, the loop ends unflagged.
      truncated = true;
      break;
    }
    //? An empty match leaves lastIndex unchanged, so the next exec would return
    //* the same match forever; stepping one character past it keeps the scan
    //* moving (past the text's end the next exec returns null and ends it).
    if (found.index === regex.lastIndex) regex.lastIndex += 1;
    while (cursor + 1 < lineStarts.length && (lineStarts[cursor + 1] ?? 0) <= found.index) {
      cursor += 1;
    }
    const line = cursor + 1;
    const context: Array<{ line: number; text: string }> = [];
    const first = Math.max(1, line - contextLines);
    const last = Math.min(totalLines, line + contextLines);
    for (let candidate = first; candidate <= last; candidate++) {
      if (candidate === line || emittedContext.has(candidate)) continue;
      emittedContext.add(candidate);
      context.push({ line: candidate, text: segments[candidate - 1] ?? "" });
    }
    matches.push({
      line,
      column: found.index - (lineStarts[cursor] ?? 0) + 1,
      line_text: segments[cursor] ?? "",
      context,
    });
  }

  return { matches, matches_truncated: truncated, total_lines: totalLines };
}

//? Module-private budget sentinel: runMatchInWorker rejects with it on timeout
//* and the handler translates exactly this class into the overrun degradation
//* shape; every other rejection propagates unchanged.
class GrepOverrun extends Error {
  constructor(timeoutMs: number) {
    super(`pattern execution exceeded the time budget (${timeoutMs} ms); narrow the pattern or read the file in windows`);
    this.name = "GrepOverrun";
  }
}

function asGrepMessage(value: unknown): GrepMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { ok?: unknown; result?: unknown; error?: unknown };
  //? The envelope is guarded shape-wise; the result payload itself comes from
  //* our own compiled matchFileLines through structured clone and is trusted.
  if (record.ok === true) return { ok: true, result: record.result as GrepResult };
  if (record.ok === false && typeof record.error === "string") return { ok: false, error: record.error };
  return null;
}

//? One match job on one eval worker, bounded by timeoutMs — the race the design
//? specifies: the worker-message promise (resolve on ok; invalid_params on
//? {ok:false} or on the worker 'error' event) races a timer rejection. settle is
//? the single exit, so the timer is always cleared when a message lands (no
//? unhandled rejection from the losing side) and the worker is terminated on
//? EVERY path: result, {ok:false}, 'error', and timeout.
function runMatchInWorker(job: GrepJob, timeoutMs: number): Promise<GrepResult> {
  return new Promise<GrepResult>((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const settle = (route: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      void worker.terminate();
      route();
    };
    worker.on("message", (value: unknown) => {
      const message = asGrepMessage(value);
      settle(() => {
        if (message === null) {
          reject(new GithubError("invalid_params", "grep worker returned an unparseable message"));
        } else if (!message.ok) {
          reject(new GithubError("invalid_params", message.error));
        } else {
          resolve(message.result);
        }
      });
    });
    worker.on("error", (error: Error) => {
      settle(() => reject(new GithubError("invalid_params", error.message)));
    });
    worker.postMessage(job);
    timer = setTimeout(() => settle(() => reject(new GrepOverrun(timeoutMs))), timeoutMs);
  });
}

export const fileGrepTool = defineTool({
  name: "github_file_grep",
  title: "GitHub file grep",
  description:
    "Search a single file's text with a regular expression and get line numbers with context. Cache-first: a warm cache costs zero upstream calls; a miss costs 1 core call. Use github_search_code for repo-wide or cross-repo search (30 requests/minute, GitHub index lag). Matching runs in a worker thread with a 2000 ms (default; GITHUB_MCP_GREP_TIMEOUT_MS) time budget; overruns degrade to matches_truncated instead of blocking the session. Returns {repo, path, ref, pattern, total_lines, matches, matches_truncated, meta}; an overrun returns no matches and carries hint instead.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    path: z.string().describe("File path inside the repository"),
    pattern: z
      .string()
      .max(200)
      .describe("Regular expression (JavaScript syntax) matched globally over the file text; matches report 1-based line and column"),
    context_lines: z
      .number()
      .int()
      .min(0)
      .max(10)
      .optional()
      .describe("Context lines before and after each match; defaults to 2"),
    max_matches: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Maximum number of matches to return; defaults to 50; matches_truncated reports more remained"),
    ref: z.string().optional().describe("Branch, tag, or commit; defaults to the repository default branch"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    //? The pattern is compiled before any network work so a syntax error costs
    //* zero upstream calls and carries the engine's own message verbatim. The
    //* worker compiles it again off-thread inside matchFileLines; this pass
    //* exists so malformed patterns never spend the fetch.
    try {
      new RegExp(input.pattern, "gm");
    } catch (error) {
      throw new GithubError("invalid_params", error instanceof Error ? error.message : String(error));
    }

    const { owner, name } = parseRepo(input.repo);
    //? Session pin honoring: an explicit ref always wins, a pinned sha is used
    //* only when the caller omitted ref, and the pinned sha passes through
    //* resolveRef untouched (no extra repo lookup). fresh never unpins.
    const pinned = getPinnedRef(`${owner}/${name}`, ctx);
    const usedPinned = input.ref === undefined ? pinned?.sha : undefined;
    const ref = await resolveRef(ctx.client, owner, name, input.ref ?? usedPinned ?? undefined, input.fresh);
    const path = encodePath(input.path);
    //? Same count convention as github_file: resolveRef issues its repo request
    //* only when neither an explicit ref nor a pin anchored the search (the
    //* truthy check mirrors its guard), and the contents read adds one more, so
    //* the count ends at 1 or 2.
    const calls = (input.ref || pinned ? 0 : 1) + 1;
    const contents = await ctx.client.api<ContentsPayload | ContentsPayload[]>(
      `/repos/${owner}/${name}/contents/${path}${githubQuery({ ref })}`,
      { fresh: input.fresh, cacheTtlMs: 300_000 },
    );
    const { data } = contents;
    const meta = responseMeta(contents, calls);
    if (Array.isArray(data)) {
      throw new GithubError("invalid_params", "path points to a directory; use github_tree");
    }
    if (data.type !== "file") {
      throw new GithubError("invalid_params", "path is not a file");
    }

    const bytes = await decodeContents(ctx, data);
    if (bytes === null) {
      throw new GithubError("invalid_params", "binary file; grep needs text");
    }
    const decoded = decodeUtf8(bytes);
    if (decoded === null) {
      throw new GithubError("unsupported", "file is not valid UTF-8");
    }
    //* grep searches the same byte-clipped text github_file would return, so both
    //* tools agree on content and line numbers for files over the budget.
    const text = truncateText(decoded, ctx.config.maxFileBytes).text;

    //? Matching runs off the event loop: matchFileLines executes in an eval
    //* worker bounded by ctx.config.grepTimeoutMs, so a pathological pattern
    //* cannot block the session. A timeout degrades to the overrun shape —
    //* total_lines is computed main-thread from the split (linear, always safe)
    //* so the caller keeps honest size information alongside zero matches.
    const timeoutMs = ctx.config.grepTimeoutMs;
    let matched: GrepResult;
    try {
      //? The worker call stays lazy inside the slot: acquiring a slot may wait
      //* behind other sessions, and the per-call budget must start only after
      //* this job actually owns a worker, so queue time never consumes it.
      matched = await withGrepSlot(() => runMatchInWorker(
        { pattern: input.pattern, text, contextLines: input.context_lines ?? 2, maxMatches: input.max_matches ?? 50 },
        timeoutMs,
      ));
    } catch (error) {
      if (error instanceof GrepOverrun) {
        return {
          repo: `${owner}/${name}`,
          path: data.path,
          ref,
          pattern: input.pattern,
          total_lines: text.split("\n").length,
          matches: [],
          matches_truncated: true,
          hint: error.message,
          //? Same conditional trailing keys as the normal return: pinned_sha only
          //* when the session pin anchored the search, meta only when the client
          //* reported a cache outcome.
          ...(usedPinned !== undefined ? { pinned_sha: usedPinned } : {}),
          ...(meta !== undefined ? { meta } : {}),
        };
      }
      throw error;
    }

    return {
      repo: `${owner}/${name}`,
      path: data.path,
      ref,
      pattern: input.pattern,
      total_lines: matched.total_lines,
      matches: matched.matches,
      //? matches_truncated only appears when the cap stopped a scan that had more
      //* to give; the conditional spread keeps a clean result free of the key.
      ...(matched.matches_truncated ? { matches_truncated: true } : {}),
      //? pinned_sha appears only when the search was anchored by the session pin;
      //* it trails the fixed keys and sits before meta, which stays the last key
      //* and stays absent when the client reported no cache outcome.
      ...(usedPinned !== undefined ? { pinned_sha: usedPinned } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
