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

function parseScopes(header: string | null): string[] {
  if (header === null) return [];
  return header.split(",").map((part) => part.trim()).filter((part) => part !== "");
}

export const rateLimitTool = defineTool({
  name: "github_rate_limit",
  title: "GitHub rate limit",
  description:
    "Report the authenticated or anonymous GitHub API quota and reset times. Set resource to project a single bucket such as core or search. Call this first when a request is refused with 403 or 429. Returns {auth, resources keyed by bucket with {limit, remaining, reset, used}}; defaults to core and search; pass all: true for every bucket; adds authenticated_as and scopes when the identity opt-in is on.",
  inputSchema: {
    resource: z
      .string()
      .optional()
      .describe("Limit the projection to one resource bucket, e.g. core or search"),
    all: z
      .boolean()
      .optional()
      .describe("Return every quota bucket; the default projects core and search only"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const { data, headers } = await ctx.client.api<RateLimitResponse>("/rate_limit", { cacheTtlMs: 0 });
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
    //* The default keeps the two buckets callers budget against (core, search);
    //* all: true restores every bucket, and an explicit resource wins over both.
    const resources =
      input.resource === undefined
        ? Object.fromEntries(
            Object.entries(projection).filter(
              ([name]) => input.all === true || name === "core" || name === "search",
            ),
          )
        : Object.fromEntries(
            Object.entries(projection).filter(([name]) => name === input.resource),
          );
    const auth = ctx.authFingerprint === "anonymous" ? "anonymous" : "token";
    if (!ctx.config.exposeIdentity) {
      return { auth, resources };
    }
    const scopes = parseScopes(headers.get("x-oauth-scopes"));
    //* Identity is best-effort: a failed /user lookup degrades to a null login and
    //* the quota answer still goes out; the underlying error is never surfaced.
    let authenticatedAs: string | null = null;
    if (auth === "token") {
      try {
        const user = await ctx.client.api<{ login: string }>("/user", { cacheTtlMs: 300_000 });
        authenticatedAs = user.data.login;
      } catch {
        authenticatedAs = null;
      }
    }
    return { auth, authenticated_as: authenticatedAs, scopes, resources };
  },
});
