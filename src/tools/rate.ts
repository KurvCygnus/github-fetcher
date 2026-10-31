import { z } from "zod";
import { defineTool } from "./define.js";

interface RateResource {
  limit: number;
  remaining: number;
  reset: number;
  used: number;
}

interface RateLimitResponse {
  resources: Record<string, RateResource>;
}

export const rateLimitTool = defineTool({
  name: "github_rate_limit",
  title: "GitHub rate limit",
  description:
    "Report the authenticated or anonymous GitHub API quota and reset times. Set resource to project a single bucket such as core or search. Call this first when a request is refused with 403 or 429.",
  inputSchema: {
    resource: z
      .string()
      .optional()
      .describe("Limit the projection to one resource bucket, e.g. core or search"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const { data } = await ctx.client.api<RateLimitResponse>("/rate_limit", { cacheTtlMs: 0 });
    const projection = Object.fromEntries(
      Object.entries(data.resources).map(([name, value]) => [
        name,
        {
          limit: value.limit,
          remaining: value.remaining,
          reset: new Date(value.reset * 1000).toISOString(),
          used: value.used,
        },
      ]),
    );
    //* Unknown buckets project to an empty object because GitHub omits keys it
    //* does not report; callers can tell a missing bucket from an empty quota.
    const resources =
      input.resource === undefined
        ? projection
        : Object.fromEntries(
            Object.entries(projection).filter(([name]) => name === input.resource),
          );
    return {
      auth: ctx.authFingerprint === "anonymous" ? "anonymous" : "token",
      resources,
    };
  },
});
