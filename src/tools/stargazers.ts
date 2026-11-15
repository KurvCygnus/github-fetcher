import { z } from "zod";
import { defineTool } from "./define.js";
import { responseMeta } from "./meta.js";
import { listEnvelope } from "./pagination.js";
import { githubQuery, parseRepo } from "./util.js";

//? Only the fields this tool reads are typed; with the star+json media type
//* each item wraps a user object beside the time the star was given, and a
//* deleted account can answer with a null user.
interface StargazerItem {
  starred_at: string | null;
  user: { login: string } | null;
}

export const stargazersTool = defineTool({
  name: "github_stargazers",
  title: "GitHub repository stargazers",
  description:
    "List a repository's stargazers with the time each star was given (star+json media type). Pages are ordered oldest-first by default, so paged calls build a star timeline; compute velocity client-side from starred_at deltas. Costs 1 core call. Returns {items[{login, starred_at}], page, per_page, has_more, next_page}.",
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
    const result = await ctx.client.api<StargazerItem[]>(`/repos/${owner}/${name}/stargazers${query}`, {
      fresh: input.fresh,
      cacheTtlMs: 300_000,
      accept: "application/vnd.github.star+json",
    });
    const { data, headers } = result;
    const meta = responseMeta(result, 1);
    const items = data.map((entry) => ({
      login: entry.user?.login ?? null,
      starred_at: entry.starred_at,
    }));
    //? meta is spread after the list envelope so it stays the trailing key and
    //* stays absent entirely when the client reported no cache outcome.
    return {
      ...listEnvelope(items, page, perPage, headers.get("link")),
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
