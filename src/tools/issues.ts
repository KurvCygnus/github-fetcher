import { z } from "zod";
import { defineTool } from "./define.js";
import { linkFor, listEnvelope } from "./pagination.js";
import { githubQuery, parseRepo, truncateText } from "./util.js";

interface IssueResponse {
  number: number;
  title: string;
  state: string;
  user: { login: string } | null;
  labels: (string | { name: string })[];
  assignees: { login: string }[] | null;
  body: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: number;
  html_url: string;
  //* Present only on pull request items; its presence distinguishes a PR from
  //* an issue in list responses (same convention as the search tool's type).
  pull_request?: Record<string, unknown> | undefined;
}

interface CommentResponse {
  user: { login: string } | null;
  body: string;
  created_at: string;
}

function labelNames(labels: (string | { name: string })[]): string[] {
  return labels.map((label) => (typeof label === "string" ? label : label.name));
}

function issueFields(issue: IssueResponse, maxBody: number) {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.user?.login ?? null,
    labels: labelNames(issue.labels),
    assignees: (issue.assignees ?? []).map((user) => user.login),
    body: issue.body === null ? null : truncateText(issue.body, maxBody).text,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    comments_count: issue.comments,
    html_url: issue.html_url,
  };
}

export const issueTool = defineTool({
  name: "github_issue",
  title: "GitHub issue",
  description:
    "Read one issue, or pull request, with labels and assignees. Set include_comments=true to fetch the latest 20 comments in chronological order.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    number: z.number().int().positive().describe("Issue or pull request number"),
    include_comments: z.boolean().optional().describe("Include the latest 20 comments"),
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
    const { data } = await ctx.client.api<IssueResponse>(
      `/repos/${owner}/${name}/issues/${input.number}`,
      { fresh: input.fresh, cacheTtlMs: 120_000 },
    );
    const result: Record<string, unknown> = issueFields(data, ctx.config.maxFileBytes);
    if (input.include_comments) {
      const first = await ctx.client.api<CommentResponse[]>(
        `/repos/${owner}/${name}/issues/${input.number}/comments?per_page=100`,
        { fresh: input.fresh, cacheTtlMs: 120_000 },
      );
      let comments = first.data;
      const lastPage = linkFor(first.headers, "last");
      if (lastPage) {
        const last = await ctx.client.api<CommentResponse[]>(lastPage, {
          fresh: input.fresh,
          cacheTtlMs: 120_000,
        });
        comments = last.data;
      }
      const latest = comments.slice(-20);
      result.comments = latest.map((comment) => ({
        author: comment.user?.login ?? null,
        body: truncateText(comment.body, ctx.config.maxFileBytes).text,
        created_at: comment.created_at,
      }));
      result.comments_truncated = data.comments > latest.length;
    }
    return result;
  },
});

export const issuesTool = defineTool({
  name: "github_issues",
  title: "GitHub issues",
  description:
    "List issues in a repository with state, label, sort, and direction filters. Issues and pull requests are both returned; each item's type distinguishes them.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    state: z.enum(["open", "closed", "all"]).optional().describe("Issue state, default open"),
    labels: z.string().optional().describe("Comma-separated label names"),
    sort: z.enum(["created", "updated", "comments"]).optional().describe("Sort field"),
    direction: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
    page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
    per_page: z.number().int().min(1).max(100).optional().describe("Items per page, default 20"),
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
      state: input.state,
      labels: input.labels,
      sort: input.sort,
      direction: input.direction,
      page,
      per_page: perPage,
    });
    const { data, headers } = await ctx.client.api<IssueResponse[]>(
      `/repos/${owner}/${name}/issues${query}`,
      { fresh: input.fresh, cacheTtlMs: 120_000 },
    );
    const items = data.map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      type: issue.pull_request === undefined ? "issue" : "pr",
      author: issue.user?.login ?? null,
      labels: labelNames(issue.labels),
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      html_url: issue.html_url,
      comments_count: issue.comments,
    }));
    return listEnvelope(items, page, perPage, headers.get("link"));
  },
});
