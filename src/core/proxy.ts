import type { ExecFileFn } from "./auth.js";
import type { Config } from "./config.js";

export interface ProxyResolution {
  url: string | null;
  source: "GITHUB_PROXY" | "HTTPS_PROXY" | "HTTP_PROXY" | "git" | "none";
}

export function validateProxyUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export async function resolveProxy(
  config: Config,
  execFile: ExecFileFn,
  warn: (message: string) => void = () => {},
): Promise<ProxyResolution> {
  if (config.proxyMode === "direct") return { url: null, source: "none" };

  const candidates: Array<[ProxyResolution["source"], string | undefined]> = [
    ["GITHUB_PROXY", config.githubProxy],
    ["HTTPS_PROXY", config.httpsProxy],
    ["HTTP_PROXY", config.httpProxy],
  ];

  for (const [source, value] of candidates) {
    if (!value) continue;
    const valid = validateProxyUrl(value);
    if (valid) return { url: valid, source };
    warn(`Invalid proxy URL in ${source}: ${value}`);
  }

  try {
    const { stdout } = await execFile("git", ["config", "--get", "http.https://github.com.proxy"], {
      timeout: 5000,
      windowsHide: true,
    });
    const value = stdout.trim();
    const valid = value === "" ? null : validateProxyUrl(value);
    if (valid) return { url: valid, source: "git" };
    if (value !== "") warn(`Invalid proxy URL in git config: ${value}`);
  } catch {
    //* No git config entry is the normal case.
  }

  return { url: null, source: "none" };
}
