import { z } from "zod";
import { looksBinary } from "../core/binary.js";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { getPinnedRef } from "./pin.js";
import { resolveRef } from "./ref.js";
import { decodeUtf8, encodePath, githubQuery, parseRepo, truncateText } from "./util.js";

interface ContentsResponse {
  type: string;
  encoding: string;
  size: number;
  name: string;
  path: string;
  sha: string;
  content?: string;
  download_url: string | null;
}

export const fileGrepTool = defineTool({
  name: "github_file_grep",
  title: "GitHub file grep",
  description:
    "Search a single file's text with a regular expression and get line numbers with context. Cache-first: a warm cache costs zero upstream calls; a miss costs 1 core call. Use github_search_code for repo-wide or cross-repo search (30 requests/minute, GitHub index lag). Patterns run on the server's event loop; a pathological regex can block the session (bounded by the file-size cap). Returns {repo, path, ref, pattern, total_lines, matches, matches_truncated, meta}.",
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
    //* zero upstream calls and carries the engine's own message verbatim.
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern, "gm");
    } catch (error) {
      throw new GithubError("invalid_params", error instanceof Error ? error.message : String(error));
    }

    const { owner, name } = parseRepo(input.repo);
    //? Session pin honoring: an explicit ref always wins, a pinned sha is used
    //* only when the caller omitted ref, and the pinned sha passes through
    //* resolveRef untouched (no extra repo lookup). fresh never unpins.
    const pinned = getPinnedRef(`${owner}/${name}`);
    const usedPinned = input.ref === undefined ? pinned?.sha : undefined;
    const ref = await resolveRef(ctx.client, owner, name, input.ref ?? usedPinned ?? undefined, input.fresh);
    const path = encodePath(input.path);
    //? Same count convention as github_file: resolveRef issues its repo request
    //* only when neither an explicit ref nor a pin anchored the search (the
    //* truthy check mirrors its guard), and the contents read adds one more, so
    //* the count ends at 1 or 2.
    const calls = (input.ref || pinned ? 0 : 1) + 1;
    const contents = await ctx.client.api<ContentsResponse | ContentsResponse[]>(
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

    let bytes: Uint8Array;
    if (data.encoding === "base64" && data.content !== undefined) {
      bytes = new Uint8Array(Buffer.from(data.content, "base64"));
    } else if (data.download_url) {
      bytes = await ctx.client.raw(data.download_url);
    } else {
      throw new GithubError("unsupported", "GitHub did not provide readable content for this file");
    }

    if (looksBinary(bytes, data.path)) {
      throw new GithubError("invalid_params", "binary file; grep needs text");
    }
    const decoded = decodeUtf8(bytes);
    if (decoded === null) {
      throw new GithubError("unsupported", "file is not valid UTF-8");
    }
    //* grep searches the same byte-clipped text github_file would return, so both
    //* tools agree on content and line numbers for files over the budget.
    const text = truncateText(decoded, ctx.config.maxFileBytes).text;

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

    const contextLines = input.context_lines ?? 2;
    const maxMatches = input.max_matches ?? 50;
    const matches: Array<{
      line: number;
      column: number;
      line_text: string;
      context: Array<{ line: number; text: string }>;
    }> = [];
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

    return {
      repo: `${owner}/${name}`,
      path: data.path,
      ref,
      pattern: input.pattern,
      total_lines: totalLines,
      matches,
      //? matches_truncated only appears when the cap stopped a scan that had more
      //* to give; the conditional spread keeps a clean result free of the key.
      ...(truncated ? { matches_truncated: true } : {}),
      //? pinned_sha appears only when the search was anchored by the session pin;
      //* it trails the fixed keys and sits before meta, which stays the last key
      //* and stays absent when the client reported no cache outcome.
      ...(usedPinned !== undefined ? { pinned_sha: usedPinned } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
