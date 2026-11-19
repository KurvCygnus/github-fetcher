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

function request(id, method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
  });
}

const timer = setTimeout(() => {
  child.kill();
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
  console.log(`SMOKE OK ${tools.length} tools`);
} finally {
  clearTimeout(timer);
  child.kill();
}
