import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const child = spawn(process.execPath, [entry], {
  env: { ...process.env, GITHUB_CACHE: "memory", GITHUB_PROXY_MODE: "direct" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const resolve = pending.get(message.id);
  if (resolve) {
    pending.delete(message.id);
    resolve(message);
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

let daemonChild = undefined;
const RPC_TIMEOUT_MS = 5000;

async function waitForDaemon(base, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${base}/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        const health = await response.json();
        if (health?.status === "ok") return health;
      }
    } catch {
      //* A refused connection before the listener binds is expected; retry.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`daemon health check timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function waitForExit(proc, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve();
      return;
    }
    let timer;
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      proc.off("exit", onExit);
      reject(new Error("daemon exit timed out"));
    }, timeoutMs);
    proc.once("exit", onExit);
  });
}

function request(id, method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
  });
}

const timer = setTimeout(() => {
  child.kill();
  //* process.exit skips finally, so the daemon must be signalled here as well.
  if (daemonChild !== undefined && daemonChild.exitCode === null && daemonChild.signalCode === null) {
    daemonChild.kill();
  }
  console.error("smoke timeout");
  process.exit(1);
}, 30000);

try {
  const init = await request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  if (!init.result) throw new Error(`initialize failed: ${JSON.stringify(init)}`);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await request(2, "tools/list", {});
  const tools = list.result?.tools ?? [];
  if (tools.length !== 41) throw new Error(`expected 41 tools, got ${tools.length}`);
  const names = new Set(tools.map((tool) => tool.name));
  for (const required of ["github_rate_limit", "github_repo", "github_file", "github_search_code", "github_commit", "github_api_get"]) {
    if (!names.has(required)) throw new Error(`missing tool ${required}`);
  }
  //? Dist worker-parity probe: the grep match loop executes in an eval worker
  //* whose source is a compiled template literal (WORKER_SOURCE), so a future
  //* tsc target or transform change could silently break the dist-only shape
  //* while vitest keeps passing. Import the built artifact and run one real
  //* round trip so every rehearsal proves the built worker still works: "re"
  //* matches exactly once, inside "three" on line 3.
  const { WORKER_SOURCE } = await import(new URL("../dist/tools/file-grep-worker.js", import.meta.url));
  const parity = await new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    let settled = false;
    const settle = (route) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      route();
    };
    worker.on("message", (value) => settle(() => resolve(value)));
    worker.on("error", (error) => settle(() => reject(error)));
    worker.postMessage({ pattern: "re", text: "one\ntwo\nthree\n", contextLines: 0, maxMatches: 10 });
    setTimeout(() => settle(() => reject(new Error("grep worker parity probe timeout"))), 10000);
  });
  if (parity?.ok !== true) {
    throw new Error(`grep worker parity probe failed: ${JSON.stringify(parity)}`);
  }
  const probeMatches = parity.result?.matches ?? [];
  if (probeMatches.length !== 1 || probeMatches[0]?.line !== 3) {
    throw new Error(`grep worker parity probe expected one match on line 3, got ${JSON.stringify(parity.result)}`);
  }

  //* HTTP handshake: prove the built daemon serves the same toolset over
  //* bearer-authed loopback HTTP, so a transport regression fails the smoke.
  const daemonToken = "smoke-daemon-token";
  const daemonPort = 41973;
  const base = `http://127.0.0.1:${daemonPort}`;
  daemonChild = spawn(process.execPath, [entry, "serve", "--daemon"], {
    env: {
      ...process.env,
      GITHUB_CACHE: "memory",
      GITHUB_PROXY_MODE: "direct",
      GITHUB_MCP_DAEMON_TOKEN: daemonToken,
      GITHUB_MCP_DAEMON_PORT: String(daemonPort),
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  daemonChild.stderr?.on("data", (chunk) => process.stderr.write(chunk));

  const health = await waitForDaemon(base, daemonToken, 15000);
  if (health.port !== daemonPort) {
    throw new Error(`daemon port mismatch: ${JSON.stringify(health)}`);
  }
  const rpcHeaders = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${daemonToken}`,
  };
  const initResponse = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: rpcHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke-http", version: "0.0.0" },
      },
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!initResponse.ok) throw new Error(`HTTP initialize failed: ${initResponse.status}`);
  const initBody = await initResponse.json();
  if (!initBody.result) throw new Error(`HTTP initialize missing result: ${JSON.stringify(initBody)}`);
  const sessionId = initResponse.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("HTTP initialize missing mcp-session-id header");

  const ready = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...rpcHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!ready.ok) throw new Error(`HTTP initialized notification failed: ${ready.status}`);

  const listResponse = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...rpcHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!listResponse.ok) throw new Error(`HTTP tools/list failed: ${listResponse.status}`);
  const listBody = await listResponse.json();
  const httpTools = listBody.result?.tools ?? [];
  if (httpTools.length !== 41) throw new Error(`HTTP tools/list expected 41 tools, got ${httpTools.length}`);

  const stopResponse = await fetch(`${base}/daemon/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${daemonToken}` },
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!stopResponse.ok) throw new Error(`daemon stop failed: ${stopResponse.status}`);
  await waitForExit(daemonChild, 5000);

  console.log(`SMOKE OK ${tools.length} tools`);
} finally {
  clearTimeout(timer);
  child.kill();
  if (daemonChild !== undefined && daemonChild.exitCode === null && daemonChild.signalCode === null) {
    daemonChild.kill();
  }
}
