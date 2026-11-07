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
  if (Buffer.byteLength(text, "utf8") <= max) return { text, truncated: false };
  return { text: clipToByteBudget(text, max), truncated: true };
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
