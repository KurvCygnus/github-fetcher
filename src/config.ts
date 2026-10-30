export type ProxyMode = "auto" | "always" | "direct";
export type CacheMode = "disk" | "memory" | "off";
export type LogLevel = "error" | "info" | "debug";

export interface Config {
  //? Optional props spell out "undefined" so loadConfig can pass through absent env vars under exactOptionalPropertyTypes.
  githubToken?: string | undefined;
  ghToken?: string | undefined;
  githubProxy?: string | undefined;
  httpsProxy?: string | undefined;
  httpProxy?: string | undefined;
  proxyMode: ProxyMode;
  cacheMode: CacheMode;
  cacheDir?: string | undefined;
  logLevel: LogLevel;
  timeoutMs: number;
  maxFileBytes: number;
}

type Warn = (message: string) => void;

function pickOne<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string,
  warn: Warn,
): T {
  if (value === undefined || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  warn(`Invalid ${name}: ${value}; using ${fallback}`);
  return fallback;
}

function pickInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  name: string,
  warn: Warn,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    warn(`Invalid ${name}: ${value}; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

function optional(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function loadConfig(env: NodeJS.ProcessEnv, warn: Warn = () => {}): Config {
  return {
    githubToken: optional(env.GITHUB_TOKEN),
    ghToken: optional(env.GH_TOKEN),
    githubProxy: optional(env.GITHUB_PROXY),
    httpsProxy: optional(env.HTTPS_PROXY),
    httpProxy: optional(env.HTTP_PROXY),
    proxyMode: pickOne(env.GITHUB_PROXY_MODE, ["auto", "always", "direct"], "auto", "GITHUB_PROXY_MODE", warn),
    cacheMode: pickOne(env.GITHUB_CACHE, ["disk", "memory", "off"], "disk", "GITHUB_CACHE", warn),
    cacheDir: optional(env.GITHUB_CACHE_DIR),
    logLevel: pickOne(env.GITHUB_MCP_LOG, ["error", "info", "debug"], "error", "GITHUB_MCP_LOG", warn),
    timeoutMs: pickInteger(env.GITHUB_MCP_TIMEOUT_MS, 30000, 1, "GITHUB_MCP_TIMEOUT_MS", warn),
    maxFileBytes: pickInteger(env.GITHUB_MCP_MAX_FILE_BYTES, 262144, 1, "GITHUB_MCP_MAX_FILE_BYTES", warn),
  };
}
