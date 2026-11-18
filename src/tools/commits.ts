import { z } from "zod";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { getPinnedRef } from "./pin.js";
import { listEnvelope } from "./pagination.js";
import { githubQuery, parseRepo, truncateText } from "./util.js";

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
    "List commits on a ref, optionally filtered by path, author, or date range. Returns short sha, message, author, and date; max_message_chars truncates each message. Returns {items[{sha, short_sha, message, author{name, email, login}, date, url}], page, per_page, has_more, next_page}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    ref: z.string().optional().describe("Branch, tag, or commit; defaults to the repository default branch"),
    path: z.string().optional().describe("Only commits touching this path"),
    author: z.string().optional().describe("GitHub login or email to filter by"),
    since: z.string().optional().describe("ISO 8601 lower bound"),
    until: z.string().optional().describe("ISO 8601 upper bound"),
    page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
    per_page: z.number().int().min(1).max(100).optional().describe("Items per page, 1-100, default 20"),
    max_message_chars: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Truncate each commit message to this many UTF-8 bytes"),
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
    //? Session pin honoring: the ref-taking read tools anchor ref-less reads to
    //* the session pin; github_commits has no ref resolution of its own (the
    //* ref travels as the sha query parameter), so the pinned sha fills that
    //* parameter only when the caller omitted ref. An explicit ref always wins
    //* and fresh never unpins; the pin itself adds no upstream call.
    const pinned = getPinnedRef(`${owner}/${name}`);
    const usedPinned = input.ref === undefined ? pinned?.sha : undefined;
    const query = githubQuery({
      sha: input.ref ?? usedPinned ?? undefined,
      path: input.path,
      author: input.author,
      since: input.since,
      until: input.until,
      page,
      per_page: perPage,
    });
    const result = await ctx.client.api<CommitResponse[]>(
      `/repos/${owner}/${name}/commits${query}`,
      { fresh: input.fresh, cacheTtlMs: 120_000 },
    );
    const { data, headers } = result;
    const meta = responseMeta(result, 1);
    const items = data.map((commit) => ({
      sha: commit.sha,
      short_sha: commit.sha.slice(0, 7),
      message:
        input.max_message_chars === undefined
          ? commit.commit.message
          : truncateText(commit.commit.message, input.max_message_chars).text,
      author: {
        name: commit.commit.author.name,
        email: commit.commit.author.email,
        login: commit.author?.login ?? null,
      },
      date: commit.commit.author.date,
      url: commit.html_url,
    }));
    //? pinned_sha appears only when the listing was anchored by the session pin;
    //* meta is spread after it so it stays the trailing key and stays absent
    //* entirely when the client reported no cache outcome.
    return {
      ...listEnvelope(items, page, perPage, headers.get("link")),
      ...(usedPinned !== undefined ? { pinned_sha: usedPinned } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
