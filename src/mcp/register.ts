import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toGithubError } from "../core/errors.js";
import type { ToolContext } from "../core/context.js";
import type { ToolDefinition } from "../tools/define.js";

//? Single-channel emission: clients read structuredContent, so a JSON text
//? duplicate doubles the token cost and pushes large responses past client
//? truncation budgets. content stays a required empty array per the SDK
//? CallToolResult type; legacy text-only clients accept the empty payload.
function success(data: Record<string, unknown>): CallToolResult {
  return { content: [], structuredContent: data };
}

function failure(error: unknown): CallToolResult {
  const known = toGithubError(error);
  return { content: [], isError: true, structuredContent: known.toResult() };
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
