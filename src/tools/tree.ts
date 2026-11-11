import { z } from "zod";
import type { ApiResult } from "../core/github.js";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { resolveRef } from "./ref.js";
import { encodePath, githubQuery, parseRepo } from "./util.js";

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
    "List files and directories in a repository at a ref, using the git trees API. Use recursive=true only when the full tree is needed. summary_only drops entries and returned_entries and answers with total_bytes plus top_dirs totals instead. Returns {ref, path, entries[{path, type, size, sha}], total_entries, returned_entries, summary, truncated, api_truncated}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    ref: z.string().optional().describe("Branch, tag, or commit; defaults to the repository default branch"),
    path: z.string().optional().describe("Subdirectory path inside the ref"),
    recursive: z.boolean().optional().describe("Return the complete tree recursively"),
    max_entries: z.number().int().min(1).max(10000).optional().describe("Maximum entries returned, 1-10000, default 1000"),
    summary_only: z.boolean().optional().describe("Omit entries and return total_bytes plus top_dirs for the full tree instead; max_entries is ignored"),
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
    const ref = await resolveRef(ctx.client, owner, name, input.ref, input.fresh);
    const treeish = input.path
      ? `${encodeURIComponent(ref)}:${encodePath(input.path)}`
      : encodeURIComponent(ref);
    const fetchTree = (recursive: boolean) => {
      const query = githubQuery({ recursive: recursive ? "1" : undefined });
      return ctx.client.api<GitTreeResponse>(
        `/repos/${owner}/${name}/git/trees/${treeish}${query}`,
        { fresh: input.fresh, cacheTtlMs: 600_000 },
      );
    };
    let tree: ApiResult<GitTreeResponse>;
    let degraded = false;
    try {
      tree = await fetchTree(input.recursive === true);
    } catch (error) {
      //* Degrade exactly once and only for a timed-out recursive listing; every
      //* other failure, including a second timeout on this retry, rethrows.
      if (!input.recursive || !isTimeoutError(error)) throw error;
      tree = await fetchTree(false);
      degraded = true;
    }
    const data = tree.data;
    const meta = responseMeta(tree);
    const all = (data.tree ?? []).map((entry) => ({
      path: entry.path,
      type: normalizeType(entry),
      size: entry.size ?? null,
      sha: entry.sha,
    }));
    const maxEntries = input.max_entries ?? 1000;
    //* The summary describes the full API tree, so a capped page still reports the
    //* repository's real composition; total_entries is GitHub's response size, not
    //* the true repository total when GitHub itself truncated the tree.
    const summary = { files: 0, dirs: 0, symlinks: 0, submodules: 0 };
    for (const entry of all) {
      if (entry.type === "file") summary.files += 1;
      else if (entry.type === "dir") summary.dirs += 1;
      else if (entry.type === "symlink") summary.symlinks += 1;
      else summary.submodules += 1;
    }
    //? summary_only answers for the whole API tree, so max_entries neither caps
    //? nor locally truncates anything there; entries-mode keeps the local cap.
    const locallyTruncated = !input.summary_only && all.length > maxEntries;
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
      path: input.path ?? null,
      total_entries: all.length,
      summary,
      truncated,
      api_truncated: data.truncated,
      ...(hint === undefined ? {} : { hint }),
      ...(degraded ? { degraded: true } : {}),
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
      entries: all.slice(0, maxEntries),
      returned_entries: Math.min(all.length, maxEntries),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
