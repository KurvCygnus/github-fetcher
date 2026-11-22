import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const BEARER_PREFIX = "Bearer ";

export function newBearerToken(): string {
  return randomBytes(32).toString("base64url");
}

export function authorizeBearer(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const expected = BEARER_PREFIX + token;
  const actualBytes = Buffer.from(header);
  const expectedBytes = Buffer.from(expected);
  //* Compare only equal-length buffers; timingSafeEqual throws on a length mismatch.
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

export async function writeDaemonToken(path: string, token: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  //* {file:...} substitution uses the whole file as the header value, so write
  //* the exact "Bearer <token>" string with no trailing newline. The mode is
  //* ignored on Windows, which is non-fatal under the profile's ACLs.
  await writeFile(path, BEARER_PREFIX + token, { mode: 0o600 });
}

export async function removeDaemonToken(path: string): Promise<void> {
  await unlink(path);
}
