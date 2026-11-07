import { z } from "zod";
import { defineTool } from "./define.js";
import { parseRepo } from "./util.js";

interface RepoResponse {
  full_name: string;
  description: string | null;
  private: boolean;
  visibility?: string;
  html_url: string;
  default_branch: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  has_issues: boolean;
  has_discussions: boolean;
  language: string | null;
  license: { spdx_id: string | null } | null;
  topics?: string[];
  archived: boolean;
  pushed_at: string | null;
  created_at: string;
}

export const repoTool = defineTool({
  name: "github_repo",
  title: "GitHub repository",
  description:
    "Read repository metadata: description, visibility, default branch, stars, forks, open issues, language, license, topics, and timestamps. open_issues includes pull requests. Returns {full_name, description, private, visibility, html_url, default_branch, stars, forks, open_issues, language, license, topics, has_issues, has_discussions, archived, pushed_at, created_at}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
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
    const { data } = await ctx.client.api<RepoResponse>(`/repos/${owner}/${name}`, {
      fresh: input.fresh,
      cacheTtlMs: 600_000,
    });
    return {
      full_name: data.full_name,
      description: data.description,
      private: data.private,
      visibility: data.visibility ?? (data.private ? "private" : "public"),
      html_url: data.html_url,
      default_branch: data.default_branch,
      stars: data.stargazers_count,
      forks: data.forks_count,
      open_issues: data.open_issues_count,
      language: data.language,
      license: data.license?.spdx_id ?? null,
      topics: data.topics ?? [],
      has_issues: data.has_issues,
      has_discussions: data.has_discussions,
      archived: data.archived,
      pushed_at: data.pushed_at,
      created_at: data.created_at,
    };
  },
});
