import { z } from "zod";
import type { ApiResult, GitHubApi } from "../core/github.js";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import type { ResponseMeta } from "./meta.js";
import { responseMeta } from "./meta.js";
import { githubQuery, parseRepo } from "./util.js";

//? Session-scoped pin state, one entry per owner/name. The stdio server process
//* lives for the whole client session, so the map survives every call within a
//* session and resets when the server restarts; the tool description documents
//* that loss, and tests reset entries through clearPinnedRef between cases.
const PINNED = new Map<string, { ref: string; sha: string }>();

export function getPinnedRef(repo: string): { ref: string; sha: string } | undefined {
  return PINNED.get(repo);
}

export function setPinnedRef(repo: string, ref: string, sha: string): void {
  PINNED.set(repo, { ref, sha });
}

export function clearPinnedRef(repo: string): void {
  PINNED.delete(repo);
}

interface RepoMetaResponse {
  default_branch: string;
}

interface CommitHead {
  sha: string;
}

//* GitHub reports commit shas as 40 hex characters; the check is case-insensitive
//* so any full-sha-shaped input keeps the verbatim passthrough callers already
//* relied on, and only branch, tag, or short-sha inputs cost a resolution call.
const FULL_SHA = /^[0-9a-f]{40}$/i;

//* The one-item commit read shared by branch pins and the ref-less pin's
//* default-branch resolution: its head commit carries the full commit sha, so
//* every pin anchors reads to an immutable commit instead of a moving branch.
//* A failed resolution propagates (e.g. not_found for a bad branch).
async function resolveHeadCommit(
  client: GitHubApi,
  owner: string,
  name: string,
  ref: string,
): Promise<{ result: ApiResult<CommitHead[]>; sha: string }> {
  const result = await client.api<CommitHead[]>(
    `/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}${githubQuery({ per_page: 1 })}`,
    { fresh: undefined, cacheTtlMs: 120_000 },
  );
  const head = result.data[0];
  if (head === undefined) {
    throw new GithubError("upstream", `GitHub returned no commit for ref ${ref}`);
  }
  return { result, sha: head.sha };
}

export const pinTool = defineTool({
  name: "github_pin_ref",
  title: "GitHub pin ref",
  description:
    "Pin a repository to a commit for the session: file, tree, and commit reads without an explicit ref anchor to this sha, keeping line-number references internally consistent across a session. The pin lives in server memory and is lost on restart. Costs 1 core call (2 for a default-branch pin; 0 when unpinning or passing a full sha). Returns {repo, ref, sha, pinned}; after an unpin the answer carries only repo and pinned (false).",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    ref: z
      .string()
      .optional()
      .describe(
        "Branch, tag, or commit to pin; resolves to a full commit sha. Omit to unpin when unpin is true",
      ),
    unpin: z.boolean().optional().describe("Remove this repository's pin"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const { owner, name } = parseRepo(input.repo);
    const repo = `${owner}/${name}`;
    if (input.unpin === true) {
      clearPinnedRef(repo);
      return { repo, pinned: false };
    }
    //? Three resolution paths. An explicit full sha IS the commit sha, so it
    //* skips the network entirely and, like an unpin, leaves nothing for meta
    //* to report. An explicit branch, tag, or short sha resolves through the
    //* one-item commit read (meta rides that result, calls: 1). A ref-less pin
    //* resolves in two calls: the repo lookup names the default branch and
    //* feeds meta (calls: 2 across the path), then that branch resolves to its
    //* head commit — so every pin stores a full commit sha and a branch moving
    //* mid-session can never shift the anchored line references.
    let ref: string;
    let sha: string;
    let meta: ResponseMeta | undefined;
    if (input.ref !== undefined && FULL_SHA.test(input.ref)) {
      ref = input.ref;
      sha = input.ref;
    } else if (input.ref !== undefined) {
      ref = input.ref;
      const resolved = await resolveHeadCommit(ctx.client, owner, name, input.ref);
      sha = resolved.sha;
      meta = responseMeta(resolved.result, 1);
    } else {
      //? resolveRef's repo lookup is performed inline because resolveRef discards
      //* the ApiResult the house meta channel needs; the default branch then
      //* resolves through the same one-item commit read a branch pin uses.
      const lookup = await ctx.client.api<RepoMetaResponse>(`/repos/${owner}/${name}`, {
        fresh: undefined,
        cacheTtlMs: 600_000,
      });
      ref = lookup.data.default_branch;
      const resolved = await resolveHeadCommit(ctx.client, owner, name, ref);
      sha = resolved.sha;
      meta = responseMeta(lookup, 2);
    }
    setPinnedRef(repo, ref, sha);
    return {
      repo,
      ref,
      sha,
      pinned: true,
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
