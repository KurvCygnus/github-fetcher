import { z } from "zod";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { parseRepo, truncateText } from "./util.js";

interface CompareCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
  };
  author: { login: string } | null;
}

interface CompareFile {
  sha: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

interface CompareResponse {
  status: string;
  ahead_by: number;
  behind_by: number;
  //? Upstream total_commits is deliberately absent from this interface: the
  //* tool's total_commits is ahead_by, and using the upstream value here would
  //* make the capped commit list disagree with the reported total.
  files?: CompareFile[];
  commits?: CompareCommit[];
}

const MAX_COMMITS = 100;
const MAX_FILES = 100;
const MAX_PATCH_CHARS = 4000;
const UPSTREAM_FILE_CAP = 300;

export const releaseDiffTool = defineTool({
  name: "github_release_diff",
  title: "GitHub release diff",
  description:
    "Compares two refs in one repository for a release diff, one core call: ahead/behind counts, total commits from ahead_by, up to 100 changed files with patches capped at 4000 bytes, and an optional projected commit list (include_commits defaults to true). total_files reports the full diff size; commits_truncated and files_truncated mark real cuts; each ref is URI-escaped. Returns {repo, from, to, status, ahead_by, behind_by, total_commits, commits, commits_truncated, total_files, files, files_truncated, meta}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    from: z.string().describe("Base ref (branch, tag or sha) at the comparison start"),
    to: z.string().describe("Head ref (branch, tag or sha) at the comparison end"),
    include_commits: z.boolean().optional().describe("Include the projected commit list, default true; false omits commits but keeps commits_truncated"),
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
    const result = await ctx.client.api<CompareResponse>(
      `/repos/${owner}/${name}/compare/${encodeURIComponent(input.from)}...${encodeURIComponent(input.to)}`,
      { fresh: input.fresh, cacheTtlMs: 120_000 },
    );
    const { data } = result;
    const meta = responseMeta(result, 1);
    const totalCommits = data.ahead_by;
    const commitsTruncated = totalCommits > MAX_COMMITS;
    const allFiles = data.files ?? [];
    const files = allFiles.slice(0, MAX_FILES).map((file) => {
      //? A null patch means upstream omitted it, so it is never a truncation;
      //* the flag reflects the 4000-byte cap actually shortening the text.
      const clipped = file.patch === undefined ? undefined : truncateText(file.patch, MAX_PATCH_CHARS);
      return {
        sha: file.sha,
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: clipped?.text ?? null,
        patch_truncated: clipped?.truncated ?? false,
      };
    });
    const output: Record<string, unknown> = {
      repo: input.repo,
      from: input.from,
      to: input.to,
      status: data.status,
      ahead_by: data.ahead_by,
      behind_by: data.behind_by,
      total_commits: totalCommits,
      ...(input.include_commits !== false
        ? {
            commits: (data.commits ?? []).slice(0, MAX_COMMITS).map((commit) => ({
              sha: commit.sha,
              short_sha: commit.sha.slice(0, 7),
              message: commit.commit.message,
              author: {
                name: commit.commit.author.name,
                email: commit.commit.author.email,
                login: commit.author?.login ?? null,
              },
              date: commit.commit.author.date,
              url: commit.html_url,
            })),
          }
        : {}),
      commits_truncated: commitsTruncated,
      //? The full diff size is reported even when the file list is capped.
      total_files: allFiles.length,
      files,
      //? GitHub itself stops at 300 files, so a full upstream page also means
      //* the local 100-file clip hid more even when the arrays are the same size.
      files_truncated: allFiles.length > MAX_FILES || allFiles.length >= UPSTREAM_FILE_CAP,
    };
    //? meta is spread last so it trails the fixed keys and stays absent when
    //* the client reported no cache outcome.
    return { ...output, ...(meta !== undefined ? { meta } : {}) };
  },
});
