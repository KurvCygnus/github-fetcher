import { z } from "zod";
import type { ApiResult } from "../core/github.js";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { getPinnedRef } from "./pin.js";
import { resolveRef } from "./ref.js";
import { encodePath, githubQuery, matchGlob, notFoundWithHint, parseRepo } from "./util.js";

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

export const treeTool = defineTool({
  name: "github_tree",
  title: "GitHub tree",
  description:
    "List files and directories in a repository at a ref, using the git trees API. Use recursive=true only when the full tree is needed. summary_only drops entries and returned_entries and answers with total_bytes plus top_dirs totals instead. glob filters entry paths (** crosses directories, * stays within one segment, ? matches one character); it filters the entry list only and does not search file contents, and is ignored under summary_only because there is no entry list to filter. Returns {ref, path, entries[{path, type, size, sha}], total_entries, returned_entries, summary, truncated, api_truncated}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    ref: z.string().optional().describe("Branch, tag, or commit; defaults to the repository default branch"),
    path: z.string().optional().describe("Subdirectory path inside the ref"),
    glob: z.string().min(1).max(200).optional().describe("Filter returned entries by glob pattern, e.g. **/dev-overlay/** or src/*.ts; filters the entry list only — use github_file_grep to search file contents"),
    recursive: z.boolean().optional().describe("Return the complete tree recursively"),
    max_entries: z.number().int().min(1).max(10000).optional().describe("Maximum entries returned, 1-10000, default 1000"),
    summary_only: z.boolean().optional().describe("Omit entries and return total_bytes plus top_dirs for the full tree instead; max_entries is ignored; use with recursive: true"),
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
    const pinned = getPinnedRef(`${owner}/${name}`);
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
    const fetchTree = async (recursive: boolean): Promise<ApiResult<GitTreeResponse>> => {
      const query = githubQuery({ recursive: recursive ? "1" : undefined });
      try {
        return await ctx.client.api<GitTreeResponse>(
          `/repos/${owner}/${name}/git/trees/${treeish}${query}`,
          { fresh: input.fresh, cacheTtlMs: 600_000 },
        );
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
    let tree: ApiResult<GitTreeResponse>;
    let degraded = false;
    try {
      calls += 1;
      tree = await fetchTree(input.recursive === true);
    } catch (error) {
      //* Degrade exactly once and only for a timed-out recursive listing; every
      //* other failure, including a second timeout on this retry, rethrows.
      if (!input.recursive || !isTimeoutError(error)) throw error;
      calls += 1;
      tree = await fetchTree(false);
      degraded = true;
    }
    const data = tree.data;
    const meta = responseMeta(tree, calls);
    const all = (data.tree ?? []).map((entry) => ({
      path: entry.path,
      type: normalizeType(entry),
      size: entry.size ?? null,
      sha: entry.sha,
    }));
    const maxEntries = input.max_entries ?? 1000;
    //? The glob is an entry-list filter, so it runs before the cap and before the
    //* totals are counted; summary_only keeps the full API tree (there is no entry
    //* list to filter) and therefore ignores the glob entirely.
    const glob = input.glob;
    const matched = glob === undefined ? all : all.filter((entry) => matchGlob(entry.path, glob));
    //* The summary describes the full API tree, so neither the cap nor the glob
    //* changes it; total_entries counts matched entries in entries mode and is
    //* GitHub's response size under summary_only.
    const summary = { files: 0, dirs: 0, symlinks: 0, submodules: 0 };
    for (const entry of all) {
      if (entry.type === "file") summary.files += 1;
      else if (entry.type === "dir") summary.dirs += 1;
      else if (entry.type === "symlink") summary.symlinks += 1;
      else summary.submodules += 1;
    }
    //? summary_only answers for the whole API tree, so neither max_entries nor
    //* the glob caps or locally truncates anything there; entries-mode applies both.
    const locallyTruncated = !input.summary_only && matched.length > maxEntries;
    const truncated = locallyTruncated || data.truncated;
    //? The degraded hint wins over the truncation hints: the caller asked for a
    //? recursive listing and received top-level entries, which explains itself.
    const hint = degraded
      ? DEGRADED_HINT
      : truncated
        ? locallyTruncated && !data.truncated
          ? "increase max_entries or narrow path/ref"
          : "narrow path/ref; GitHub truncated the tree"
        : undefined;
    const base = {
      ref,
      path: normalizedPath ?? null,
      total_entries: input.summary_only ? all.length : matched.length,
      summary,
      truncated,
      api_truncated: data.truncated,
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
