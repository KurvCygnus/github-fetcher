import { cacheKey, readCachedTree } from "../core/cache.js";
import type { CacheStore } from "../core/cache.js";
import { GithubError } from "../core/errors.js";

//? noUncheckedIndexedAccess makes exec() capture groups string | undefined;
//? both groups are checked in one guard instead of asserting non-null.
export function parseRepo(repo: string): { owner: string; name: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo);
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new GithubError("invalid_params", "repo must be owner/name");
  }
  return { owner: match[1], name: match[2] };
}

export function encodePath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "";
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new GithubError("invalid_params", "path must not contain empty, . or .. segments");
  }
  return segments.map(encodeURIComponent).join("/");
}

export function githubQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

const HINT_SIBLING_LIMIT = 8;

//? Inputs for the 404 hint builder; path is the raw (pre-encode) tool input and
//* is undefined exactly when the failing request addressed the ref itself.
export interface NotFoundHintParams {
  cache: CacheStore | undefined;
  authFingerprint: string;
  owner: string;
  name: string;
  ref: string;
  path: string | undefined;
}

function treeCacheUrl(owner: string, name: string, treeish: string): string {
  return `https://api.github.com/repos/${owner}/${name}/git/trees/${treeish}`;
}

//? Direct children of dir from a stored listing. A path-scoped listing may
//* report paths relative to the directory or from the repo root, so a matching
//* prefix is stripped before the single-segment check; entries deeper than one
//* level never qualify.
function directChildren(paths: string[], dir: string | undefined): string[] {
  const prefix = dir === undefined ? "" : `${dir}/`;
  const names: string[] = [];
  for (const path of paths) {
    const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path;
    if (!relative.includes("/")) names.push(relative);
  }
  return names;
}

//? Builds the path-miss hint from cached listings only. A nested path first
//* tries the parent directory's own listing (the same URL the tree tool caches
//* for that dir), falling back to the ref's root listing labeled "repo root".
//* Null means no usable cache entry existed and the error stays undecorated.
async function buildPathHint(
  cache: CacheStore,
  authFingerprint: string,
  owner: string,
  name: string,
  ref: string,
  path: string,
): Promise<string | null> {
  const separator = path.lastIndexOf("/");
  const dir = separator === -1 ? undefined : path.slice(0, separator);
  let names: string[] | null = null;
  let label = "repo root";
  if (dir !== undefined) {
    const parentUrl = treeCacheUrl(owner, name, `${encodeURIComponent(ref)}:${encodePath(dir)}`);
    const parent = await readCachedTree(cache, cacheKey(parentUrl, authFingerprint));
    if (parent !== null) {
      const children = directChildren(parent, dir);
      if (children.length > 0) {
        names = children;
        label = dir;
      }
    }
  }
  if (names === null) {
    const rootUrl = treeCacheUrl(owner, name, encodeURIComponent(ref));
    const root = await readCachedTree(cache, cacheKey(rootUrl, authFingerprint));
    if (root === null) return null;
    names = directChildren(root, undefined);
  }
  return `path "${path}" not found at ref ${ref}; entries in ${label}: ${names.slice(0, HINT_SIBLING_LIMIT).join(", ")}`;
}

//? 404 recovery for github_file and github_tree: decorate a not_found error
//* with a hint built from the LOCAL cache only, so no upstream call can be
//* triggered here. A ref-level miss (path undefined) carries the branch/tag
//* advice without any cache read; a path miss lists cached sibling names.
//* Everything else — other codes, other error types, absent cache, cache miss,
//* even a hint-building failure — returns the original error object untouched.
export async function notFoundWithHint(error: unknown, params: NotFoundHintParams): Promise<unknown> {
  if (!(error instanceof GithubError) || error.code !== "not_found") return error;
  const { cache, authFingerprint, owner, name, ref, path } = params;
  if (path === undefined) {
    return new GithubError(error.code, error.message, {
      ...error.details,
      hint: `ref ${ref} not found; check the branch or tag name`,
    });
  }
  if (cache === undefined) return error;
  let hint: string | null;
  try {
    hint = await buildPathHint(cache, authFingerprint, owner, name, ref, path);
  } catch {
    return error;
  }
  if (hint === null) return error;
  return new GithubError(error.code, error.message, { ...error.details, hint });
}

export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= max) return { text, truncated: false };
  return { text: clipToByteBudget(text, max), truncated: true };
}

//? decode() with fatal: true throws on invalid UTF-8; returning null instead
//? lets each caller word its own unsupported error (file vs readme wording).
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

//* GITHUB_MCP_MAX_FILE_BYTES and the per-call budgets promise bytes; the clip
//* walks back over UTF-8 continuation bytes so a code point is never split.
function clipToByteBudget(text: string, max: number): string {
  const clipped = Buffer.from(text, "utf8").subarray(0, max);
  let end = clipped.length;
  //? A budget can land exactly on a lead byte as well as inside a sequence, so
  //? any non-ASCII final byte starts the walk-back: the loop stops on the lead
  //? of the final sequence and the expected-length check trims an incomplete
  //? tail. Buffer.from always emits valid UTF-8, so that lead is always found.
  if (end > 0 && (clipped[end - 1] as number) >= 0x80) {
    let start = end - 1;
    while (start > 0 && isContinuation(clipped[start] as number)) start -= 1;
    const lead = clipped[start] as number;
    const expected = (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : 4;
    if (end - start < expected) end = start;
  }
  return clipped.subarray(0, end).toString("utf8");
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}
