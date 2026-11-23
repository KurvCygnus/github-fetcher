import { z } from "zod";
import { GithubError } from "../core/errors.js";
import type { ApiResult } from "../core/github.js";
import { type ContentsPayload, decodeContents } from "./contents.js";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { getPinnedRef } from "./pin.js";
import { resolveRef } from "./ref.js";
import { decodeUtf8, encodePath, githubQuery, notFoundWithHint, parseRepo, truncateText } from "./util.js";

export const fileTool = defineTool({
  name: "github_file",
  title: "GitHub file",
  description:
    "Read one file at a ref. Returns UTF-8 text when possible, never binary bytes, and reports sha, size, and truncation. Returns {repo, path, ref, sha, size, encoding, content, binary, truncated, start_line, end_line, total_lines}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    path: z.string().describe("File path inside the repository"),
    ref: z.string().optional().describe("Branch, tag, or commit; defaults to the repository default branch"),
    start_line: z.number().int().min(1).optional().describe("First line to return, 1-based; defaults to 1"),
    end_line: z.number().int().min(1).optional().describe("Last line to return, inclusive; defaults to the file end"),
    max_bytes: z.number().int().min(1).optional().describe("Per-call byte budget for the returned text; defaults to GITHUB_MCP_MAX_FILE_BYTES"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const { owner, name } = parseRepo(input.repo);
    //? Session pin honoring: an explicit ref always wins, a pinned sha is used
    //* only when the caller omitted ref, and the pinned sha passes through
    //* resolveRef untouched (no extra repo lookup). fresh never unpins.
    const pinned = getPinnedRef(`${owner}/${name}`, ctx);
    const usedPinned = input.ref === undefined ? pinned?.sha : undefined;
    const ref = await resolveRef(ctx.client, owner, name, input.ref ?? usedPinned ?? undefined, input.fresh);
    const path = encodePath(input.path);
    //? resolveRef issues its repo request only when neither an explicit ref nor
    //* a pin anchored the read (the truthy check mirrors its guard exactly).
    //* The contents read adds one more client invocation, so the count ends at
    //* 1 or 2; a warm cache hit still counts as one invocation even though no
    //* upstream request was spent, because calls tracks client activity.
    const calls = (input.ref || pinned ? 0 : 1) + 1;
    let contents: ApiResult<ContentsPayload | ContentsPayload[]>;
    try {
      contents = await ctx.client.api<ContentsPayload | ContentsPayload[]>(
        `/repos/${owner}/${name}/contents/${path}${githubQuery({ ref })}`,
        { fresh: input.fresh, cacheTtlMs: 300_000 },
      );
    } catch (error) {
      //? 404 recovery: sibling hints come from the local cache only, so this
      //* never adds an upstream call; other codes and cache-less contexts
      //* rethrow the original error object untouched.
      throw await notFoundWithHint(error, {
        cache: ctx.cache,
        authFingerprint: ctx.authFingerprint,
        owner,
        name,
        ref,
        path: input.path,
      });
    }
    const { data } = contents;
    const meta = responseMeta(contents, calls);
    if (Array.isArray(data)) {
      throw new GithubError("invalid_params", "path points to a directory; use github_tree");
    }
    if (data.type !== "file") {
      throw new GithubError("invalid_params", "path is not a file");
    }

    //? decodeContents collapses binary bytes to null, so the binary exit sizes
    //* itself from the payload's size field, which GitHub keeps equal to the
    //* decoded byte length.
    const bytes = await decodeContents(ctx, data);
    if (bytes === null) {
      return {
        repo: `${owner}/${name}`,
        path: data.path,
        ref,
        sha: data.sha,
        size: data.size,
        encoding: null,
        content: null,
        binary: true,
        truncated: false,
        start_line: null,
        end_line: null,
        total_lines: null,
        //? pinned_sha appears only when the read was anchored by the session pin;
        //* it trails the fixed keys and sits before meta, which stays the last key
        //* on both exits (binary and text) and stays absent when the client
        //* reported no cache outcome.
        ...(usedPinned !== undefined ? { pinned_sha: usedPinned } : {}),
        ...(meta !== undefined ? { meta } : {}),
      };
    }

    const text = decodeUtf8(bytes);
    if (text === null) {
      throw new GithubError("unsupported", "file is not valid UTF-8");
    }
    //* A line is a newline-separated segment; a trailing newline produces a final
    //* empty line, following editor convention. The slice keeps the newline that
    //* terminates endLine when one exists, so concatenating slices rebuilds the file.
    const segments = text.split("\n");
    const totalLines = segments.length;
    const startLine = input.start_line ?? 1;
    if (startLine > totalLines) {
      throw new GithubError("invalid_params", `start_line ${startLine} is beyond the end of the file (${totalLines} lines)`);
    }
    const requestedEnd = input.end_line ?? totalLines;
    if (requestedEnd < startLine) {
      throw new GithubError("invalid_params", `end_line ${requestedEnd} is before start_line ${startLine}`);
    }
    const endLine = Math.min(requestedEnd, totalLines);
    let startOffset = 0;
    for (let index = 1; index < startLine; index++) {
      startOffset += (segments[index - 1] ?? "").length + 1;
    }
    let endOffset = startOffset;
    for (let index = startLine; index <= endLine; index++) {
      endOffset += (segments[index - 1] ?? "").length + (index < totalLines ? 1 : 0);
    }
    const budget = Math.min(input.max_bytes ?? ctx.config.maxFileBytes, ctx.config.maxFileBytes);
    const clipped = truncateText(text.slice(startOffset, endOffset), budget);
    return {
      repo: `${owner}/${name}`,
      path: data.path,
      ref,
      sha: data.sha,
      size: bytes.byteLength,
      encoding: "utf-8",
      content: clipped.text,
      binary: false,
      truncated: clipped.truncated,
      start_line: startLine,
      end_line: endLine,
      total_lines: totalLines,
      ...(usedPinned !== undefined ? { pinned_sha: usedPinned } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
