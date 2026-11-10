import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../../src/core/context.js";
import { GithubError } from "../../src/core/errors.js";
import { reposBatchTool } from "../../src/tools/repos-batch.js";
import { makeConfig } from "../helpers.js";

//? Field names are the raw REST /repos names so the fixture catches any drift
//? back to output-shaped keys; the assertions pin the mapped projection.
function repoPayload(fullName: string) {
  return {
    full_name: fullName,
    description: "demo repo",
    private: false,
    visibility: "public",
    fork: false,
    stargazers_count: 42,
    forks_count: 7,
    language: "TypeScript",
    pushed_at: "2026-11-01T00:00:00Z",
    default_branch: "main",
  };
}

function clientFor(repos: Record<string, unknown>) {
  return {
    api: vi.fn(async (url: string) => {
      const match = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url);
      if (match) {
        const key = `${match[1]}/${match[2]}`;
        if (!(key in repos)) throw new GithubError("not_found", "Not Found");
        return {
          data: repos[key],
          headers: new Headers(),
          status: 200,
          contentType: "application/json",
        };
      }
      throw new Error(`unexpected url ${url}`);
    }),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  };
}

function ctxFor(client: ReturnType<typeof clientFor>): ToolContext {
  return { client: client as unknown as ToolContext["client"], config: makeConfig(), authFingerprint: "abc" };
}

describe("github_repos", () => {
  it("projects ok entries exactly and reports 404s per item without rejecting", async () => {
    const client = clientFor({ "o/a": repoPayload("o/a"), "o/b": repoPayload("o/b") });
    const output = await reposBatchTool.handler(
      { repos: ["o/a", "o/missing", "o/b"] },
      ctxFor(client),
    );
    const items = output.results as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    //? Projection equality: the data object carries exactly the spec'd keys,
    //? mapped from the raw REST names (stargazers_count -> stars etc.).
    expect(items[0]).toEqual({
      repo: "o/a",
      ok: true,
      data: {
        full_name: "o/a",
        description: "demo repo",
        private: false,
        visibility: "public",
        fork: false,
        stars: 42,
        forks: 7,
        language: "TypeScript",
        pushed_at: "2026-11-01T00:00:00Z",
        default_branch: "main",
      },
    });
    expect(items[1]).toEqual({
      repo: "o/missing",
      ok: false,
      error: { code: "not_found", message: "Not Found" },
    });
    expect(items[2]).toEqual({
      repo: "o/b",
      ok: true,
      data: expect.objectContaining({ full_name: "o/b", stars: 42 }),
    });
    expect(output.elapsed_ms).toEqual(expect.any(Number));
  });

  it("keeps a private repo's visibility fallback and fork flag in the projection", async () => {
    const client = clientFor({
      "o/priv": {
        full_name: "o/priv",
        description: null,
        private: true,
        fork: true,
        stargazers_count: 0,
        forks_count: 1,
        language: null,
        pushed_at: "2026-11-02T00:00:00Z",
        default_branch: "trunk",
      },
    });
    const output = await reposBatchTool.handler({ repos: ["o/priv"] }, ctxFor(client));
    const items = output.results as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({
      repo: "o/priv",
      ok: true,
      data: {
        full_name: "o/priv",
        description: null,
        private: true,
        visibility: "private",
        fork: true,
        stars: 0,
        forks: 1,
        language: null,
        pushed_at: "2026-11-02T00:00:00Z",
        default_branch: "trunk",
      },
    });
  });

  it("handles a single-repo batch", async () => {
    const client = clientFor({ "o/solo": repoPayload("o/solo") });
    const output = await reposBatchTool.handler({ repos: ["o/solo"] }, ctxFor(client));
    const items = output.results as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: "o/solo", ok: true });
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(client.api).toHaveBeenCalledWith("/repos/o/solo", {
      fresh: undefined,
      cacheTtlMs: 600_000,
    });
  });

  it("fires every request concurrently and forwards fresh", async () => {
    const client = clientFor({
      "o/a": repoPayload("o/a"),
      "o/b": repoPayload("o/b"),
      "o/c": repoPayload("o/c"),
    });
    //? No await before this assertion: the handler must start all three calls
    //? synchronously instead of walking the list one repo at a time.
    const promise = reposBatchTool.handler(
      { repos: ["o/a", "o/b", "o/c"], fresh: true },
      ctxFor(client),
    );
    expect(client.api).toHaveBeenCalledTimes(3);
    expect(client.api).toHaveBeenCalledWith("/repos/o/a", { fresh: true, cacheTtlMs: 600_000 });
    await promise;
  });

  it("turns a malformed entry into a per-item invalid_params error", async () => {
    const client = clientFor({});
    const output = await reposBatchTool.handler(
      { repos: ["no-slash"] },
      ctxFor(client),
    );
    const items = output.results as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({
      repo: "no-slash",
      ok: false,
      error: { code: "invalid_params", message: "repo must be owner/name" },
    });
    expect(client.api).not.toHaveBeenCalled();
  });
});
