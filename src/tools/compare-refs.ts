import { z } from "zod";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { parseRepo, truncateText } from "./util.js";

//? Only the fields this tool reads are typed; the REST payload carries more.
interface CompareFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface CompareResponse {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  files?: CompareFile[];
}

const MAX_FILES = 100;
const MAX_PATCH_CHARS = 4000;

export const compareRefsTool = defineTool({
  name: "github_compare_refs",
  title: "GitHub ref comparison",
  description:
    "Compares two refs in one repository, one core call: ahead/behind counts, total commits, and the first 100 changed files with each patch capped at 4000 characters. Unknown refs surface the standard 404 error. Returns {status, ahead_by, behind_by, total_commits, files[{filename, status, additions, deletions, patch}], files_truncated?}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    base: z.string().describe("Base ref (branch, tag or sha)"),
    head: z.string().describe("Head ref (branch, tag or sha)"),
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
    const compareResponse = await ctx.client.api<CompareResponse>(
      `/repos/${owner}/${name}/compare/${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`,
      { fresh: input.fresh, cacheTtlMs: 120_000 },
    );
    const { data } = compareResponse;
    const meta = responseMeta(compareResponse);
    const allFiles = data.files ?? [];
    const files = allFiles.slice(0, MAX_FILES).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch === undefined ? null : truncateText(file.patch, MAX_PATCH_CHARS).text,
    }));
    const result: Record<string, unknown> = {
      status: data.status,
      ahead_by: data.ahead_by,
      behind_by: data.behind_by,
      total_commits: data.total_commits,
      files,
    };
    //? The flag appears only when the cap actually cut something; its absence
    //? means the listed files are the complete diff.
    if (allFiles.length > MAX_FILES) result.files_truncated = true;
    //? meta is spread last so it trails the fixed keys (and the conditional
    //* files_truncated flag) and stays absent when no cache outcome exists.
    return { ...result, ...(meta !== undefined ? { meta } : {}) };
  },
});
