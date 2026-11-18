import { z } from "zod";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { getPinnedRef } from "./pin.js";
import { parseRepo, truncateText } from "./util.js";

//? Only the fields this tool reads are typed; the REST payload carries more
//* (parents, committer, html_url, tree, verification, node_id) and stays
//* unprojected by construction because the handler copies listed keys only.
interface CommitDetailFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface CommitDetailResponse {
  sha: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
  };
  author: { login: string } | null;
  stats: { additions: number; deletions: number };
  files?: CommitDetailFile[];
}

const MAX_FILES = 100;
const MAX_PATCH_CHARS = 4000;

export const commitTool = defineTool({
  name: "github_commit",
  title: "GitHub commit",
  description:
    "Read one commit: message, author, additions/deletions, and the changed files with bounded patches. github_commits lists commits; this reads one in full. Costs 1 core call. Returns {repo, sha, author, date, message, additions, deletions, files, files_truncated, meta}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    ref: z
      .string()
      .optional()
      .describe(
        "Commit sha, branch, or tag; defaults to the pinned ref when one exists, otherwise the repository default branch",
      ),
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
    //? Session pin honoring: an explicit ref always wins, a pinned sha fills a
    //* ref-less read, and fresh never unpins. The commits/{ref} endpoint
    //* accepts shas, branch names, tags, and HEAD directly, so the expression
    //* goes straight into the path with no resolveRef lookup and the read
    //* always costs exactly the one call the description promises; HEAD keeps
    //* that constant when neither a ref nor a pin anchors it (the default
    //* branch tip). The pin itself adds no upstream call.
    const pinned = getPinnedRef(`${owner}/${name}`);
    const usedPinned = input.ref === undefined ? pinned?.sha : undefined;
    const ref = input.ref ?? usedPinned ?? "HEAD";
    const result = await ctx.client.api<CommitDetailResponse>(
      `/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`,
      { fresh: input.fresh, cacheTtlMs: 300_000 },
    );
    const { data } = result;
    const meta = responseMeta(result, 1);
    //? Some payloads omit the diff entirely, so a missing files array reads as
    //* an empty diff. The cap is applied client-side after the response, so
    //* the input never leaks into the GitHub request.
    const allFiles = data.files ?? [];
    const files = allFiles.slice(0, MAX_FILES).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch === undefined ? null : truncateText(file.patch, MAX_PATCH_CHARS).text,
    }));
    return {
      repo: `${owner}/${name}`,
      sha: data.sha,
      //? The git author identity lives at commit.author; author is the linked
      //* REST user object and is null for ghost users (deleted accounts), so
      //* login falls back to null.
      author: {
        name: data.commit.author.name,
        email: data.commit.author.email,
        login: data.author?.login ?? null,
      },
      date: data.commit.author.date,
      message: data.commit.message,
      additions: data.stats.additions,
      deletions: data.stats.deletions,
      files,
      //? The flag appears only when the cap actually cut something; its absence
      //* means the listed files are the complete diff.
      ...(allFiles.length > MAX_FILES ? { files_truncated: true } : {}),
      //? pinned_sha appears only when the read was anchored by the session pin;
      //* meta is spread after it so it stays the trailing key and stays absent
      //* entirely when the client reported no cache outcome.
      ...(usedPinned !== undefined ? { pinned_sha: usedPinned } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
