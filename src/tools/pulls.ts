import { z } from "zod";
import { defineTool } from "./define.js";
import { linkFor, listEnvelope } from "./pagination.js";
import { githubQuery, parseRepo, truncateText } from "./util.js";

interface PullResponse {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  merged_at: string | null;
  user: { login: string } | null;
  base: { ref: string };
  head: { ref: string };
  body: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  mergeable: boolean | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface PullFileResponse {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export const prTool = defineTool({
  name: "github_pr",
  title: "GitHub pull request",
  description:
    "Read one pull request with branches, stats, mergeability, and optional changed files. Set include_files=true to fetch up to 100 files with patches. Returns PR fields {number, title, state, draft, merged, author, base, head, body, additions, deletions, changed_files, mergeable, created_at, updated_at, merged_at, html_url}; adds {files[{filename, status, additions, deletions, changes, patch}], files_truncated} when include_files is true.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    number: z.number().int().positive().describe("Pull request number"),
    include_files: z.boolean().optional().describe("Include up to 100 changed files"),
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
    const { data } = await ctx.client.api<PullResponse>(
      `/repos/${owner}/${name}/pulls/${input.number}`,
      { fresh: input.fresh, cacheTtlMs: 120_000 },
    );
    const result: Record<string, unknown> = {
      number: data.number,
      title: data.title,
      state: data.state,
      draft: data.draft,
      merged: data.merged_at !== null,
      author: data.user?.login ?? null,
      base: data.base.ref,
      head: data.head.ref,
      body: data.body === null ? null : truncateText(data.body, ctx.config.maxFileBytes).text,
      additions: data.additions,
      deletions: data.deletions,
      changed_files: data.changed_files,
      mergeable: data.mergeable,
      created_at: data.created_at,
      updated_at: data.updated_at,
      merged_at: data.merged_at,
      html_url: data.html_url,
    };
    if (input.include_files) {
      const files = await ctx.client.api<PullFileResponse[]>(
        `/repos/${owner}/${name}/pulls/${input.number}/files?per_page=100`,
        { fresh: input.fresh, cacheTtlMs: 120_000 },
      );
      result.files = files.data.map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: file.patch === undefined ? null : truncateText(file.patch, 4000).text,
      }));
      result.files_truncated = linkFor(files.headers, "next") !== null;
    }
    return result;
  },
});

export const prsTool = defineTool({
  name: "github_prs",
  title: "GitHub pull requests",
  description: "List pull requests with state, base, head, sort, and direction filters. Returns {items[{number, title, state, draft, author, base, head, updated_at, html_url}], page, per_page, has_more, next_page}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    state: z.enum(["open", "closed", "all"]).optional().describe("Pull request state, default open"),
    base: z.string().optional().describe("Base branch filter"),
    head: z.string().optional().describe("Head branch filter, owner:branch"),
    sort: z.enum(["created", "updated", "popularity", "long-running"]).optional().describe("Sort field: created, updated, popularity, or long-running"),
    direction: z.enum(["asc", "desc"]).optional().describe("Sort direction: asc or desc"),
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
      base: input.base,
      head: input.head,
      sort: input.sort,
      direction: input.direction,
      page,
      per_page: perPage,
    });
    const { data, headers } = await ctx.client.api<PullResponse[]>(
      `/repos/${owner}/${name}/pulls${query}`,
      { fresh: input.fresh, cacheTtlMs: 120_000 },
    );
    const items = data.map((pull) => ({
      number: pull.number,
      title: pull.title,
      state: pull.state,
      draft: pull.draft,
      author: pull.user?.login ?? null,
      base: pull.base.ref,
      head: pull.head.ref,
      updated_at: pull.updated_at,
      html_url: pull.html_url,
    }));
    return listEnvelope(items, page, perPage, headers.get("link"));
  },
});
