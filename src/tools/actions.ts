import { z } from "zod";
import { defineTool } from "./define.js";
import { linkFor, listEnvelope } from "./pagination.js";
import { githubQuery, parseRepo } from "./util.js";

interface WorkflowResponse {
  id: number;
  name: string;
  path: string;
  state: string;
}

interface WorkflowRunResponse {
  id: number;
  name: string;
  workflow_id: number;
  run_number: number;
  event: string;
  status: string;
  conclusion: string | null;
  head_branch: string | null;
  head_sha: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface JobResponse {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps?: {
    number: number;
    name: string;
    status: string;
    conclusion: string | null;
  }[];
}

function runFields(run: WorkflowRunResponse) {
  return {
    id: run.id,
    name: run.name,
    workflow_id: run.workflow_id,
    run_number: run.run_number,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    branch: run.head_branch,
    sha: run.head_sha,
    created_at: run.created_at,
    updated_at: run.updated_at,
    html_url: run.html_url,
  };
}

export const workflowsTool = defineTool({
  name: "github_workflows",
  title: "GitHub workflows",
  description: "List GitHub Actions workflows in a repository, including disabled and legacy workflows. Returns {total_count, items[{id, name, path, state}], page, per_page, has_more, next_page}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
    per_page: z.number().int().min(1).max(100).optional().describe("Items per page, default 20"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const { owner, name } = parseRepo(input.repo);
    const page = input.page ?? 1;
    const perPage = input.per_page ?? 20;
    const query = githubQuery({ page, per_page: perPage });
    const { data, headers } = await ctx.client.api<{
      total_count: number;
      workflows: WorkflowResponse[];
    }>(`/repos/${owner}/${name}/actions/workflows${query}`, {
      fresh: input.fresh,
      cacheTtlMs: 300_000,
    });
    const items = data.workflows.map((workflow) => ({
      id: workflow.id,
      name: workflow.name,
      path: workflow.path,
      state: workflow.state,
    }));
    return {
      total_count: data.total_count,
      ...listEnvelope(items, page, perPage, headers.get("link")),
    };
  },
});

export const workflowRunsTool = defineTool({
  name: "github_workflow_runs",
  title: "GitHub workflow runs",
  description:
    "List workflow runs for a repository or one workflow, optionally filtered by branch, status, and event. Returns {total_count, items[{id, name, workflow_id, run_number, event, status, conclusion, branch, sha, created_at, updated_at, html_url}], page, per_page, has_more, next_page}.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    workflow_id: z.number().int().positive().optional().describe("Workflow id or numeric workflow file id"),
    branch: z.string().optional().describe("Branch filter"),
    status: z.string().optional().describe("Run status, conclusion, or both, as accepted by GitHub"),
    event: z.string().optional().describe("Event filter, such as push or pull_request"),
    page: z.number().int().min(1).optional().describe("Page number, starting at 1"),
    per_page: z.number().int().min(1).max(100).optional().describe("Items per page, default 20"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const { owner, name } = parseRepo(input.repo);
    const page = input.page ?? 1;
    const perPage = input.per_page ?? 20;
    const query = githubQuery({
      branch: input.branch,
      status: input.status,
      event: input.event,
      page,
      per_page: perPage,
    });
    const path = input.workflow_id
      ? `/repos/${owner}/${name}/actions/workflows/${input.workflow_id}/runs${query}`
      : `/repos/${owner}/${name}/actions/runs${query}`;
    const { data, headers } = await ctx.client.api<{
      total_count: number;
      workflow_runs: WorkflowRunResponse[];
    }>(path, { fresh: input.fresh, cacheTtlMs: 60_000 });
    const items = data.workflow_runs.map(runFields);
    return {
      total_count: data.total_count,
      ...listEnvelope(items, page, perPage, headers.get("link")),
    };
  },
});

export const workflowRunTool = defineTool({
  name: "github_workflow_run",
  title: "GitHub workflow run",
  description:
    "Read one workflow run. Set include_jobs=true to fetch up to 100 jobs with their step statuses and conclusions. Returns run fields {id, name, workflow_id, run_number, event, status, conclusion, branch, sha, created_at, updated_at, html_url}; adds {jobs[{id, name, status, conclusion, started_at, completed_at, steps[{number, name, status, conclusion}]}], jobs_truncated} when include_jobs is true.",
  inputSchema: {
    repo: z.string().describe("Repository in owner/name form"),
    run_id: z.number().int().positive().describe("Workflow run id"),
    include_jobs: z.boolean().optional().describe("Include up to 100 jobs and their steps"),
    fresh: z.boolean().optional().describe("Bypass the local cache"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, ctx) {
    const { owner, name } = parseRepo(input.repo);
    const { data } = await ctx.client.api<WorkflowRunResponse & { jobs?: JobResponse[] }>(
      `/repos/${owner}/${name}/actions/runs/${input.run_id}`,
      { fresh: input.fresh, cacheTtlMs: 60_000 },
    );
    const result: Record<string, unknown> = runFields(data);
    if (input.include_jobs) {
      const jobs = await ctx.client.api<{ jobs: JobResponse[] }>(
        `/repos/${owner}/${name}/actions/runs/${input.run_id}/jobs?per_page=100`,
        { fresh: input.fresh, cacheTtlMs: 60_000 },
      );
      result.jobs = jobs.data.jobs.map((job) => ({
        id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        started_at: job.started_at,
        completed_at: job.completed_at,
        steps: (job.steps ?? []).map((step) => ({
          number: step.number,
          name: step.name,
          status: step.status,
          conclusion: step.conclusion,
        })),
      }));
      result.jobs_truncated = linkFor(jobs.headers, "next") !== null;
    }
    return result;
  },
});
