import { z } from "zod";
import type { RawApiResult } from "../core/github.js";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { getPinnedRef } from "./pin.js";
import { resolveRef } from "./ref.js";
import { encodePath, githubQuery, matchGlob, notFoundWithHint, parseRepo, truncateText } from "./util.js";

type GitTreeType = "blob" | "tree" | "commit";

interface GitTreeEntry {
  path: string;
  mode: string;
  type: GitTreeType;
  size?: number;
  sha: string;
}

interface GitTreeResponse {
  sha: string;
  truncated: boolean;
  tree: GitTreeEntry[];
}

const DEGRADED_HINT = "recursive listing timed out; returning top-level entries";
const CLIP_HINT = "tree clipped at max_bytes; narrow path/ref or raise max_bytes";
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

//* Only a timed-out network call degrades: the code must be "network" and the
//* message must mention a timeout, so rate limits and other aborts still throw.
function isTimeoutError(error: unknown): boolean {
  return error instanceof GithubError && error.code === "network" && /timeout/i.test(error.message);
}

function normalizeType(entry: GitTreeEntry): "file" | "dir" | "symlink" | "submodule" {
  if (entry.type === "tree") return "dir";
  if (entry.type === "commit") return "submodule";
  return entry.mode === "120000" ? "symlink" : "file";
}

function isTreeEntry(value: unknown): value is GitTreeEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === "string" && typeof candidate.type === "string" && typeof candidate.sha === "string"
  );
}

//* A byte-clipped body ends mid-object. Scanning the tree array with string and
//* escape state keeps every complete entry and drops only the trailing partial,
//* so local clipping never invents an entry and api_truncated stays upstream-only.
function parseClippedTree(text: string): GitTreeResponse {
  const upstreamTruncated = /"truncated"\s*:\s*true/.test(text);
  const entries: GitTreeEntry[] = [];
  const array = /"tree"\s*:\s*\[/.exec(text);
  if (array === null) return { sha: "", truncated: upstreamTruncated, tree: entries };
  let index = array.index + (array[0]?.length ?? 0);
  let inString = false;
  let escaped = false;
  let depth = 0;
  let objectStart = -1;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth > 0) depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        const slice = text.slice(objectStart, index + 1);
        try {
          const parsed: unknown = JSON.parse(slice);
          if (isTreeEntry(parsed)) entries.push(parsed);
        } catch {
          //? A partial object at the clip boundary is expected; skip it.
        }
        objectStart = -1;
      }
      continue;
    }
    if (char === "]" && depth === 0) break;
  }
  //* The response-level sha follows the tree array and lies past the clip, and
  //* no envelope field consumes it; an empty value avoids reporting an entry's
  //* own sha as the tree's.
  return { sha: "", truncated: upstreamTruncated, tree: entries };
}

