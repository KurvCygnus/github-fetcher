import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile as nodeExecFile } from "node:child_process";
import { homedir } from "node:os";
import { createTokenResolver, tokenFingerprint, type ExecFileFn } from "./auth.js";
import { createCacheStore, defaultCacheDir } from "./cache.js";
import { loadConfig } from "./config.js";
import { GithubClient } from "./github.js";
import { HttpClient } from "./http.js";
import { resolveProxy } from "./proxy.js";
import { registerTools } from "./tools/define.js";
import { allTools } from "./tools/registry.js";
import { VERSION } from "./version.js";

//? proxy.ts's resolveProxy requires an injected execFile function; this adapter wraps
//? node:child_process with utf8 encoding, the caller-supplied timeout, and windowsHide,
//? matching the ExecFileFn contract.
const execFile: ExecFileFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = nodeExecFile(
      file,
      [...args],
      { encoding: "utf8", timeout: options.timeout, windowsHide: options.windowsHide ?? true },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
    child.stdin?.end(options.input ?? "");
  });

export async function createGithubServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpServer> {
  const warn = (message: string) => console.error(message);
  const config = loadConfig(env, warn);
  const auth = createTokenResolver(config, undefined, warn);
  const token = await auth.get();
  const fingerprint = tokenFingerprint(token);
  const proxy = await resolveProxy(config, execFile, warn);
  const cache = createCacheStore({
    mode: config.cacheMode,
    dir: config.cacheDir ?? defaultCacheDir(env, process.platform, homedir()),
  });
  const http = new HttpClient({ config, auth, proxy });
  const client = new GithubClient({
    http,
    cache,
    config,
    authFingerprint: fingerprint,
  });
  const server = new McpServer({ name: "github-fetcher", version: VERSION });
  registerTools(server, allTools, { client, config, authFingerprint: fingerprint });
  return server;
}
