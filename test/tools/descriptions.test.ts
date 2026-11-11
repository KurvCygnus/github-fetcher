import { describe, expect, it, vi } from "vitest";
import type { GitHubApi } from "../../src/core/github.js";
import { repoTool } from "../../src/tools/repo.js";
import { allTools } from "../../src/tools/registry.js";
import { searchReposTool } from "../../src/tools/search.js";
import { treeTool } from "../../src/tools/tree.js";
import { makeConfig } from "../helpers.js";

//* The registry legitimately uses two declaration forms: "Returns {...}" and
//* "Returns <noun> fields {...}" (github_issue, github_pr, and
//* github_workflow_run name their primary object before the key list), and a few
//* descriptions (github_rate_limit, github_issue, github_pr, github_workflow_run)
//* append prose after the brace list. The parser therefore reads the brace list
//* after the LAST "Returns" and splits only its top-level fields, which covers
//* every registered form.
function declaredFields(description: string): string[] {
  const returns = description.lastIndexOf("Returns ");
  if (returns === -1) return [];
  const open = description.indexOf("{", returns);
  const close = description.lastIndexOf("}");
  if (open === -1 || close === -1 || close < open) return [];
  const fields: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of description.slice(open + 1, close)) {
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      fields.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  fields.push(current);
  return fields
    .map((field) => /^[a-z_][a-z0-9_]*/.exec(field.trim())?.[0])
    .filter((name): name is string => name !== undefined);
}

describe("tool descriptions", () => {
  it("declares a parsable output envelope in every description", () => {
    for (const tool of allTools) {
      const fields = declaredFields(tool.description);
      expect(fields.length, tool.name).toBeGreaterThan(0);
      expect(new Set(fields).size, tool.name).toBe(fields.length);
    }
  });

  it("declares exactly the github_repo handler's fields", async () => {
    //? A concrete vi.fn return cannot satisfy the generic api<T> signature, so the
    //! mock literal is asserted to GitHubApi; assertions still inspect the same mock.
    //? The fixture result omits `cache`, so `meta` stays absent and the output
    //* keeps exactly the fixed keys the Returns sentence declares; meta presence
    //* is covered by meta.test.ts and the per-tool suites.
    const client = {
      api: vi.fn(async () => ({
        data: {
          full_name: "octocat/Hello-World",
          description: "My first repository on GitHub!",
          private: false,
          html_url: "https://github.com/octocat/Hello-World",
          default_branch: "master",
          stargazers_count: 3875,
          forks_count: 7285,
          open_issues_count: 1500,
          has_issues: true,
          has_discussions: false,
          language: null,
          license: null,
          topics: ["octocat"],
          archived: false,
          pushed_at: "2024-01-02T00:00:00Z",
          created_at: "2011-01-26T19:01:12Z",
        },
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const output = await repoTool.handler(
      { repo: "octocat/Hello-World" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(declaredFields(repoTool.description).sort(), repoTool.name).toEqual(
      Object.keys(output).sort(),
    );
  });

  it("declares exactly the github_search_repos handler's fields", async () => {
    const client = {
      api: vi.fn(async () => ({
        data: {
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              full_name: "rust-lang/rust",
              description: "Empowering everyone",
              private: false,
              stargazers_count: 100,
              forks_count: 10,
              language: "Rust",
              topics: ["rust"],
              license: { spdx_id: "MIT OR Apache-2.0" },
              updated_at: "2024-01-01T00:00:00Z",
              html_url: "https://github.com/rust-lang/rust",
            },
          ],
        },
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const output = await searchReposTool.handler(
      { query: "rust" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(declaredFields(searchReposTool.description).sort(), searchReposTool.name).toEqual(
      Object.keys(output).sort(),
    );
  });

  it("declares exactly the github_tree handler's fields", async () => {
    const client = {
      api: vi.fn(async () => ({
        data: {
          sha: "abc",
          truncated: false,
          tree: [{ path: "README.md", mode: "100644", type: "blob", size: 12, sha: "f1" }],
        },
        headers: new Headers(),
        status: 200,
        contentType: "application/json",
      })),
      apiRaw: vi.fn(),
      raw: vi.fn(),
    } as unknown as GitHubApi;
    const output = await treeTool.handler(
      { repo: "octocat/Hello-World", ref: "main" },
      { client, config: makeConfig(), authFingerprint: "abc" },
    );
    expect(declaredFields(treeTool.description).sort(), treeTool.name).toEqual(
      Object.keys(output).sort(),
    );
  });
});
