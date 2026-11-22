import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorizeBearer,
  newBearerToken,
  writeDaemonToken,
} from "../../src/daemon/auth.js";

describe("newBearerToken", () => {
  it("is non-empty and differs across calls", () => {
    const first = newBearerToken();
    const second = newBearerToken();
    expect(first.length).toBeGreaterThan(0);
    expect(first).not.toBe(second);
  });
});

describe("authorizeBearer", () => {
  it("accepts an exact Bearer header", () => {
    const token = newBearerToken();
    expect(authorizeBearer("Bearer " + token, token)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(authorizeBearer(undefined, "token")).toBe(false);
  });

  it("rejects a wrong scheme", () => {
    expect(authorizeBearer("Basic token", "token")).toBe(false);
  });

  it("rejects a wrong token", () => {
    expect(authorizeBearer("Bearer wrong", "right")).toBe(false);
  });
});

describe("writeDaemonToken", () => {
  it.skipIf(process.platform === "win32")(
    "tightens a pre-existing 0644 token file to 0600",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "ghf-token-mode-"));
      try {
        const path = join(dir, "token");
        await writeFile(path, "Bearer old", { mode: 0o644 });
        await chmod(path, 0o644);
        await writeDaemonToken(path, "abc123");
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(await readFile(path, "utf8")).toBe("Bearer abc123");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
