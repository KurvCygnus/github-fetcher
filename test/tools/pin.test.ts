import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { GithubError } from "../../src/core/errors.js";
import { clearPinnedRef, getPinnedRef, pinTool, setPinnedRef } from "../../src/tools/pin.js";
import { makeConfig } from "../helpers.js";

const REPO = "octocat/Hello-World";

//* A 40-hex input must skip the resolution network call entirely, so it has to
//* look like a real sha; the resolved sha below is what the mocked commits
//* endpoint answers with for branch pins.
const SHA_INPUT = "3f7d2b1c9e8a4f60b2d5c7a1e0f3b6c8d9a2e4f7";
const SHA_RESOLVED = "b7e5f1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8";

//? The pin map is module state that survives across tests in one worker, so a
//* leftover entry would leak into the next case; every test starts clean.
beforeEach(() => {
  clearPinnedRef(REPO);
  clearPinnedRef("o/r");
});

//? Routing mock: repo lookups answer a default branch and commit resolutions
//* are served from a table keyed by the requested ref; a ref missing from the
//* table 404s, so one mock drives branch pins, sha pins, and failures.
function clientForRoutes(commits: Record<string, string>): GitHubApi {
  return {
    api: vi.fn(async (path: string) => {
      if (path === `/repos/${REPO}`) {
        return {
          data: { default_branch: "main" },
          headers: new Headers(),
          status: 200,
          contentType: "application/json",
          cache: { state: "miss" },
        };
      }
      const prefix = `/repos/${REPO}/commits/`;
      if (path.startsWith(prefix)) {
        const requested = decodeURIComponent(path.slice(prefix.length).split("?")[0] ?? "");
        const sha = commits[requested];
        if (sha === undefined) throw new GithubError("not_found", "Not Found");
        return {
          data: [{ sha }],
          headers: new Headers(),
          status: 200,
          contentType: "application/json",
          cache: { state: "miss" },
        };
      }
      throw new Error(`unexpected path ${path}`);
    }),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

function ctxFor(client: GitHubApi) {
  return { client, config: makeConfig(), authFingerprint: "abc" };
}

describe("github_pin_ref", () => {
  it("pins an explicit branch by resolving it to the head commit sha", async () => {
    const client = clientForRoutes({ main: SHA_RESOLVED });
    const output = await pinTool.handler({ repo: REPO, ref: "main" }, ctxFor(client));
    expect(client.api).toHaveBeenCalledTimes(1);
    expect(client.api).toHaveBeenCalledWith(`/repos/${REPO}/commits/main?per_page=1`, {
      fresh: undefined,
      cacheTtlMs: 120_000,
    });
    expect(output).toEqual({
      repo: REPO,
      ref: "main",
      sha: SHA_RESOLVED,
      pinned: true,
      meta: { cache: "miss", calls: 1 },
    });
    expect(getPinnedRef(REPO)).toEqual({ ref: "main", sha: SHA_RESOLVED });
  });

  it("pins an explicit full sha without an upstream call", async () => {
    const client = clientForRoutes({});
    const output = await pinTool.handler({ repo: REPO, ref: SHA_INPUT }, ctxFor(client));
    expect(output).toEqual({ repo: REPO, ref: SHA_INPUT, sha: SHA_INPUT, pinned: true });
    expect(client.api).not.toHaveBeenCalled();
    expect(getPinnedRef(REPO)).toEqual({ ref: SHA_INPUT, sha: SHA_INPUT });
  });

  it("pins the default branch by resolving it to its head commit sha in two calls", async () => {
    const client = clientForRoutes({ main: SHA_RESOLVED });
    const output = await pinTool.handler({ repo: REPO }, ctxFor(client));
    expect(client.api).toHaveBeenCalledTimes(2);
    expect(client.api).toHaveBeenNthCalledWith(1, `/repos/${REPO}`, {
      fresh: undefined,
      cacheTtlMs: 600_000,
    });
    expect(client.api).toHaveBeenNthCalledWith(2, `/repos/${REPO}/commits/main?per_page=1`, {
      fresh: undefined,
      cacheTtlMs: 120_000,
    });
    expect(output).toEqual({
      repo: REPO,
      ref: "main",
      sha: SHA_RESOLVED,
      pinned: true,
      meta: { cache: "miss", calls: 2 },
    });
    expect(getPinnedRef(REPO)).toEqual({ ref: "main", sha: SHA_RESOLVED });
  });

  it("unpins and clears the stored pin", async () => {
    setPinnedRef(REPO, "main", "abc123def456");
    const client = clientForRoutes({});
    const output = await pinTool.handler({ repo: REPO, unpin: true }, ctxFor(client));
    expect(output).toEqual({ repo: REPO, pinned: false });
    expect(getPinnedRef(REPO)).toBeUndefined();
    expect(client.api).not.toHaveBeenCalled();
  });

  it("unpins even when a ref is also passed", async () => {
    setPinnedRef(REPO, "main", "abc123def456");
    await pinTool.handler({ repo: REPO, ref: "devel", unpin: true }, ctxFor(clientForRoutes({})));
    expect(getPinnedRef(REPO)).toBeUndefined();
  });

  it("unpinning a repository that was never pinned succeeds as a no-op", async () => {
    const output = await pinTool.handler({ repo: REPO, unpin: true }, ctxFor(clientForRoutes({})));
    expect(output).toEqual({ repo: REPO, pinned: false });
    expect(getPinnedRef(REPO)).toBeUndefined();
  });

  it("re-pinning overwrites the previous pin with the newly resolved sha", async () => {
    setPinnedRef(REPO, "v1", "sha-one");
    await pinTool.handler({ repo: REPO, ref: "v2" }, ctxFor(clientForRoutes({ v2: SHA_RESOLVED })));
    expect(getPinnedRef(REPO)).toEqual({ ref: "v2", sha: SHA_RESOLVED });
  });

  it("propagates not_found from the repo lookup and stores nothing", async () => {
    const client = {
      api: vi.fn(async () => {
        throw new GithubError("not_found", "Not Found");
      }),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    await expect(pinTool.handler({ repo: REPO }, ctxFor(client))).rejects.toMatchObject({
      code: "not_found",
    });
    expect(getPinnedRef(REPO)).toBeUndefined();
  });

  it("propagates not_found for an unresolvable branch and stores nothing", async () => {
    const client = clientForRoutes({});
    await expect(pinTool.handler({ repo: REPO, ref: "nope" }, ctxFor(client))).rejects.toMatchObject({
      code: "not_found",
    });
    expect(getPinnedRef(REPO)).toBeUndefined();
  });

  it("keeps pins per repository without cross-repo bleed", async () => {
    setPinnedRef("o/r", "main", "sha-o-r");
    await pinTool.handler({ repo: REPO, ref: "main" }, ctxFor(clientForRoutes({ main: SHA_RESOLVED })));
    expect(getPinnedRef("o/r")).toEqual({ ref: "main", sha: "sha-o-r" });
    expect(getPinnedRef(REPO)).toEqual({ ref: "main", sha: SHA_RESOLVED });
  });
});
