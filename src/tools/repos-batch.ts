import { z } from "zod";
import type { ToolContext } from "../core/context.js";
import { toGithubError } from "../core/errors.js";
import { defineTool } from "./define.js";
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

//* One core call per entry; the happy path only, so every failure surfaces as a
//* rejected allSettled entry and is converted by the handler below.
async function fetchOne(
  ctx: ToolContext,
  repoSpec: string,
  fresh: boolean | undefined,
): Promise<RepoBatchSuccess> {
  const { owner, name } = parseRepo(repoSpec);
  const { data } = await ctx.client.api<RepoPayload>(`/repos/${owner}/${name}`, {
    fresh,
    cacheTtlMs: 600_000,
  });
  return {
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
    const results: RepoBatchItem[] = settled.map((entry, index) => {
      if (entry.status === "fulfilled") return entry.value;
      //? Per-item failures land here, not as a rejected call: a GithubError keeps
      //? its own code and message (toGithubError passes instances through), and
      //? anything unexpected is normalized the same way so the batch never dies.
      const error = toGithubError(entry.reason);
      return {
        repo: input.repos[index] ?? "",
        ok: false,
        error: { code: error.code, message: error.message },
      };
    });
    return { results, elapsed_ms: Date.now() - started };
  },
});
