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
    "Read one issue, or pull request, with labels and assignees. Set include_comments=true to fetch the latest comments in chronological order; comment_limit caps how many (default 20) and max_comment_chars truncates each body. Returns issue fields {number, title, state, author, labels, assignees, body, created_at, updated_at, closed_at, comments_count, html_url}; adds {comments[{author, body, created_at}], comments_truncated} when include_comments is true.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    number: z.number().int().positive().describe("Issue or pull request number"),
    include_comments: z.boolean().optional().describe("Include the latest comments"),
    comment_limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Number of latest comments to include, default 20"),
    max_comment_chars: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Truncate each comment body to this many characters"),
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
      const limit = input.comment_limit ?? 20;
      let comments = first.data;
      const lastPage = linkFor(first.headers, "last");
      if (lastPage !== null) {
        //* The newest page alone may hold fewer than the requested limit. Walk backwards until
        //* enough comments are collected; each step prepends an older page in chronological order.
        const collected: CommentResponse[] = [];
        let page: string | null = lastPage;
        while (page !== null && collected.length < limit) {
          const response = await ctx.client.api<CommentResponse[]>(page, {
            fresh: input.fresh,
            cacheTtlMs: 120_000,
          });
          collected.unshift(...response.data);
          page = linkFor(response.headers, "prev");
        }
        comments = collected;
      }
      const latest = comments.slice(-limit);
      result.comments = latest.map((comment) => ({
        author: comment.user?.login ?? null,
        body: truncateText(
          comment.body,
          input.max_comment_chars ?? ctx.config.maxFileBytes,
        ).text,
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
    'List issues in a repository with state, label, sort, direction, and since filters. Defaults to issues only; set type to "all" to include pull requests or "pr" for pull requests alone. For aggregate counts over a time window, use github_repo_health instead of paging. Returns {items[{number, title, state, type, author, labels, created_at, updated_at, html_url, comments_count}], page, per_page, has_more, next_page}.',
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    type: z.enum(["issue", "pr", "all"]).optional().describe("Item kind, default issue"),
    state: z.enum(["open", "closed", "all"]).optional().describe("Issue state, default open"),
    labels: z.string().optional().describe("Comma-separated label names"),
    sort: z.enum(["created", "updated", "comments"]).optional().describe("Sort field: created, updated, or comments"),
    direction: z.enum(["asc", "desc"]).optional().describe("Sort direction: asc or desc"),
    since: z
      .string()
      .optional()
      .describe("Only issues updated at or after this ISO 8601 time (GitHub semantics)"),
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
      state: input.state,
      labels: input.labels,
      sort: input.sort,
      direction: input.direction,
      since: input.since,
      page,
      per_page: perPage,
    });
    const { data, headers } = await ctx.client.api<IssueResponse[]>(
      `/repos/${owner}/${name}/issues${query}`,
      { fresh: input.fresh, cacheTtlMs: 120_000 },
    );
    const mapped = data.map((issue) => ({
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
    const typeFilter = input.type ?? "issue";
    //* The type filter is client-side because the issues endpoint accepts no kind
    //* parameter. The Link header still describes the unfiltered page, so has_more
    //* and next_page stay accurate even when this page's items are all filtered out.
    const items = typeFilter === "all" ? mapped : mapped.filter((item) => item.type === typeFilter);
    return listEnvelope(items, page, perPage, headers.get("link"));
  },
});
