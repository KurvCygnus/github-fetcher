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
    "List files and directories in a repository at a ref, using the git trees API. Use recursive=true only when the full tree is needed.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    ref: z.string().optional().describe("Branch, tag, or commit; defaults to the repository default branch"),
    path: z.string().optional().describe("Subdirectory path inside the ref"),
    recursive: z.boolean().optional().describe("Return the complete tree recursively"),
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
    return {
      ref,
      path: input.path ?? null,
      entries: (data.tree ?? []).map((entry) => ({
        path: entry.path,
        type: normalizeType(entry),
        size: entry.size ?? null,
        sha: entry.sha,
      })),
      truncated: data.truncated,
    };
  },
});
