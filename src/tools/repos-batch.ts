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

//? One entry's outcome: the projected item (success or per-item error) plus the
//* client result that produced it, so the handler can fold the fulfilled entries
//* into one scarcest meta. attempts counts the entry's client invocations: a
//* malformed spec costs zero, and a rejected request still costs its one attempt.
interface FetchOneOutcome {
  item: RepoBatchItem;
  result: ApiResult<RepoPayload> | undefined;
  attempts: number;
}

//* One core call per entry; every failure — including a malformed spec, which
//* spends no request — is normalized to an ok:false item here so the batch never
//* dies and the handler sees each entry's exact attempt count.
async function fetchOne(
  ctx: ToolContext,
  repoSpec: string,
  fresh: boolean | undefined,
): Promise<FetchOneOutcome> {
  let attempts = 0;
  try {
    const { owner, name } = parseRepo(repoSpec);
    attempts += 1;
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
      attempts,
    };
  } catch (error) {
    const normalized = toGithubError(error);
    return {
      item: {
        repo: repoSpec,
        ok: false,
        error: { code: normalized.code, message: normalized.message },
      },
      result: undefined,
      attempts,
    };
  }
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
    const outcomes = await Promise.all(
      input.repos.map((repoSpec) => fetchOne(ctx, repoSpec, input.fresh)),
    );
    const results: RepoBatchItem[] = [];
    //? Failed entries carry no client result, so only the fulfilled entries'
    //* observations feed the batch's scarcest meta; the call count still covers
    //* every attempt, including the ones that rejected.
    const observations: MetaSource[] = [];
    let calls = 0;
    outcomes.forEach((outcome) => {
      results.push(outcome.item);
      calls += outcome.attempts;
      if (outcome.result !== undefined) observations.push(outcome.result);
    });
    //? Multi-request tool: one scarcest meta across the fulfilled lookups (lowest
    //* remaining, tagged with its resource), undefined when every entry failed.
    const meta = scarcestMeta(observations, calls);
    return {
      results,
      elapsed_ms: Date.now() - started,
      ...(meta !== undefined ? { meta } : {}),
    };
  },
});
