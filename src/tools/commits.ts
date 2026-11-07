import { z } from "zod";
import { defineTool } from "./define.js";
import { listEnvelope } from "./pagination.js";
import { githubQuery, parseRepo } from "./util.js";

interface CommitResponse {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
  };
  author: { login: string } | null;
}

export const commitsTool = defineTool({
  name: "github_commits",
  title: "GitHub commits",
  description:
    "List commits on a ref, optionally filtered by path, author, or date range. Returns short sha, message, author, and date. Returns {items[{sha, short_sha, message, author{name, email, login}, date, url}], page, per_page, has_more, next_page}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    ref: z.string().optional().describe("Branch, tag, or commit; defaults to the repository default branch"),
    path: z.string().optional().describe("Only commits touching this path"),
    author: z.string().optional().describe("GitHub login or email to filter by"),
    since: z.string().optional().describe("ISO 8601 lower bound"),
    until: z.string().optional().describe("ISO 8601 upper bound"),
    page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
    per_page: z.number().int().min(1).max(100).optional().describe("Items per page, 1-100, default 20"),
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
    const page = input.page ?? 1;
    const perPage = input.per_page ?? 20;
    const query = githubQuery({
      sha: input.ref,
      path: input.path,
      author: input.author,
      since: input.since,
      until: input.until,
      page,
      per_page: perPage,
    });
    const { data, headers } = await ctx.client.api<CommitResponse[]>(
      `/repos/${owner}/${name}/commits${query}`,
      { fresh: input.fresh, cacheTtlMs: 120_000 },
    );
    const items = data.map((commit) => ({
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
    }));
    return listEnvelope(items, page, perPage, headers.get("link"));
  },
});
