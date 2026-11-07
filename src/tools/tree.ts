import { z } from "zod";
import { defineTool } from "./define.js";
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

function normalizeType(entry: GitTreeEntry): "file" | "dir" | "symlink" | "submodule" {
  if (entry.type === "tree") return "dir";
  if (entry.type === "commit") return "submodule";
  return entry.mode === "120000" ? "symlink" : "file";
}

export const treeTool = defineTool({
  name: "github_tree",
  title: "GitHub tree",
  description:
    "List files and directories in a repository at a ref, using the git trees API. Use recursive=true only when the full tree is needed. Returns {ref, path, entries[{path, type, size, sha}], total_entries, returned_entries, summary, truncated, api_truncated}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    ref: z.string().optional().describe("Branch, tag, or commit; defaults to the repository default branch"),
    path: z.string().optional().describe("Subdirectory path inside the ref"),
    recursive: z.boolean().optional().describe("Return the complete tree recursively"),
    max_entries: z.number().int().min(1).max(10000).optional().describe("Maximum entries returned, 1-10000, default 1000"),
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
    const query = githubQuery({ recursive: input.recursive ? "1" : undefined });
    const { data } = await ctx.client.api<GitTreeResponse>(
      `/repos/${owner}/${name}/git/trees/${treeish}${query}`,
      { fresh: input.fresh, cacheTtlMs: 600_000 },
    );
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
    const locallyTruncated = all.length > maxEntries;
    const truncated = locallyTruncated || data.truncated;
    return {
      ref,
      path: input.path ?? null,
      entries: all.slice(0, maxEntries),
      total_entries: all.length,
      returned_entries: Math.min(all.length, maxEntries),
      summary,
      truncated,
      api_truncated: data.truncated,
      ...(
        truncated
          ? {
              hint:
                locallyTruncated && !data.truncated
                  ? "increase max_entries or narrow path/ref"
                  : "narrow path/ref; GitHub truncated the tree",
            }
          : {}
      ),
    };
  },
});
