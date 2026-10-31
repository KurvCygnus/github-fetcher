import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/core/config.js";

describe("loadConfig", () => {
  it("returns documented defaults", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      proxyMode: "auto",
      cacheMode: "disk",
      logLevel: "error",
      timeoutMs: 30000,
      maxFileBytes: 262144,
    });
    expect(config.githubToken).toBeUndefined();
  });

  it("reads supported overrides", () => {
    const config = loadConfig({
      GITHUB_TOKEN: "tok",
      GH_TOKEN: "gh",
      GITHUB_PROXY: "http://127.0.0.1:12334",
      GITHUB_PROXY_MODE: "always",
      GITHUB_CACHE: "memory",
      GITHUB_CACHE_DIR: "C:\\cache",
      GITHUB_MCP_LOG: "debug",
      GITHUB_MCP_TIMEOUT_MS: "5000",
      GITHUB_MCP_MAX_FILE_BYTES: "1024",
    });
    expect(config.githubToken).toBe("tok");
    expect(config.ghToken).toBe("gh");
    expect(config.githubProxy).toBe("http://127.0.0.1:12334");
    expect(config.proxyMode).toBe("always");
    expect(config.cacheMode).toBe("memory");
    expect(config.cacheDir).toBe("C:\\cache");
    expect(config.logLevel).toBe("debug");
    expect(config.timeoutMs).toBe(5000);
    expect(config.maxFileBytes).toBe(1024);
  });

  it("falls back and warns on invalid values", () => {
    const warn = vi.fn();
    const config = loadConfig(
      {
        GITHUB_PROXY_MODE: "sometimes",
        GITHUB_CACHE: "redis",
        GITHUB_MCP_LOG: "trace",
        GITHUB_MCP_TIMEOUT_MS: "0",
        GITHUB_MCP_MAX_FILE_BYTES: "nope",
      },
      warn,
    );
    expect(config.proxyMode).toBe("auto");
    expect(config.cacheMode).toBe("disk");
    expect(config.logLevel).toBe("error");
    expect(config.timeoutMs).toBe(30000);
    expect(config.maxFileBytes).toBe(262144);
    expect(warn).toHaveBeenCalledTimes(5);
  });
});
