import { z } from "zod";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { listEnvelope } from "./pagination.js";
import { githubQuery, parseRepo } from "./util.js";

interface BranchResponse {
  name: string;
  commit: { sha: string };
  protected: boolean;
}

export const branchesTool = defineTool({
  name: "github_branches",
  title: "GitHub branches",
  description: "List branches with their head sha and protection state. Returns {items[{name, sha, protected}], page, per_page, has_more, next_page}.",
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
    const result = await ctx.client.api<BranchResponse[]>(
      `/repos/${owner}/${name}/branches${query}`,
      { fresh: input.fresh, cacheTtlMs: 120_000 },
    );
    const { data, headers } = result;
    const meta = responseMeta(result);
    const items = data.map((branch) => ({
      name: branch.name,
      sha: branch.commit.sha,
      protected: branch.protected,
    }));
    //? meta is spread after the list envelope so it stays the trailing key and
    //* stays absent entirely when the client reported no cache outcome.
    return {
      ...listEnvelope(items, page, perPage, headers.get("link")),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
