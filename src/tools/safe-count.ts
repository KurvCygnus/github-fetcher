import type { ApiResult } from "../core/github.js";
import { GithubError } from "../core/errors.js";
import type { ToolContext } from "../core/context.js";

//? The count and the raw client result travel together: multi-request callers
//? (health, compare) fold the result into their scarcest-meta report, while a
//? degraded search leaves result undefined like any other rejected sub-request.
export interface SafeCountResult {
  total: number | null;
  result: ApiResult<{ total_count: number }> | undefined;
}

//* Search counts are the quota-critical path: a 422 (search-restricted but
//* legitimate repository) degrades to a null total instead of killing a whole
//* batch; everything else stays loud.
export async function safeCount(
  ctx: ToolContext,
  query: string,
  fresh: boolean | undefined,
): Promise<SafeCountResult> {
  try {
    const result = await ctx.client.api<{ total_count: number }>(
      `/search/issues?q=${encodeURIComponent(query)}&per_page=1`,
      { fresh, cacheTtlMs: 60_000 },
    );
    return { total: result.data.total_count, result };
  } catch (error) {
    if (error instanceof GithubError && error.code === "invalid_params") {
      return { total: null, result: undefined };
    }
    throw error;
  }
}
