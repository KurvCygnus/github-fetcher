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
    "Report the authenticated or anonymous GitHub API quota and reset times. Call this first when a request is refused with 403 or 429.",
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(_input, ctx) {
    const { data } = await ctx.client.api<RateLimitResponse>("/rate_limit", { cacheTtlMs: 0 });
    const resources = Object.fromEntries(
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
    return {
      auth: ctx.authFingerprint === "anonymous" ? "anonymous" : "token",
      resources,
    };
  },
});
