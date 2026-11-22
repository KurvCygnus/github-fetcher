import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "../../src/core/context.js";
import { createPinStore } from "../../src/core/pin-store.js";
import { startDaemonHttp } from "../../src/daemon/http.js";
import { withTokenOverride } from "../../src/daemon/sessions.js";
import { makeClientWith, makeConfig } from "../helpers.js";

interface DaemonHandle {
  port: number;
  close(): Promise<void>;
  sessionCount(): number;
}

interface RpcOptions {
  auth?: boolean;
  sessionId?: string;
  extra?: Record<string, string>;
}

interface RpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: unknown;
}

interface ToolListResult {
  tools: Array<{ name: string }>;
}

interface HealthBody {
  status: string;
  pid: number;
  port: number;
  version: string;
  sessionCount: number;
  uptimeMs: number;
}

const TOKEN = "daemon-test-token";

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "loopback-test", version: "1.0.0" },
  },
};

describe("daemon http (loopback integration)", () => {
  let daemon: DaemonHandle;
  let base: string;
  let sessionA: string;
  let sessionB: string;
  const builtContexts: ToolContext[] = [];
  let stopCount = 0;

  beforeAll(async () => {
    daemon = await startDaemonHttp({
      env: {},
      token: TOKEN,
      port: 0,
      version: "0.6.0",
      onStop: () => {
        stopCount += 1;
      },
      //* Capture each session context so the token-override and per-session pin
      //* assertions can inspect the exact objects the handler built, without a
      //* real GitHub client, proxy lookup or user config read.
      createContext: async (env: NodeJS.ProcessEnv): Promise<ToolContext> => {
        const ctx: ToolContext = {
          client: makeClientWith([]),
          config: makeConfig(),
          authFingerprint: env["GITHUB_TOKEN"] ?? "no-token",
          pins: createPinStore(),
        };
        builtContexts.push(ctx);
        return ctx;
      },
    });
    base = `http://127.0.0.1:${daemon.port}`;
  });

  afterAll(async () => {
    await daemon.close();
  });

  async function post(body: unknown, options: RpcOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(options.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }),
      ...(options.sessionId === undefined ? {} : { "mcp-session-id": options.sessionId }),
      ...options.extra,
    };
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  async function del(sessionId: string): Promise<Response> {
    return fetch(`${base}/mcp`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "mcp-session-id": sessionId,
      },
    });
  }

  async function openSession(tokenHeader: string): Promise<string> {
    const res = await post(initializeBody, {
      extra: { "x-github-token": tokenHeader },
    });
    expect(res.status).toBe(200);
    const id = res.headers.get("mcp-session-id");
    expect(id).toBeTruthy();
    return id as string;
  }

  async function initializeThenList(sessionId: string): Promise<RpcResponse<ToolListResult>> {
    const ready = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { sessionId });
    expect(ready.ok).toBe(true);
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { sessionId });
    expect(res.status).toBe(200);
    return (await res.json()) as RpcResponse<ToolListResult>;
  }

  it("guards /health with the exact bearer token and reports the bound endpoint", async () => {
    const unauthorized = await fetch(`${base}/health`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${base}/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authorized.status).toBe(200);
    const body = (await authorized.json()) as HealthBody;
    expect(body.status).toBe("ok");
    expect(body.pid).toBe(process.pid);
    expect(body.port).toBeGreaterThan(0);
    expect(body.port).toBe(daemon.port);
    expect(body.version).toBe("0.6.0");
    expect(body.sessionCount).toBe(0);
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects an initialize request without the bearer token", async () => {
    const res = await post(initializeBody, { auth: false });
    expect(res.status).toBe(401);
  });

  it("rejects a non-initialize request without a session id before tool dispatch", async () => {
    const res = await post({ jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown session id and a malformed JSON body", async () => {
    const unknown = await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, {
      sessionId: "does-not-exist",
    });
    expect(unknown.status).toBe(404);

    const malformed = await post("{not json");
    expect(malformed.status).toBe(400);
  });

  it("lists all 41 tools on an initialized session", async () => {
    sessionA = await openSession("token-a");
    const body = await initializeThenList(sessionA);
    expect(body.result?.tools).toHaveLength(41);
    const names = body.result?.tools.map((tool) => tool.name) ?? [];
    expect(names).toContain("github_commit");
    expect(names).toContain("github_file_grep");
    expect(daemon.sessionCount()).toBe(1);
  });

  it("isolates context authFingerprint and pin store per X-GitHub-Token", async () => {
    sessionB = await openSession("token-b");
    expect(daemon.sessionCount()).toBe(2);

    const first = builtContexts[0];
    const second = builtContexts[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.authFingerprint).toBe("token-a");
    expect(second?.authFingerprint).toBe("token-b");
    expect(first?.pins).toBeDefined();
    expect(second?.pins).toBeDefined();
    first?.pins?.set("owner/repo", "main", "sha-one");
    expect(second?.pins?.get("owner/repo")).toBeUndefined();
  });

  it("drops the session count back to zero on DELETE", async () => {
    const firstDelete = await del(sessionA);
    expect(firstDelete.status).toBe(200);
    expect(daemon.sessionCount()).toBe(1);

    const secondDelete = await del(sessionB);
    expect(secondDelete.status).toBe(200);
    expect(daemon.sessionCount()).toBe(0);
  });

  it("guards /daemon/stop and fires onStop on an authorized stop", async () => {
    const unauthorized = await fetch(`${base}/daemon/stop`, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    expect(stopCount).toBe(0);

    const authorized = await fetch(`${base}/daemon/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(authorized.status).toBe(200);
    expect(stopCount).toBe(1);
  });
});

describe("daemon http session hygiene (loopback integration)", () => {
  let daemon: DaemonHandle;
  let base: string;
  let contextCount = 0;

  beforeAll(async () => {
    daemon = await startDaemonHttp({
      env: {},
      token: TOKEN,
      port: 0,
      version: "0.6.0",
      //* Count constructions so a rejected initialize cannot silently build a
      //* real server/transport pair and leave it untracked in the registry.
      createContext: async (env: NodeJS.ProcessEnv): Promise<ToolContext> => {
        contextCount += 1;
        return {
          client: makeClientWith([]),
          config: makeConfig(),
          authFingerprint: env["GITHUB_TOKEN"] ?? "no-token",
          pins: createPinStore(),
        };
      },
    });
    base = `http://127.0.0.1:${daemon.port}`;
  });

  afterAll(async () => {
    await daemon.close();
  });

  async function post(body: unknown): Promise<Response> {
    return fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
    });
  }

  it("rejects an initialize without a JSON-RPC envelope before building a context", async () => {
    const before = contextCount;
    const res = await post({
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "leak-probe", version: "1.0.0" },
      },
    });
    expect(res.status).toBe(400);
    expect(daemon.sessionCount()).toBe(0);
    expect(contextCount).toBe(before);
  });

  it("rejects a well-formed envelope with invalid initialize params before building a context", async () => {
    const before = contextCount;
    const res = await post({ jsonrpc: "2.0", id: 7, method: "initialize", params: {} });
    expect(res.status).toBe(400);
    expect(daemon.sessionCount()).toBe(0);
    expect(contextCount).toBe(before);
  });
});

describe("withTokenOverride", () => {
  it("sets both token env keys when a header is present", () => {
    const overridden = withTokenOverride({ GH_TOKEN: "old" }, "new");
    expect(overridden["GITHUB_TOKEN"]).toBe("new");
    expect(overridden["GH_TOKEN"]).toBe("new");
  });

  it("returns the same env object when no header is present", () => {
    const env = { GH_TOKEN: "keep" };
    expect(withTokenOverride(env, undefined)).toBe(env);
  });
});
