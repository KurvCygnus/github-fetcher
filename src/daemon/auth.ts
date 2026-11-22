import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
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
  //* the exact "Bearer <token>" string with no trailing newline.
  await writeFile(path, BEARER_PREFIX + token, { mode: 0o600 });
  //* writeFile's mode only applies at creation, so a pre-existing token file could
  //* stay world-readable. chmod tightens it; Windows ignores the read/write bits
  //* and can reject the call, which is non-fatal under the profile's ACLs.
  try {
    await chmod(path, 0o600);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

export async function removeDaemonToken(path: string): Promise<void> {
  await unlink(path);
}
