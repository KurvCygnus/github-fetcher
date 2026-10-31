import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/github.js";
import { workflowRunTool, workflowRunsTool, workflowsTool } from "../../src/tools/actions.js";
import { makeConfig } from "../helpers.js";

//? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
//! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
function clientWith(data: unknown, headers = new Headers()) {
  return {
    api: vi.fn(async () => ({ data, headers, status: 200, contentType: "application/json" })),
    apiRaw: vi.fn(),
    raw: vi.fn(),
  } as unknown as GitHubApi;
}

describe("github_workflows", () => {
  it("lists workflows", async () => {
    const client = clientWith({
      total_count: 1,
      workflows: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }],
    });
    const output = await workflowsTool.handler(
      { repo: "o/r" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith("/repos/o/r/actions/workflows?page=1&per_page=20", {
      fresh: undefined,
      cacheTtlMs: 300_000,
    });
    expect(output).toMatchObject({
      total_count: 1,
      items: [{ id: 1, name: "CI", path: ".github/workflows/ci.yml", state: "active" }],
    });
  });
});

describe("github_workflow_runs", () => {
  it("filters runs by workflow and maps conclusions", async () => {
    const client = clientWith({
      total_count: 1,
      workflow_runs: [
        {
          id: 9,
          name: "CI",
          workflow_id: 1,
          run_number: 3,
          event: "push",
          status: "completed",
          conclusion: "success",
          head_branch: "main",
          head_sha: "abc",
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:01:00Z",
          html_url: "https://github.com/o/r/actions/runs/9",
        },
      ],
    });
    const output = await workflowRunsTool.handler(
      { repo: "o/r", workflow_id: 1, branch: "main", status: "completed", event: "push" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(client.api).toHaveBeenCalledWith(
      "/repos/o/r/actions/workflows/1/runs?branch=main&status=completed&event=push&page=1&per_page=20",
      { fresh: undefined, cacheTtlMs: 60_000 },
    );
    expect(output).toMatchObject({
      total_count: 1,
      items: [
        {
          id: 9,
          name: "CI",
          run_number: 3,
          conclusion: "success",
          branch: "main",
          sha: "abc",
        },
      ],
    });
  });
});

describe("github_workflow_run", () => {
  it("includes jobs and steps when requested", async () => {
    const client = clientWith({
      id: 9,
      name: "CI",
      run_number: 3,
      event: "push",
      status: "completed",
      conclusion: "success",
      head_branch: "main",
      head_sha: "abc",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:01:00Z",
      html_url: "https://github.com/o/r/actions/runs/9",
      jobs: [
        {
          id: 2,
          name: "test",
          status: "completed",
          conclusion: "success",
          started_at: "2024-01-01T00:00:00Z",
          completed_at: "2024-01-01T00:01:00Z",
          steps: [{ number: 1, name: "run tests", status: "completed", conclusion: "success" }],
        },
      ],
    });
    const output = await workflowRunTool.handler(
      { repo: "o/r", run_id: 9, include_jobs: true },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(output).toMatchObject({
      id: 9,
      jobs: [
        {
          id: 2,
          name: "test",
          steps: [{ number: 1, name: "run tests", status: "completed", conclusion: "success" }],
        },
      ],
      jobs_truncated: false,
    });
  });
});
