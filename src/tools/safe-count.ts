import { GithubError } from "../core/errors.js";
import type { ToolContext } from "../core/context.js";

//* Search counts are the quota-critical path: a 422 (search-restricted but
//* legitimate repository) degrades to null instead of killing a whole batch;
//* everything else stays loud.
export async function safeCount(
  ctx: ToolContext,
  query: string,
  fresh: boolean | undefined,
): Promise<number | null> {
  try {
    const { data } = await ctx.client.api<{ total_count: number }>(
      `/search/issues?q=${encodeURIComponent(query)}&per_page=1`,
      { fresh, cacheTtlMs: 60_000 },
    );
    return data.total_count;
  } catch (error) {
    if (error instanceof GithubError && error.code === "invalid_params") return null;
    throw error;
  }
}
