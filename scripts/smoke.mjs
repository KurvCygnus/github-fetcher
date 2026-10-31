import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
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
  if (tools.length !== 21) throw new Error(`expected 21 tools, got ${tools.length}`);
  const names = new Set(tools.map((tool) => tool.name));
  for (const required of ["github_rate_limit", "github_repo", "github_file", "github_search_code", "github_api_get"]) {
    if (!names.has(required)) throw new Error(`missing tool ${required}`);
  }
  console.log(`SMOKE OK ${tools.length} tools`);
} finally {
  clearTimeout(timer);
  child.kill();
}
