import { z } from "zod";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import { githubQuery, truncateText } from "./util.js";

export const apiGetTool = defineTool({
  name: "github_api_get",
  title: "GitHub API GET",
  description:
    "Escape hatch for read-only GitHub REST GET requests that the dedicated tools do not cover. The host is fixed to api.github.com; GraphQL and writes are not supported.",
  inputSchema: {
    path: z.string().describe("Absolute API path, for example /repos/owner/name/readme"),
    query: z.record(z.string(), z.string()).optional().describe("Query string parameters"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const path = input.path;
    if (!path.startsWith("/") || path.includes("//") || path.includes("..") || path.includes("#") || path.includes("?")) {
      throw new GithubError("invalid_params", "path must be an absolute API path without .., //, #, or a query string");
    }
    if (path === "/graphql") {
      throw new GithubError("unsupported", "GraphQL is not supported; use REST paths");
    }
    const url = `${path}${githubQuery(input.query ?? {})}`;
    const response = await ctx.client.apiRaw(url);
    const text = new TextDecoder("utf-8").decode(response.bytes);
    const clipped = truncateText(text, ctx.config.maxFileBytes);
    if (clipped.truncated && response.contentType.includes("application/json")) {
      return {
        status: response.status,
        content_type: response.contentType,
        body: null,
        truncated: true,
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
    };
  },
});
