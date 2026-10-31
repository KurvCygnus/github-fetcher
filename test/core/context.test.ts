import { describe, expect, it, vi } from "vitest";
import { createToolContext } from "../../src/core/context.js";

describe("createToolContext", () => {
  it("wires an offline context from env without spawning git", async () => {
    const warn = vi.fn();
    const ctx = await createToolContext(
      {
        GITHUB_TOKEN: "env-token",
        GITHUB_PROXY_MODE: "direct",
        GITHUB_CACHE: "off",
      },
      warn,
    );
    expect(ctx.config.githubToken).toBe("env-token");
    expect(ctx.config.proxyMode).toBe("direct");
    expect(ctx.authFingerprint).toHaveLength(16);
    expect(ctx.authFingerprint).not.toContain("env-token");
    expect(warn).not.toHaveBeenCalled();
  });
});
