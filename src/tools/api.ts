import { z } from "zod";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { truncateText } from "./util.js";

export const apiGetTool = defineTool({
  name: "github_api_get",
  title: "GitHub API GET",
  description:
    "Escape hatch for read-only GitHub REST GET requests that the dedicated tools do not cover. The host is fixed to api.github.com; GraphQL and writes are not supported. Returns {status, content_type, body, truncated, cache, cache_age_seconds}.",
  inputSchema: {
    path: z.string().describe("Absolute API path, for example /repos/owner/name/readme"),
    query: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe("Query parameters; entries override pairs already present in path"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const separator = input.path.indexOf("?");
    const pathPart = separator === -1 ? input.path : input.path.slice(0, separator);
    const queryPart = separator === -1 ? null : input.path.slice(separator + 1);
    if (!pathPart.startsWith("/") || pathPart.includes("//") || pathPart.includes("..") || pathPart.includes("#")) {
      throw new GithubError("invalid_params", "path must be an absolute API path without .., //, or #");
    }
    if (queryPart !== null && queryPart.includes("?")) {
      throw new GithubError("invalid_params", "path must contain at most one query string separator (?)");
    }
    if (pathPart === "/graphql") {
      throw new GithubError("unsupported", "GraphQL is not supported; use REST paths");
    }
    const params = new URLSearchParams(queryPart ?? "");
    for (const [key, value] of Object.entries(input.query ?? {})) {
      params.set(key, String(value));
    }
    const queryString = params.toString();
    const url = `${pathPart}${queryString === "" ? "" : `?${queryString}`}`;
    const response = await ctx.client.apiRaw(url, { fresh: input.fresh });
    const text = new TextDecoder("utf-8").decode(response.bytes);
    const clipped = truncateText(text, ctx.config.maxFileBytes);
    if (clipped.truncated && response.contentType.includes("application/json")) {
      return {
        status: response.status,
        content_type: response.contentType,
        body: null,
        truncated: true,
        ...(response.cache ? { cache: response.cache.state } : {}),
        ...(response.cache?.ageSeconds !== undefined ? { cache_age_seconds: response.cache.ageSeconds } : {}),
        hint: "response exceeded GITHUB_MCP_MAX_FILE_BYTES; narrow the query (e.g. per_page) or raise the limit",
      };
    }
    let body: unknown = clipped.text;
    if (response.contentType.includes("application/json")) {
      try {
        body = JSON.parse(clipped.text);
      } catch {
        body = clipped.text;
      }
    }
    return {
      status: response.status,
      content_type: response.contentType,
      body,
      truncated: clipped.truncated,
      ...(response.cache ? { cache: response.cache.state } : {}),
      ...(response.cache?.ageSeconds !== undefined ? { cache_age_seconds: response.cache.ageSeconds } : {}),
    };
  },
});
