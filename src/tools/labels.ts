import { z } from "zod";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { listEnvelope } from "./pagination.js";
import { githubQuery, parseRepo } from "./util.js";

interface LabelResponse {
  name: string;
  color: string;
  description: string | null;
  open_issues_count?: number | undefined;
  closed_issues_count?: number | undefined;
}

export const labelsTool = defineTool({
  name: "github_labels",
  title: "GitHub labels",
  description: "List repository labels with their name, color, and description. GitHub's labels endpoint does not supply issue counts, so open_issues_count and closed_issues_count stay null even with with_counts true; no extra call is made. Returns {repo, items[{name, color, description, open_issues_count, closed_issues_count}], page, per_page, has_more, next_page, meta}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
    per_page: z.number().int().min(1).max(100).optional().describe("Items per page, 1-100, default 30"),
    with_counts: z.boolean().optional().describe("GitHub's labels endpoint does not supply issue counts, so both counts stay null; no extra calls"),
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
    const perPage = input.per_page ?? 30;
    const query = githubQuery({ page, per_page: perPage });
    const result = await ctx.client.api<LabelResponse[]>(
      `/repos/${owner}/${name}/labels${query}`,
      { fresh: input.fresh, cacheTtlMs: 120_000 },
    );
    const { data, headers } = result;
    const meta = responseMeta(result, 1);
    //* with_counts is a pure projection flag: it copies upstream issue counts when
    //* present and emits null otherwise, and it never adds a second client call.
    const items = data.map((label) => ({
      name: label.name,
      color: label.color,
      description: label.description,
      open_issues_count: input.with_counts === true ? label.open_issues_count ?? null : null,
      closed_issues_count: input.with_counts === true ? label.closed_issues_count ?? null : null,
    }));
    //? meta is spread after the list envelope so it stays the trailing key and
    //* stays absent entirely when the client reported no cache outcome.
    return {
      repo: input.repo,
      ...listEnvelope(items, page, perPage, headers.get("link")),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
