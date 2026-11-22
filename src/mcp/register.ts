import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toGithubError } from "../core/errors.js";
import type { ToolContext } from "../core/context.js";
import type { ToolDefinition } from "../tools/define.js";

//* Single-channel emission is a SUCCESS-payload rule: a JSON text duplicate
//* of a large response doubles its token cost and pushes it past client
//* truncation budgets, so success leaves content as the SDK-required empty
//* array. Error envelopes are small and must ride both channels: clients that
//* surface only content[].text otherwise degrade to a generic error banner.
function success(data: Record<string, unknown>): CallToolResult {
  return { content: [], structuredContent: data };
}

function failure(error: unknown): CallToolResult {
  const envelope = toGithubError(error).toResult();
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    isError: true,
    structuredContent: envelope,
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
