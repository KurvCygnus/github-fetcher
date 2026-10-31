import { ProxyAgent, type Dispatcher } from "undici";
import type { TokenResolver } from "./auth.js";
import type { Config } from "./config.js";
import { GithubError, mapHttpError } from "./errors.js";
import type { ProxyResolution } from "./proxy.js";
import { VERSION } from "./version.js";

export type Route = "direct" | "proxy";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit & { dispatcher?: Dispatcher },
) => Promise<Response>;

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
  url: string;
}

export interface HttpGetOptions {
  accept?: string;
  headers?: Record<string, string>;
}

export interface HttpClientOptions {
  config: Config;
  auth: TokenResolver;
  proxy: ProxyResolution;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function routeOrder(
  host: string,
  proxyMode: Config["proxyMode"],
  hasProxy: boolean,
): Route[] {
  if (!hasProxy || proxyMode === "direct") return ["direct"];
  if (proxyMode === "always") return ["proxy", "direct"];
  return host === "raw.githubusercontent.com" ? ["proxy", "direct"] : ["direct", "proxy"];
}

export function retryDelayMs(headers: Headers, nowMs: number): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  }
  //! Number(null) === 0, so a missing x-ratelimit-reset must be distinguished
  //! from a reset of 0 before calling Number(); otherwise "no hint" masquerades
  //! as a zero delay instead of null.
  const resetRaw = headers.get("x-ratelimit-reset")?.trim();
  if (resetRaw !== undefined && resetRaw !== "") {
    const reset = Number(resetRaw);
    if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - nowMs);
  }
  return null;
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HttpClient {
  private agent: ProxyAgent | null = null;

  constructor(private readonly options: HttpClientOptions) {}

  async get(url: string, options: HttpGetOptions = {}): Promise<HttpResponse> {
    let token = await this.options.auth.get();
    let refreshed = false;
    let waited = false;

    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await this.request(url, options, token);
      const response = result.response;

      if (response.status === 401 && token && !refreshed) {
        refreshed = true;
        token = await this.options.auth.refresh();
        continue;
      }

      if (response.status === 403 || response.status === 429) {
        const delay = retryDelayMs(response.headers, this.options.now?.() ?? Date.now());
        if (!waited && delay !== null && delay <= 15000) {
          waited = true;
          await (this.options.sleep ?? sleepDefault)(delay);
          continue;
        }
        throw mapHttpError(response.status, await response.text(), response.headers);
      }

      if (response.status >= 400) {
        throw mapHttpError(response.status, await response.text(), response.headers);
      }

      return {
        status: response.status,
        headers: response.headers,
        body: new Uint8Array(await response.arrayBuffer()),
        url: result.url,
      };
    }

    throw new GithubError("network", "Too many authentication or rate-limit retries");
  }

  private async request(url: string, options: HttpGetOptions, token: string | null) {
    const host = new URL(url).host;
    const routes = routeOrder(host, this.options.config.proxyMode, this.options.proxy.url !== null);
    let lastError: unknown;

    for (const route of routes) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await this.follow(url, route, options, token);
        } catch (error) {
          lastError = error;
          if (attempt === 0) await (this.options.sleep ?? sleepDefault)(250);
        }
      }
    }

    throw lastError instanceof GithubError
      ? lastError
      : new GithubError("network", lastError instanceof Error ? lastError.message : String(lastError));
  }

  private async follow(url: string, route: Route, options: HttpGetOptions, token: string | null) {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      const response = await this.fetchOnce(current, route, options, token);
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current };
      const location = response.headers.get("location");
      if (!location) throw new GithubError("network", "Redirect without a Location header");
      const next = new URL(location, current);
      if (next.origin !== new URL(current).origin) {
        throw new GithubError("network", `Refusing redirect outside GitHub: ${next.origin}`);
      }
      current = next.href;
    }
    throw new GithubError("network", "Too many redirects");
  }

  private async fetchOnce(
    url: string,
    route: Route,
    options: HttpGetOptions,
    token: string | null,
  ): Promise<Response> {
    const headers = new Headers({
      "user-agent": `github-fetcher/${VERSION}`,
      accept: options.accept ?? "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    });
    if (token) headers.set("authorization", `Bearer ${token}`);
    for (const [key, value] of Object.entries(options.headers ?? {})) headers.set(key, value);

    const fetchImpl: FetchLike = this.options.fetchImpl ?? fetch;
    //* @types/node pins undici-types ~8.9 while the undici package is 8.12; the two Dispatcher
    //* copies are not mutually assignable (compose overload variance), so the ProxyAgent can
    //* only reach RequestInit's dispatcher slot through a cast to the exact target prop type.
    return fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(this.options.config.timeoutMs),
      ...(route === "proxy"
        ? {
            dispatcher: this.getAgent() as unknown as Dispatcher & NonNullable<RequestInit["dispatcher"]>,
          }
        : {}),
    });
  }

  private getAgent(): ProxyAgent {
    if (!this.options.proxy.url) throw new GithubError("network", "Proxy route without a proxy URL");
    this.agent ??= new ProxyAgent(this.options.proxy.url);
    return this.agent;
  }
}
