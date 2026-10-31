import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Config } from "./config.js";

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { input?: string; timeout: number; windowsHide?: boolean },
) => Promise<{ stdout: string; stderr: string }>;

export const defaultExecFile: ExecFileFn = (file, args, options) =>
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

export interface TokenResolver {
  get(): Promise<string | null>;
  refresh(): Promise<string | null>;
}

export function parseCredential(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith("password=")) {
      const value = line.slice("password=".length).trim();
      return value === "" ? null : value;
    }
  }
  return null;
}

export function createTokenResolver(
  config: Config,
  execFile: ExecFileFn = defaultExecFile,
  warn: (message: string) => void = () => {},
): TokenResolver {
  let cached: string | null | undefined;

  async function resolve(): Promise<string | null> {
    const envToken = config.githubToken ?? config.ghToken;
    if (envToken) return envToken;
    try {
      const { stdout } = await execFile("git", ["credential", "fill"], {
        input: "protocol=https\nhost=github.com\n\n",
        timeout: 5000,
        windowsHide: true,
      });
      return parseCredential(stdout);
    } catch (error) {
      warn(`git credential fill failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  return {
    async get() {
      if (cached === undefined) cached = await resolve();
      return cached;
    },
    async refresh() {
      cached = await resolve();
      return cached;
    },
  };
}

export function tokenFingerprint(token: string | null): string {
  if (!token) return "anonymous";
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}
