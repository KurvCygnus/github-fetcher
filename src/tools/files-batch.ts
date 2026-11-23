import { z } from "zod";
import type { ApiResult } from "../core/github.js";
import type { ToolContext } from "../core/context.js";
import { GithubError, toGithubError } from "../core/errors.js";
import { type ContentsPayload, decodeContents } from "./contents.js";
import { defineTool } from "./define.js";
import type { MetaSource } from "./meta.js";
import { scarcestMeta } from "./meta.js";
import { getPinnedRef } from "./pin.js";
import { resolveRef } from "./ref.js";
import { decodeUtf8, encodePath, githubQuery, parseRepo, truncateText } from "./util.js";

interface FileBatchSuccess {
  path: string;
  ok: true;
  data: {
    path: string;
    sha: string;
    size: number;
    encoding: string | null;
    content: string | null;
    binary: boolean;
    truncated: boolean;
    total_lines: number | null;
  };
}

interface FileBatchFailure {
  path: string;
  ok: false;
  error: { code: string; message: string };
}

type FileBatchItem = FileBatchSuccess | FileBatchFailure;

//? One entry's outcome: the projected item (success or per-item error) plus the
//* client result that produced it, so the handler can fold the fulfilled entries
//* into one scarcest meta. attempts counts the entry's client invocations: a
//* malformed path costs zero, and a rejected contents request still costs its
//* one attempt; the raw fallback fetch sits outside the count, same boundary as
//* github_file.
interface FetchOneOutcome {
  item: FileBatchItem;
  result: ApiResult<ContentsPayload | ContentsPayload[]> | undefined;
  attempts: number;
}

//* The per-path half of the github_file flow: encode the path, fetch contents,
//* decode base64 or raw bytes, and project the same fields github_file reports
//* plus total_lines, the whole-file line count. Every failure - malformed path,
//* 404, directory hit, hostile bytes - is normalized to an ok:false item here so
//* one bad path never rejects the batch.
async function fetchOne(
  ctx: ToolContext,
  owner: string,
  name: string,
  ref: string,
  pathSpec: string,
  fresh: boolean | undefined,
  maxBytes: number,
): Promise<FetchOneOutcome> {
  let attempts = 0;
  try {
    const path = encodePath(pathSpec);
    attempts += 1;
    const contents = await ctx.client.api<ContentsPayload | ContentsPayload[]>(
      `/repos/${owner}/${name}/contents/${path}${githubQuery({ ref })}`,
      { fresh, cacheTtlMs: 300_000 },
    );
    const { data } = contents;
    if (Array.isArray(data)) {
      throw new GithubError("invalid_params", "path points to a directory; use github_tree");
    }
    if (data.type !== "file") {
      throw new GithubError("invalid_params", "path is not a file");
    }

    //? decodeContents collapses binary bytes to null, so the binary projection
    //* sizes itself from the payload's size field, which GitHub keeps equal to
    //* the decoded byte length.
    const bytes = await decodeContents(ctx, data);
    if (bytes === null) {
      return {
        item: {
          path: data.path,
          ok: true,
          data: {
            path: data.path,
            sha: data.sha,
            size: data.size,
            encoding: null,
            content: null,
            binary: true,
            truncated: false,
            total_lines: null,
          },
        },
        result: contents,
        attempts,
      };
    }

    const text = decodeUtf8(bytes);
    if (text === null) {
      throw new GithubError("unsupported", "file is not valid UTF-8");
    }
    //* A line is a newline-separated segment; the trailing newline yields a final
    //* empty line, matching github_file. Count before the byte budget clips the
    //* text so the number describes the whole file, not the returned excerpt.
    const totalLines = text.split("\n").length;
    const clipped = truncateText(text, maxBytes);
    return {
      item: {
        path: data.path,
        ok: true,
        data: {
          path: data.path,
          sha: data.sha,
          size: bytes.byteLength,
          encoding: "utf-8",
          content: clipped.text,
          binary: false,
          truncated: clipped.truncated,
          total_lines: totalLines,
        },
      },
      result: contents,
      attempts,
    };
  } catch (error) {
    const normalized = toGithubError(error);
    return {
      item: {
        path: pathSpec,
        ok: false,
        error: { code: normalized.code, message: normalized.message },
      },
      result: undefined,
      attempts,
    };
  }
}

export const filesBatchTool = defineTool({
  name: "github_files",
  title: "GitHub file batch",
  description:
    "Batch file read: fetches up to 10 paths per call from one repository concurrently, one core call per uncached path, zero for cache hits, and reports per-item success and failure so one missing or malformed path never rejects the call. Optional max_bytes (default: server maxFileBytes) clips each decoded text row and drives its truncated flag; binary rows stay untouched and total_lines counts the whole file before clipping. Returns {results[{path, ok, data{path, sha, size, encoding, content, binary, truncated, total_lines}} or {path, ok, error{code, message}}], elapsed_ms, meta}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    paths: z.array(z.string()).min(1).max(10).describe("File paths inside the repository; up to 10 per call"),
    ref: z.string().optional().describe("Branch, tag, or commit; defaults to the repository default branch"),
    max_bytes: z.number().int().min(1).optional().describe("Per-call byte budget for decoded text; defaults to the server maxFileBytes and leaves binary rows untouched"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const started = Date.now();
    const { owner, name } = parseRepo(input.repo);
    //? Session pin honoring: an explicit ref always wins, a pinned sha is used
    //* only when the caller omitted ref, and the pinned sha passes through
    //* resolveRef untouched (no extra repo lookup). fresh never unpins.
    const pinned = getPinnedRef(`${owner}/${name}`, ctx);
    const usedPinned = input.ref === undefined ? pinned?.sha : undefined;
    const ref = await resolveRef(ctx.client, owner, name, input.ref ?? usedPinned ?? undefined, input.fresh);
    const maxBytes = input.max_bytes ?? ctx.config.maxFileBytes;
    const settled = await Promise.allSettled(
      input.paths.map((pathSpec) => fetchOne(ctx, owner, name, ref, pathSpec, input.fresh, maxBytes)),
    );
    const results: FileBatchItem[] = [];
    //? Failed entries carry no client result, so only the fulfilled entries'
    //* observations feed the batch's scarcest meta; the call count still covers
    //* every attempt, including the ones that rejected. resolveRef issues its
    //* repo request only when neither an explicit ref nor a pin anchored the
    //* batch (the truthy check mirrors its guard exactly), so the count ends at
    //* paths.length or one more.
    const observations: MetaSource[] = [];
    let calls = input.ref || pinned ? 0 : 1;
    settled.forEach((entry, index) => {
      if (entry.status === "fulfilled") {
        results.push(entry.value.item);
        calls += entry.value.attempts;
        if (entry.value.result !== undefined) observations.push(entry.value.result);
        return;
      }
      //? fetchOne converts every failure itself, so this branch is unreachable
      //* today; it keeps the batch's never-reject contract if that ever changes.
      results.push({
        path: input.paths[index] ?? "",
        ok: false,
        error: toGithubError(entry.reason),
      });
    });
    //? Multi-request tool: one scarcest meta across the fulfilled reads (lowest
    //* remaining, tagged with its resource), undefined when every entry failed.
    const meta = scarcestMeta(observations, calls);
    return {
      results,
      elapsed_ms: Date.now() - started,
      //? pinned_sha appears only when the batch was anchored by the session pin;
      //* it trails the fixed keys and sits before meta, which stays the last key
      //* and stays absent when no fulfilled entry reported a cache outcome.
      ...(usedPinned !== undefined ? { pinned_sha: usedPinned } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
