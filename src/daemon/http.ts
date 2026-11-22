import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { isInitializeRequest, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { authorizeBearer } from "./auth.js";
import { createSessionRegistry } from "./sessions.js";
import type { ToolContext } from "../core/context.js";

const HOST = "127.0.0.1";

export interface DaemonHttpOptions {
  env: NodeJS.ProcessEnv;
  token: string;
  port: number;
  version: string;
  createContext?: (env: NodeJS.ProcessEnv) => Promise<ToolContext>;
  onStop?: () => void;
}

export interface DaemonHttpHandle {
  port: number;
  close(): Promise<void>;
  sessionCount(): number;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function plainText(res: ServerResponse, status: number, message: string): void {
  send(res, status, message, "text/plain; charset=utf-8");
}

function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), "application/json");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startDaemonHttp(options: DaemonHttpOptions): Promise<DaemonHttpHandle> {
  const registry = createSessionRegistry(
    options.createContext === undefined
      ? { env: options.env }
      : { env: options.env, createContext: options.createContext },
  );

  let boundPort = 0;
  let startedAt = 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", `http://${HOST}`).pathname;

    if (path === "/health" && req.method === "GET") {
      if (!authorizeBearer(req.headers.authorization, options.token)) {
        plainText(res, 401, "unauthorized");
        return;
      }
      json(res, 200, {
        status: "ok",
        pid: process.pid,
        port: boundPort,
        version: options.version,
        sessionCount: registry.size(),
        uptimeMs: Date.now() - startedAt,
      });
      return;
    }

    if (path === "/daemon/stop" && req.method === "POST") {
      if (!authorizeBearer(req.headers.authorization, options.token)) {
        plainText(res, 401, "unauthorized");
        return;
      }
      json(res, 200, { stopped: true });
      options.onStop?.();
      return;
    }

    if (path !== "/mcp") {
      plainText(res, 404, "not found");
      return;
    }

    if (!authorizeBearer(req.headers.authorization, options.token)) {
      plainText(res, 401, "unauthorized");
      return;
    }
    await handleMcp(req, res);
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const id = singleHeader(req.headers["mcp-session-id"]);

    if (req.method === "DELETE") {
      if (id === undefined || id === "") {
        plainText(res, 400, "mcp-session-id header is required");
        return;
      }
      if (registry.get(id) === undefined) {
        plainText(res, 404, "Session not found");
        return;
      }
      await registry.close(id);
      res.writeHead(200).end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { allow: "GET, POST, DELETE" }).end();
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      plainText(res, 400, "invalid body");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      plainText(res, 400, "invalid JSON");
      return;
    }

    //* Only an initialize request may open a session. isInitializeRequest accepts
    //* payloads without a jsonrpc version or id that the SDK rejects later, so the
    //* JSON-RPC envelope must also validate before any server state is built.
    if (id === undefined || id === "") {
      if (!isInitializeRequest(parsed) || !JSONRPCMessageSchema.safeParse(parsed).success) {
        plainText(res, 400, "a valid initialize request is required");
        return;
      }
      const entry = await registry.create(singleHeader(req.headers["x-github-token"]));
      try {
        await entry.transport.handleRequest(req, res, parsed);
      } catch (error) {
        //* The SDK can reject initialize after connecting the transport, so an
        //* untracked server must be closed before the error reaches the caller.
        await entry.server.close();
        throw error;
      }
      const sessionId = entry.transport.sessionId;
      if (sessionId === undefined || registry.get(sessionId) === undefined) {
        //* A 400 response may arrive without onsessioninitialized ever firing;
        //* close the connected server so it cannot linger outside the registry.
        await entry.server.close();
      }
      return;
    }

    const entry = registry.get(id);
    if (entry === undefined) {
      plainText(res, 404, "Session not found");
      return;
    }
    await entry.transport.handleRequest(req, res, parsed);
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) plainText(res, 500, message);
      else res.end();
    });
  });

  //* Uptime starts at listener creation so it measures how long the resident
  //* HTTP service has been reachable, excluding pre-listen setup time.
  startedAt = Date.now();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  boundPort = typeof address === "object" && address !== null ? address.port : options.port;

  let closed = false;
  return {
    port: boundPort,
    sessionCount: () => registry.size(),
    close: async () => {
      if (closed) return;
      closed = true;
      await registry.closeAll();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}
