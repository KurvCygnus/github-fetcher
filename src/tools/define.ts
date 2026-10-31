import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { Config } from "../config.js";
import { GithubError, toGithubError } from "../errors.js";
import type { GitHubApi } from "../github.js";

export interface ToolContext {
  client: GitHubApi;
  config: Config;
  authFingerprint: string;
}

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: true;
  };
  //? Method declaration (not a property) so parameter checking is bivariant: concrete tool
  //? definitions must stay assignable to ToolDefinition<ZodRawShape> in the tools registry.
  handler(input: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<Record<string, unknown>>;
}

export function defineTool<S extends z.ZodRawShape>(definition: ToolDefinition<S>): ToolDefinition<S> {
  return definition;
}

function success(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function failure(error: unknown): CallToolResult {
  const known = toGithubError(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(known.toResult()) }],
    structuredContent: known.toResult(),
  };
}

export function registerTools(
  server: McpServer,
  tools: readonly ToolDefinition[],
  ctx: ToolContext,
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: unknown) => {
        try {
          return success(await tool.handler(input as never, ctx));
        } catch (error) {
          return failure(error);
        }
      },
    );
  }
}
