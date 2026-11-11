import { z } from "zod";
import type { ApiResult } from "../core/github.js";
import type { ToolContext } from "../core/context.js";
import { toGithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
import type { MetaSource } from "./meta.js";
import { scarcestMeta } from "./meta.js";
import { parseRepo } from "./util.js";

//? Only the fields this tool reads are typed; the REST payload carries more.
interface RepoPayload {
  full_name: string;
  description: string | null;
  private: boolean;
  visibility?: string;
  fork: boolean;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  pushed_at: string | null;
  default_branch: string;
}

interface RepoBatchSuccess {
  repo: string;
  ok: true;
  data: {
    full_name: string;
    description: string | null;
    private: boolean;
    visibility: string;
    fork: boolean;
    stars: number;
    forks: number;
    language: string | null;
    pushed_at: string | null;
    default_branch: string;
  };
}

interface RepoBatchFailure {
  repo: string;
  ok: false;
  error: { code: string; message: string };
}

type RepoBatchItem = RepoBatchSuccess | RepoBatchFailure;

//? One entry's outcome: the projected item plus the client result that produced
//* it, so the handler can fold the fulfilled entries into one scarcest meta.
interface FetchOneOutcome {
  item: RepoBatchSuccess;
  result: ApiResult<RepoPayload>;
}

//* One core call per entry; the happy path only, so every failure surfaces as a
//* rejected allSettled entry and is converted by the handler below.
async function fetchOne(
  ctx: ToolContext,
  repoSpec: string,
  fresh: boolean | undefined,
): Promise<FetchOneOutcome> {
  const { owner, name } = parseRepo(repoSpec);
  const result = await ctx.client.api<RepoPayload>(`/repos/${owner}/${name}`, {
    fresh,
    cacheTtlMs: 600_000,
  });
  const { data } = result;
  return {
    item: {
      repo: `${owner}/${name}`,
      ok: true,
      data: {
        full_name: data.full_name,
        description: data.description,
        private: data.private,
        visibility: data.visibility ?? (data.private ? "private" : "public"),
        fork: data.fork,
        stars: data.stargazers_count,
        forks: data.forks_count,
        language: data.language,
        pushed_at: data.pushed_at,
        default_branch: data.default_branch,
      },
    },
    result,
  };
}

export const reposBatchTool = defineTool({
  name: "github_repos",
  title: "GitHub repository batch",
  description:
    "Batch repository lookup: fetches up to 20 repositories concurrently, one core call each, and reports per-item success and failure so one missing or inaccessible repo never rejects the call. Returns {results[{repo, ok, data{full_name, description, private, visibility, fork, stars, forks, language, pushed_at, default_branch}} or {repo, ok, error{code, message}}], elapsed_ms}.",
  inputSchema: {
    repos: z.array(z.string()).min(1).max(20).describe("Repositories in owner/name form"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const started = Date.now();
    const settled = await Promise.allSettled(
      input.repos.map((repoSpec) => fetchOne(ctx, repoSpec, input.fresh)),
    );
    const results: RepoBatchItem[] = [];
    //? Rejected entries carry no client result, so only the fulfilled entries'
    //* observations feed the batch's scarcest meta.
    const observations: MetaSource[] = [];
    settled.forEach((entry, index) => {
      if (entry.status === "fulfilled") {
        results.push(entry.value.item);
        observations.push(entry.value.result);
        return;
      }
      //? Per-item failures land here, not as a rejected call: a GithubError keeps
      //? its own code and message (toGithubError passes instances through), and
      //? anything unexpected is normalized the same way so the batch never dies.
      const error = toGithubError(entry.reason);
      results.push({
        repo: input.repos[index] ?? "",
        ok: false,
        error: { code: error.code, message: error.message },
      });
    });
    //? Multi-request tool: one scarcest meta across the fulfilled lookups (lowest
    //* remaining, tagged with its resource), undefined when every entry failed.
    const meta = scarcestMeta(observations);
    return {
      results,
      elapsed_ms: Date.now() - started,
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
