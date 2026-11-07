import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/core/context.js";
import { GithubError } from "../../src/core/errors.js";
import { runCli } from "../../src/cli/run.js";
import { makeConfig } from "../helpers.js";

function capture() {
  const chunks: string[] = [];
  return {
    //? fake stream only implements write; WritableStream's remaining surface is unused here
    stdout: { write: (chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; } } as NodeJS.WritableStream,
    text: () => chunks.join(""),
  };
}

const happyClient = {
  api: vi.fn(async () => ({
    data: {
      full_name: "o/r", description: null, private: false, html_url: "https://github.com/o/r",
      default_branch: "main", stargazers_count: 1, forks_count: 1, open_issues_count: 0,
      has_issues: true, has_discussions: true, language: null, license: null, topics: [],
      archived: false, pushed_at: null, created_at: "2026-01-01T00:00:00Z",
    },
    headers: new Headers(),
    status: 200,
    contentType: "application/json",
  })),
  apiRaw: vi.fn(),
  raw: vi.fn(),
};
//? happyClient lacks concrete GitHubApi internals; the cast keeps the offline mock shape
const ctx: ToolContext = {
  client: happyClient as unknown as ToolContext["client"],
  config: makeConfig(),
  authFingerprint: "abc",
};

describe("runCli", () => {
  it("prints the tool result as compact JSON and exits 0", async () => {
    const out = capture();
    const err = capture();
    const code = await runCli(["repo", "o/r"], {
      createRuntime: async () => ctx,
      stdout: out.stdout,
      stderr: err.stdout,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.text())).toMatchObject({ full_name: "o/r" });
  });

  it("maps GithubError codes to family exit codes on stderr", async () => {
    const out = capture();
    const err = capture();
    const failing: ToolContext = {
      ...ctx,
      //? The client surfaces a 404 as GithubError("not_found"); the mock throws that real
      //? subclass because the catch maps by instanceof, so a plain Error wearing a code
      //? property would fall through to the network fallback instead of exit 5.
      client: {
        api: vi.fn(async () => { throw new GithubError("not_found", "Not Found"); }),
        apiRaw: vi.fn(),
        raw: vi.fn(),
      } as unknown as ToolContext["client"],
    };
    const code = await runCli(["repo", "o/r"], {
      createRuntime: async () => failing,
      stdout: out.stdout,
      stderr: err.stdout,
    });
    expect(code).toBe(5);
    expect(JSON.parse(err.text())).toEqual({ error: { code: "not_found", message: "Not Found" } });
    expect(out.text()).toBe("");
  });

  it("exits 2 on usage errors and 4 on auth failures", async () => {
    const out = capture();
    const err = capture();
    expect(await runCli(["repo"], { createRuntime: async () => ctx, stdout: out.stdout, stderr: err.stdout })).toBe(2);
    const authFail: ToolContext = {
      ...ctx,
      //? The client surfaces a 401 as GithubError("auth_failed"); the mock throws that
      //? real subclass because the catch maps by instanceof, so a plain Error wearing a
      //? code property would fall through to the network fallback instead of exit 4.
      client: {
        api: vi.fn(async () => { throw new GithubError("auth_failed", "Bad credentials"); }),
        apiRaw: vi.fn(),
        raw: vi.fn(),
      } as unknown as ToolContext["client"],
    };
    expect(await runCli(["rate"], { createRuntime: async () => authFail, stdout: out.stdout, stderr: err.stdout })).toBe(4);
  });

  it("validates input against the tool schema and reports invalid_params", async () => {
    const out = capture();
    const err = capture();
    const code = await runCli(["issues", "o/r", "--page", "0"], {
      createRuntime: async () => ctx,
      stdout: out.stdout,
      stderr: err.stdout,
    });
    expect(code).toBe(2);
    expect(JSON.parse(err.text()).error.code).toBe("invalid_params");
  });

  it("resolves the latest release when the optional tag positional is omitted", async () => {
    const out = capture();
    const err = capture();
    const releaseCtx: ToolContext = {
      ...ctx,
      client: {
        api: vi.fn(async () => ({
          data: {
            tag_name: "v1.2.3", name: "v1.2.3", body: "notes", prerelease: false, draft: false,
            published_at: "2026-01-02T00:00:00Z", html_url: "https://github.com/o/r/releases/v1.2.3",
            assets: [],
          },
          headers: new Headers(),
          status: 200,
          contentType: "application/json",
        })),
        apiRaw: vi.fn(),
        raw: vi.fn(),
      } as unknown as ToolContext["client"],
    };
    const code = await runCli(["release", "o/r"], {
      createRuntime: async () => releaseCtx,
      stdout: out.stdout,
      stderr: err.stdout,
    });
    expect(code).toBe(0);
    expect(releaseCtx.client.api).toHaveBeenCalledWith("/repos/o/r/releases/latest", { fresh: undefined, cacheTtlMs: 600000 });
    expect(JSON.parse(out.text())).toMatchObject({ found: true, tag_name: "v1.2.3" });
  });

  it("converts --query key=value pairs into the record github_api_get expects", async () => {
    const out = capture();
    const err = capture();
    const apiCtx: ToolContext = {
      ...ctx,
      client: {
        api: vi.fn(),
        apiRaw: vi.fn(async () => ({
          bytes: new TextEncoder().encode(JSON.stringify({ ok: true })),
          headers: new Headers({ "content-type": "application/json" }),
          status: 200,
          contentType: "application/json",
        })),
        raw: vi.fn(),
      } as unknown as ToolContext["client"],
    };
    const code = await runCli(["api", "/repos/o/r/readme", "--query", "ref=main,per_page=1"], {
      createRuntime: async () => apiCtx,
      stdout: out.stdout,
      stderr: err.stdout,
    });
    expect(code).toBe(0);
    expect(apiCtx.client.apiRaw).toHaveBeenCalledWith("/repos/o/r/readme?ref=main&per_page=1", { fresh: undefined });
    expect(JSON.parse(out.text())).toMatchObject({ status: 200, body: { ok: true } });
  });
});