export const treeTool = defineTool({
  name: "github_tree",
  title: "GitHub tree",
  description:
    "List files and directories in a repository at a ref, using the git trees API. Use recursive=true only when the full tree is needed; a glob containing / or ** implies recursion unless recursive is explicitly false. path_prefix filters entry paths by literal prefix and is applied with glob before max_entries. max_bytes (default 2 MiB, max 16 MiB) clips the raw response locally; local clipping, the entry cap, and GitHub truncation all set truncated while api_truncated stays upstream-only, and a clipped response's hint names max_bytes. summary_only drops entries and returned_entries and answers with total_bytes plus top_dirs totals for the full tree instead; a recursive timeout degrades to one top-level retry with degraded:true and a hint. Returns {ref, path, entries[{path, type, size, sha}], total_entries, returned_entries, summary, truncated, api_truncated}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    ref: z.string().optional().describe("Branch, tag, or commit; defaults to the repository default branch"),
    path: z.string().optional().describe("Subdirectory path inside the ref"),
    path_prefix: z.string().min(1).optional().describe("Filter returned entries by a literal path prefix, e.g. docs/"),
    glob: z.string().min(1).max(200).optional().describe("Filter returned entries by glob pattern, e.g. **/dev-overlay/** or src/*.ts; filters the entry list only — use github_file_grep to search file contents"),
    recursive: z.boolean().optional().describe("Return the complete tree recursively"),
    max_entries: z.number().int().min(1).max(10000).optional().describe("Maximum entries returned, 1-10000, default 1000"),
    max_bytes: z.number().int().min(1).max(16 * 1024 * 1024).optional().describe("Maximum raw response bytes to keep, default 2 MiB, max 16 MiB; local clipping sets truncated with a max_bytes hint"),
    summary_only: z.boolean().optional().describe("Omit entries and return total_bytes plus top_dirs for the full tree instead; max_entries, path_prefix, and glob are ignored; use with recursive: true"),
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
    //? "." and "./" mean the repo root: they normalize to absent so the plain
    //* ref listing is fetched instead of an encodePath rejection, and the call
    //* counts and reports exactly like a path-less one. Deeper dot segments
    //* and ".." stay strict; github_file keeps its own strict encodePath.
    const normalizedPath = input.path === "." || input.path === "./" ? undefined : input.path;
    const treeish = normalizedPath
      ? `${encodeURIComponent(ref)}:${encodePath(normalizedPath)}`
      : encodeURIComponent(ref);
    //* A separator or ** in the glob only implies recursion when the caller
    //* left recursive undefined; an explicit false always wins.
    const effectiveRecursive =
      input.recursive ??
      (input.glob !== undefined && (input.glob.includes("/") || input.glob.includes("**")));
    const fetchTree = async (recursive: boolean): Promise<RawApiResult> => {
      const query = githubQuery({ recursive: recursive ? "1" : undefined });
      try {
        return await ctx.client.apiRaw(`/repos/${owner}/${name}/git/trees/${treeish}${query}`, {
          fresh: input.fresh,
          cacheTtlMs: 600_000,
        });
      } catch (error) {
        //? 404 recovery: hints come from the local cache only, so no upstream
        //* call is added; non-404 errors and cache misses come back as the same
        //* object, which keeps the timeout-degrade check below working.
        throw await notFoundWithHint(error, {
          cache: ctx.cache,
          authFingerprint: ctx.authFingerprint,
          owner,
          name,
          ref,
          path: normalizedPath,
        });
      }
    };
    //? resolveRef issues its repo request only when neither an explicit ref nor
    //* a pin anchored the read (the truthy check mirrors its guard exactly).
    //* Each tree fetch below adds one more request, including a degraded retry
    //* after a timed-out first one.
    let calls = input.ref || pinned ? 0 : 1;
    let raw: RawApiResult;
    let degraded = false;
    try {
      calls += 1;
      raw = await fetchTree(effectiveRecursive);
    } catch (error) {
      //* Degrade exactly once and only for a timed-out recursive listing; every
      //* other failure, including a second timeout on this retry, rethrows.
      if (!effectiveRecursive || !isTimeoutError(error)) throw error;
      calls += 1;
      raw = await fetchTree(false);
      degraded = true;
    }
    const meta = responseMeta(raw, calls);
    const decoded = new TextDecoder("utf-8").decode(raw.bytes);
    const clipped = truncateText(decoded, input.max_bytes ?? DEFAULT_MAX_BYTES);
    const locallyClipped = clipped.truncated;
    //* A complete body is parsed as JSON; a clipped one is recovered with the
    //* bracket-aware scanner. Invalid complete JSON is an upstream failure, not
    //* a local cap, so it surfaces as an error instead of an empty tree.
    let data: GitTreeResponse;
    if (locallyClipped) {
      data = parseClippedTree(clipped.text);
    } else {
      const parsed: unknown = JSON.parse(clipped.text);
      //? JSON.parse has no schema guarantee; a non-object body would fail the
      //* tree read below, so fail early with a stable upstream error code.
      if (typeof parsed !== "object" || parsed === null) {
        throw new GithubError("upstream", "GitHub returned invalid JSON for the tree listing");
      }
      data = parsed as GitTreeResponse;
    }
    const all = (data.tree ?? []).map((entry) => ({
      path: entry.path,
      type: normalizeType(entry),
      size: entry.size ?? null,
      sha: entry.sha,
    }));
    const maxEntries = input.max_entries ?? 1000;
    //? path_prefix and glob are entry-list filters, so both run before the cap
    //* and before the totals are counted; summary_only keeps the full API tree
    //* (there is no entry list to filter) and ignores both filters entirely.
    const prefix = input.path_prefix;
    const prefixed = prefix === undefined ? all : all.filter((entry) => entry.path.startsWith(prefix));
    const glob = input.glob;
    const matched = glob === undefined ? prefixed : prefixed.filter((entry) => matchGlob(entry.path, glob));
    //* The summary describes the full API tree, so neither the cap nor the
    //* filters change it; total_entries counts matched entries in entries mode
    //* and is the parsed API tree size under summary_only.
    const summary = { files: 0, dirs: 0, symlinks: 0, submodules: 0 };
    for (const entry of all) {
      if (entry.type === "file") summary.files += 1;
      else if (entry.type === "dir") summary.dirs += 1;
      else if (entry.type === "symlink") summary.symlinks += 1;
      else summary.submodules += 1;
    }
    //? summary_only answers for the whole API tree, so neither max_entries nor
    //* the filters cap or locally truncate anything there; entries-mode applies both.
    const locallyTruncated = !input.summary_only && matched.length > maxEntries;
    //* Local byte clipping and the entry cap are local signals; api_truncated
    //* mirrors only GitHub's own flag from the response.
    const apiTruncated = data.truncated === true;
    const truncated = locallyClipped || locallyTruncated || apiTruncated;
    //* The degraded hint wins because the caller asked for a recursive listing
    //* and got top-level entries; the max_bytes hint wins over the two
    //* truncation hints because clipping can hide the true entry count.
    const hint = degraded
      ? DEGRADED_HINT
      : locallyClipped
        ? CLIP_HINT
        : truncated
          ? locallyTruncated && !apiTruncated
            ? "increase max_entries or narrow path/ref"
            : "narrow path/ref; GitHub truncated the tree"
          : undefined;
    const base = {
      ref,
      path: normalizedPath ?? null,
      total_entries: input.summary_only ? all.length : matched.length,
      summary,
      truncated,
      api_truncated: apiTruncated,
      ...(hint === undefined ? {} : { hint }),
      ...(degraded ? { degraded: true } : {}),
      //? pinned_sha appears only when the listing was anchored by the session
      //* pin; it trails the base keys and stays absent for explicit-ref reads.
      ...(usedPinned !== undefined ? { pinned_sha: usedPinned } : {}),
    };
    if (input.summary_only) {
      const totalBytes = all.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
      //* Every entry containing "/" counts toward its top-level segment, sorted
      //* by bytes descending; entries without one (root files, root dirs, root
      //* links) feed only the totals above.
      const groups = new Map<string, { files: number; bytes: number }>();
      for (const entry of all) {
        if (!entry.path.includes("/")) continue;
        const dir = entry.path.split("/")[0];
        //? includes("/") guarantees a first segment; the guard only satisfies
        //? noUncheckedIndexedAccess.
        if (dir === undefined) continue;
        const aggregate = groups.get(dir) ?? { files: 0, bytes: 0 };
        aggregate.files += 1;
        aggregate.bytes += entry.size ?? 0;
        groups.set(dir, aggregate);
      }
      return {
        ...base,
        total_bytes: totalBytes,
        top_dirs: [...groups]
          .map(([path, aggregate]) => ({ path, files: aggregate.files, bytes: aggregate.bytes }))
          .sort((a, b) => b.bytes - a.bytes),
        //? meta is spread last on both modes so it trails every fixed key and
        //* stays absent entirely when the client reported no cache outcome.
        ...(meta !== undefined ? { meta } : {}),
      };
    }
    return {
      ...base,
      entries: matched.slice(0, maxEntries),
      returned_entries: Math.min(matched.length, maxEntries),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
