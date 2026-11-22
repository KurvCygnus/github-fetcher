import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../core/context.js";
import { createToolContext } from "../core/context.js";
import { createGithubServer } from "../mcp/server.js";

export interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  ctx: ToolContext;
}

export interface SessionRegistryOptions {
  env: NodeJS.ProcessEnv;
  createContext?: (env: NodeJS.ProcessEnv) => Promise<ToolContext>;
}

//* A header value overrides credentials only. Keeping every other daemon env
//* key intact means proxy, cache and timeout settings stay session-independent.
export function withTokenOverride(
  env: NodeJS.ProcessEnv,
  header: string | undefined,
): NodeJS.ProcessEnv {
  if (header === undefined) return env;
  return { ...env, GITHUB_TOKEN: header, GH_TOKEN: header };
}

export function createSessionRegistry(options: SessionRegistryOptions) {
  const sessions = new Map<string, SessionEntry>();
  const buildContext = options.createContext ?? createToolContext;

  //* Register from onsessioninitialized rather than before: the SDK assigns the
  //* session id during initialize, so the map key does not exist until then.
  async function create(header: string | undefined): Promise<SessionEntry> {
    const env = withTokenOverride(options.env, header);
    const ctx = await buildContext(env);
    const server = await createGithubServer(env, ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id: string) => {
        sessions.set(id, { server, transport, ctx });
      },
      //* If the SDK ever handles DELETE directly it fires this callback, so the
      //* map stays in sync even outside our own HTTP layer's explicit close.
      onsessionclosed: (id: string) => {
        sessions.delete(id);
      },
    });
    await server.connect(transport);
    return { server, transport, ctx };
  }

  function get(id: string): SessionEntry | undefined {
    return sessions.get(id);
  }

  //* The SDK calls onsessionclosed only on DELETE, not on transport.close(), so
  //* an explicit removal here is required for daemon shutdown and direct closes.
  async function close(id: string): Promise<void> {
    const entry = sessions.get(id);
    if (entry === undefined) return;
    sessions.delete(id);
    await entry.server.close();
  }

  function size(): number {
    return sessions.size;
  }

  async function closeAll(): Promise<void> {
    const entries = [...sessions.values()];
    sessions.clear();
    await Promise.all(entries.map((entry) => entry.server.close()));
  }

  return { create, get, close, size, closeAll };
}
