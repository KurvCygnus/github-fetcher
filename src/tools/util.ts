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

export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}
