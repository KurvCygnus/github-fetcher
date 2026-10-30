export type ErrorCode =
  | "auth_missing"
  | "auth_failed"
  | "rate_limited"
  | "not_found"
  | "network"
  | "upstream"
  | "invalid_params"
  | "unsupported";

export class GithubError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "GithubError";
    this.code = code;
    this.details = details;
  }

  toResult(): { error: { code: ErrorCode; message: string } & Record<string, unknown> } {
    return { error: { code: this.code, message: this.message, ...this.details } };
  }
}

//! Number(null) === 0, so raw header text must be inspected before calling Number();
//! otherwise a missing header masquerades as a zero count instead of unknown.
function numericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name)?.trim();
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resetAtFromHeader(headers: Headers): string | null {
  const raw = headers.get("x-ratelimit-reset")?.trim();
  if (raw === undefined || raw === "") return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function rateLimitDetails(headers: Headers): Record<string, unknown> {
  return {
    resource: "core",
    limit: numericHeader(headers, "x-ratelimit-limit"),
    remaining: numericHeader(headers, "x-ratelimit-remaining"),
    reset_at: resetAtFromHeader(headers),
  };
}

export function mapHttpError(
  status: number,
  message: string,
  headers?: Headers,
): GithubError {
  if (status === 401) return new GithubError("auth_failed", message, { status });
  if (status === 404) return new GithubError("not_found", message, { status });
  if (status === 422) return new GithubError("invalid_params", message, { status });

  if ((status === 403 || status === 429) && headers) {
    const remaining = numericHeader(headers, "x-ratelimit-remaining");
    const retryAfter = headers.get("retry-after");
    if (remaining === 0 || retryAfter !== null) {
      return new GithubError("rate_limited", message, rateLimitDetails(headers));
    }
  }

  return new GithubError("upstream", message, { status });
}

export function toGithubError(error: unknown): GithubError {
  if (error instanceof GithubError) return error;
  if (error instanceof Error) return new GithubError("network", error.message);
  return new GithubError("network", String(error));
}
