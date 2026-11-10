import { z } from "zod";
import { defineTool } from "./define.js";
import { listEnvelope } from "./pagination.js";
import { githubQuery, parseRepo } from "./util.js";

//? Only the fields this tool reads are typed; the REST payload carries more.
interface ContributorResponse {
  login: string;
  type: string;
  contributions: number;
}

export const contributorsTool = defineTool({
  name: "github_contributors",
  title: "GitHub repository contributors",
  description:
    "List a repository's contributors with login, account type, and contribution count; anonymous contributors are never included. Costs 1 core call. Returns {items[{login, type, contributions}], page, per_page, has_more, next_page}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
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
    const query = githubQuery({ page, per_page: perPage });
    const { data, headers } = await ctx.client.api<ContributorResponse[]>(
      `/repos/${owner}/${name}/contributors${query}`,
      { fresh: input.fresh, cacheTtlMs: 120_000 },
    );
    const items = data.map((contributor) => ({
      login: contributor.login,
      type: contributor.type,
      contributions: contributor.contributions,
    }));
    return listEnvelope(items, page, perPage, headers.get("link"));
  },
});
