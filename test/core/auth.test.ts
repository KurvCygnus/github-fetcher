import { describe, expect, it, vi } from "vitest";
import { createTokenResolver, parseCredential, tokenFingerprint } from "../../src/core/auth.js";
import { makeConfig } from "../helpers.js";

describe("parseCredential", () => {
  it("extracts the password", () => {
    const stdout = "protocol=https\nhost=github.com\nusername=alice\npassword=secret\n\n";
    expect(parseCredential(stdout)).toBe("secret");
  });

  it("returns null when the password is empty", () => {
    expect(parseCredential("protocol=https\npassword=\n\n")).toBeNull();
  });
});

describe("createTokenResolver", () => {
  it("prefers GITHUB_TOKEN over GH_TOKEN and git", async () => {
    const execFile = vi.fn();
    const resolver = createTokenResolver(
      makeConfig({ githubToken: "env-token", ghToken: "gh-token" }),
      execFile,
    );
    await expect(resolver.get()).resolves.toBe("env-token");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("falls back to git credential fill", async () => {
    const execFile = vi.fn(async () => ({
      stdout: "protocol=https\nhost=github.com\npassword=git-token\n\n",
      stderr: "",
    }));
    const resolver = createTokenResolver(makeConfig(), execFile);
    await expect(resolver.get()).resolves.toBe("git-token");
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["credential", "fill"],
      expect.objectContaining({ timeout: 5000, input: "protocol=https\nhost=github.com\n\n" }),
    );
  });

  it("uses anonymous mode when git fails", async () => {
    const warn = vi.fn();
    const execFile = vi.fn(async () => {
      throw new Error("not logged in");
    });
    const resolver = createTokenResolver(makeConfig(), execFile, warn);
    await expect(resolver.get()).resolves.toBeNull();
    await expect(resolver.get()).resolves.toBeNull();
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("re-resolves after refresh", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "password=first\n\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "password=second\n\n", stderr: "" });
    const resolver = createTokenResolver(makeConfig(), execFile);
    await expect(resolver.get()).resolves.toBe("first");
    await expect(resolver.refresh()).resolves.toBe("second");
    await expect(resolver.get()).resolves.toBe("second");
  });
});

describe("tokenFingerprint", () => {
  it("uses a stable prefix and hides the token", () => {
    const first = tokenFingerprint("secret");
    expect(first).toHaveLength(16);
    expect(first).toBe(tokenFingerprint("secret"));
    expect(first).not.toBe(tokenFingerprint("other"));
    expect(first).not.toContain("secret");
  });

  it("marks anonymous mode", () => {
    expect(tokenFingerprint(null)).toBe("anonymous");
  });
});
