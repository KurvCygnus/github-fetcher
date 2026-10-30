import { describe, expect, it, vi } from "vitest";
import { resolveProxy, validateProxyUrl } from "../src/proxy.js";
import { makeConfig } from "./helpers.js";

const noGit = vi.fn(async () => {
  throw new Error("no git config");
});

describe("validateProxyUrl", () => {
  it("accepts http and https proxies", () => {
    expect(validateProxyUrl("http://127.0.0.1:12334")).toBe("http://127.0.0.1:12334");
    expect(validateProxyUrl("https://proxy.example:8443")).toBe("https://proxy.example:8443");
  });

  it("rejects other schemes and malformed values", () => {
    expect(validateProxyUrl("socks5://127.0.0.1:1080")).toBeNull();
    expect(validateProxyUrl("not a url")).toBeNull();
  });
});

describe("resolveProxy", () => {
  it("prefers GITHUB_PROXY", async () => {
    const result = await resolveProxy(
      makeConfig({
        githubProxy: "http://127.0.0.1:12334",
        httpsProxy: "http://127.0.0.1:7890",
      }),
      noGit,
    );
    expect(result).toEqual({ url: "http://127.0.0.1:12334", source: "GITHUB_PROXY" });
  });

  it("falls back to HTTPS_PROXY and HTTP_PROXY", async () => {
    await expect(
      resolveProxy(makeConfig({ httpsProxy: "http://127.0.0.1:7890" }), noGit),
    ).resolves.toEqual({ url: "http://127.0.0.1:7890", source: "HTTPS_PROXY" });
    await expect(
      resolveProxy(makeConfig({ httpProxy: "http://127.0.0.1:8080" }), noGit),
    ).resolves.toEqual({ url: "http://127.0.0.1:8080", source: "HTTP_PROXY" });
  });

  it("ignores invalid explicit values and continues", async () => {
    const warn = vi.fn();
    const result = await resolveProxy(
      makeConfig({ githubProxy: "socks5://127.0.0.1:1080", httpsProxy: "http://127.0.0.1:7890" }),
      noGit,
      warn,
    );
    expect(result).toEqual({ url: "http://127.0.0.1:7890", source: "HTTPS_PROXY" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid proxy"));
  });

  it("reads git config as the last fallback", async () => {
    const execFile = vi.fn(async () => ({ stdout: "http://127.0.0.1:12334\n", stderr: "" }));
    const result = await resolveProxy(makeConfig(), execFile);
    expect(result).toEqual({ url: "http://127.0.0.1:12334", source: "git" });
    expect(execFile).toHaveBeenCalledWith(
      "git",
      ["config", "--get", "http.https://github.com.proxy"],
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it("returns none when everything fails", async () => {
    await expect(resolveProxy(makeConfig(), noGit)).resolves.toEqual({ url: null, source: "none" });
  });

  it("skips all discovery in direct mode", async () => {
    const execFile = vi.fn();
    await expect(
      resolveProxy(makeConfig({ proxyMode: "direct", githubProxy: "http://127.0.0.1:12334" }), execFile),
    ).resolves.toEqual({ url: null, source: "none" });
    expect(execFile).not.toHaveBeenCalled();
  });
});
