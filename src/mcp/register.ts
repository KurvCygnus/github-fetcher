import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toGithubError } from "../core/errors.js";
import type { ToolContext } from "../core/context.js";
import type { ToolDefinition } from "../tools/define.js";

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
