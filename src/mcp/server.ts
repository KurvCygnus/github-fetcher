import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolContext } from "../core/context.js";
import { registerTools } from "./register.js";
import { allTools } from "../tools/registry.js";
import { VERSION } from "../core/version.js";

export async function createGithubServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpServer> {
  const warn = (message: string) => console.error(message);
  const ctx = await createToolContext(env, warn);
  const server = new McpServer({ name: "github-fetcher", version: VERSION });
  registerTools(server, allTools, ctx);
  return server;
}
