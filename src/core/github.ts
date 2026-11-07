import type { CacheStore } from "./cache.js";
import { cacheKey } from "./cache.js";
import type { Config } from "./config.js";
import { GithubError } from "./errors.js";
import type { HttpClient } from "./http.js";

//? Optional props spell out "undefined" (same pattern as Config) so handlers can
//? pass schema-optional values like `fresh: input.fresh` under exactOptionalPropertyTypes.
export interface ApiOptions {
  fresh?: boolean | undefined;
  cacheTtlMs?: number | undefined;
  accept?: string | undefined;
  headers?: Record<string, string> | undefined;
}

export interface CacheOutcome {
  state: "hit" | "revalidated" | "miss";
  ageSeconds?: number | undefined;
}

const encoder = new TextEncoder();

function isCacheableContentType(contentType: string): boolean {
  return contentType.includes("json") || contentType.startsWith("text/");
}

export interface ApiResult<T> {
  data: T;
  headers: Headers;
  status: number;
  contentType: string;
  cache?: CacheOutcome | undefined;
}

export interface RawApiResult {
  bytes: Uint8Array;
  headers: Headers;
  status: number;
  contentType: string;
  cache?: CacheOutcome | undefined;
}

export interface GitHubApi {
  api<T>(path: string, options?: ApiOptions): Promise<ApiResult<T>>;
  apiRaw(path: string, options?: { fresh?: boolean | undefined; cacheTtlMs?: number | undefined }): Promise<RawApiResult>;
  raw(url: string): Promise<Uint8Array>;
}

export interface GithubClientOptions {
  http: HttpClient;
  cache: CacheStore;
  config: Config;
  authFingerprint: string;
  now?: () => number;
}

const DEFAULT_TTL_MS = 120_000;

//* The path part before the first ? carries traversal semantics; the query part
//* does not, so .. is legitimate there (range searches like stars:10..20). A raw
//* # is rejected on the whole string: fetch treats it as a fragment and would
//! silently truncate the request, so encoded %23 is the only way through.
function validateApiPath(path: string): void {
  if (path.includes("#")) {
    throw new GithubError("invalid_params", "path must be URL-encoded; a raw # starts a fragment and would truncate the request");
  }
  const separator = path.indexOf("?");
  const pathPart = separator === -1 ? path : path.slice(0, separator);
  if (!pathPart.startsWith("/") || pathPart.startsWith("//") || pathPart.includes("..")) {
    throw new GithubError("invalid_params", "path must be an absolute API path without .. or //");
  }
  if (separator !== -1 && path.slice(separator + 1).includes("?")) {
    throw new GithubError("invalid_params", "path must contain at most one query string separator (?)");
  }
}

export class GithubClient implements GitHubApi {
  private readonly now: () => number;

  constructor(private readonly options: GithubClientOptions) {
    this.now = options.now ?? Date.now;
  }

  async api<T>(path: string, options: ApiOptions = {}): Promise<ApiResult<T>> {
    const url = path.startsWith("https://") ? path : `https://api.github.com${path}`;
    //* Host guard: the trailing slash rejects lookalike hosts such as
    //* api.github.com.evil.com, so only api.github.com can be reached here.
    if (!url.startsWith("https://api.github.com/")) {
      throw new GithubError("unsupported", "API requests must target api.github.com");
    }
    const result = await this.fetchCached(url, options);
    try {
      return { ...result, data: JSON.parse(result.text) as T };
    } catch {
      throw new GithubError("upstream", `GitHub returned invalid JSON for ${url}`);
    }
  }

  async apiRaw(path: string, options: { fresh?: boolean | undefined; cacheTtlMs?: number | undefined } = {}): Promise<RawApiResult> {
    validateApiPath(path);
    const url = `https://api.github.com${path}`;
    const result = await this.fetchCached(url, {
      accept: "application/vnd.github+json",
      fresh: options.fresh,
      cacheTtlMs: options.cacheTtlMs,
    });
    return {
      bytes: result.bytes,
      headers: result.headers,
      status: result.status,
      contentType: result.contentType,
      cache: result.cache,
    };
  }

  async raw(url: string): Promise<Uint8Array> {
    //* Host guard: the trailing slash rejects lookalike hosts, so raw bytes can
    //* only come from raw.githubusercontent.com.
    if (!url.startsWith("https://raw.githubusercontent.com/")) {
      throw new GithubError("unsupported", "Raw requests must target raw.githubusercontent.com");
    }
    const response = await this.options.http.get(url, {
      accept: "application/octet-stream",
    });
    return response.body;
  }

  //? Explicit result type: an inferred return type widens the state literals to
  //? string, which breaks CacheOutcome assignability in api()/apiRaw() downstream.
  private async fetchCached(url: string, options: ApiOptions): Promise<{ text: string; bytes: Uint8Array; status: number; contentType: string; headers: Headers; cache: CacheOutcome }> {
    const ttl = options.cacheTtlMs ?? DEFAULT_TTL_MS;
    const key = cacheKey(url, this.options.authFingerprint);
    const cached = options.fresh || ttl === 0 ? null : await this.options.cache.get(key);

    if (cached && this.now() - cached.fetched_at < ttl) {
      return {
        text: cached.body,
        bytes: encoder.encode(cached.body),
        status: cached.status,
        contentType: cached.content_type,
        headers: new Headers(cached.link ? { link: cached.link } : {}),
        cache: { state: "hit", ageSeconds: Math.floor((this.now() - cached.fetched_at) / 1000) },
      };
    }

    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (cached?.etag && !options.fresh) headers["if-none-match"] = cached.etag;
    if (cached?.last_modified && !options.fresh) headers["if-modified-since"] = cached.last_modified;

    //? HttpGetOptions.accept rejects an explicit undefined under exactOptionalPropertyTypes;
    //? omitting it is behavior-identical because HttpClient defaults to the same accept header.
    const response = await this.options.http.get(url, {
      ...(options.accept !== undefined && { accept: options.accept }),
      headers,
    });

    if (response.status === 304 && cached) {
      //* Not modified: keep the stored body but slide fetched_at forward so the
      //* freshness window restarts without another full download.
      cached.fetched_at = this.now();
      await this.options.cache.set(key, cached);
      return {
        text: cached.body,
        bytes: encoder.encode(cached.body),
        status: cached.status,
        contentType: cached.content_type,
        headers: new Headers(cached.link ? { link: cached.link } : {}),
        cache: { state: "revalidated", ageSeconds: 0 },
      };
    }

    const text = new TextDecoder("utf-8").decode(response.body);
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const link = response.headers.get("link");
    if (ttl > 0 && response.status === 200 && isCacheableContentType(contentType)) {
      await this.options.cache.set(key, {
        version: 1,
        url,
        etag: response.headers.get("etag"),
        last_modified: response.headers.get("last-modified"),
        link,
        fetched_at: this.now(),
        status: response.status,
        content_type: contentType,
        body: text,
      });
      await this.options.cache.prune();
    }
    return {
      text,
      bytes: response.body,
      status: response.status,
      contentType,
      headers: response.headers,
      cache: { state: "miss" },
    };
  }
}
