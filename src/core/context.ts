import { homedir } from "node:os";
import { createTokenResolver, defaultExecFile, tokenFingerprint } from "./auth.js";
import { createCacheStore, defaultCacheDir } from "./cache.js";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { GithubClient } from "./github.js";
import type { GitHubApi } from "./github.js";
import { HttpClient } from "./http.js";
import { resolveProxy } from "./proxy.js";

//? env and warn are injectable so tests can wire an offline context (env token,
//? direct proxy, cache off) without spawning git or touching the real filesystem.
export interface ToolContext {
  client: GitHubApi;
  config: Config;
  authFingerprint: string;
}

export async function createToolContext(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.error,
): Promise<ToolContext> {
  const config = loadConfig(env, warn);
  const auth = createTokenResolver(config, undefined, warn);
  const token = await auth.get();
  const fingerprint = tokenFingerprint(token);
  const proxy = await resolveProxy(config, defaultExecFile, warn);
  const cache = createCacheStore({
    mode: config.cacheMode,
    dir: config.cacheDir ?? defaultCacheDir(env, process.platform, homedir()),
  });
  const http = new HttpClient({ config, auth, proxy });
  const client = new GithubClient({ http, cache, config, authFingerprint: fingerprint });
  return { client, config, authFingerprint: fingerprint };
}
