import { z } from "zod";
import { GithubError } from "../core/errors.js";
import { defineTool } from "./define.js";

export interface CapabilityEntry {
  group: string;
  summary: string;
  signature: string;
}

export interface CapabilityInput {
  name: string;
  optional: boolean;
  description: string;
}

//* Optionality is derived from `z.ZodOptional` alone: a field wrapped in
//* `.default()` would report `optional: false` even though callers may omit it.
//* No registered tool uses `.default()` today; if one appears, extend this
//* derivation or the index misreports that input as required.
export function capabilityInputs(shape: z.ZodRawShape): CapabilityInput[] {
  return Object.entries(shape).map(([name, field]) => ({
    name,
    optional: field instanceof z.ZodOptional,
    //? ZodRawShape values are typed as core $ZodType, which omits the classic
    //? description getter; registered schemas are always classic instances.
    description: (field as z.ZodType).description ?? "",
  }));
}

//* Data-driven discovery index: one row per registered tool. The guard test
//* fails when a tool is added without a row here, keeping capabilities complete.
export const CAPABILITY_GROUPS: Record<string, CapabilityEntry> = {
  github_capabilities: { group: "Meta", summary: "Task-grouped index of every tool; call this first when unsure which tool fits a job. Envelope: single object", signature: "group?" },
  github_rate_limit: { group: "Meta", summary: "Current quota per resource with reset times; call it when refused with 403/429. Envelope: single object", signature: "resource?, all?" },
  github_api_get: { group: "Meta", summary: "Escape hatch for read-only REST GETs the dedicated tools do not cover; host fixed to api.github.com. Envelope: {status, content_type, body}", signature: "path, query?, fresh?" },
  github_doctor: { group: "Meta", summary: "One-screen health check: token presence, opt-in identity, proxy reachability, cache state, and quota; call it first when calls fail unexpectedly. Envelope: single object", signature: "none" },
  github_repo: { group: "Repository", summary: "Single repository metadata: description, visibility, stars, forks, license, default branch. Envelope: single object", signature: "repo, fresh?" },
  github_repos: { group: "Repository", summary: "Concurrent batch lookup of up to 20 repositories; per-item ok/error so one missing repo never rejects the call. Envelope: single object", signature: "repos, fresh?" },
  github_compare_refs: { group: "Repository", summary: "Two-ref comparison: ahead/behind, total commits, and up to 100 changed files with patches capped at 4000 characters. Envelope: single object", signature: "repo, base, head, fresh?" },
  github_branches: { group: "Repository", summary: "Branch list with head sha and protection state. Envelope: items[]", signature: "repo, page?, per_page?, fresh?" },
  github_languages: { group: "Repository", summary: "Language bytes per language, sorted descending; the byte-accurate alternative to extension counting. Envelope: single object", signature: "repo, fresh?" },
  github_contributors: { group: "Repository", summary: "Contributor list with login, type, and contribution count; anonymous contributors are excluded. Envelope: items[]", signature: "repo, page?, per_page?, fresh?" },
  github_repo_activity: { group: "Repository", summary: "Window activity from core endpoints only: pull and issue counts, merge-time median, commits, active contributors, releases, with truncation flags. Envelope: single object", signature: "repo, window_days?, fresh?" },
  github_user: { group: "User", summary: "One user's profile: name, type, bio, company, location, blog, and follower counts. Envelope: single object", signature: "user" },
  github_user_repos: { group: "User", summary: "A user's public repositories with the house projection: visibility, fork, stars, watchers, language, push time. Envelope: items[]", signature: "user, type?, sort?, order?, page?, per_page?, fresh?" },
  github_user_starred: { group: "User", summary: "Repositories a user starred, with the starred time from the star+json media type. Envelope: items[]", signature: "user, page?, per_page?, fresh?" },
  github_user_events: { group: "User", summary: "A user's public events with type, repository, and time; private events are never included. Envelope: items[]", signature: "user, page?, per_page?, fresh?" },
  github_tree: { group: "Files", summary: "File and directory listing at a ref, recursive optional; summary_only drops entries for totals. Envelope: entries[]", signature: "repo, ref?, path?, recursive?, max_entries?, summary_only?, fresh?" },
  github_file: { group: "Files", summary: "One file's text at a ref; reports binary files without bytes. Envelope: single object", signature: "repo, path, ref?, start_line?, end_line?, max_bytes?, fresh?" },
  github_readme: { group: "Files", summary: "Fetch a repository's README through GitHub's readme endpoint, which resolves the default naming variant (README.md, README.zh-CN.md, and friends); use github_file for a specific path. Envelope: single object", signature: "repo, fresh?" },
  github_commits: { group: "History", summary: "Commit list on a ref: short sha, message, author, and date. Envelope: items[]", signature: "repo, ref?, path?, author?, since?, until?, page?, per_page?, fresh?" },
  github_issue: { group: "Collaboration", summary: "One issue or pull request with labels and assignees. Envelope: single object", signature: "repo, number, include_comments?, comment_limit?, max_comment_chars?, fresh?" },
  github_issues: { group: "Collaboration", summary: "Issue list with filters, defaults to issues only. Envelope: items[]", signature: "repo, type?, state?, labels?, sort?, direction?, since?, page?, per_page?, fresh?" },
  github_pr: { group: "Collaboration", summary: "One pull request with branches, stats, and mergeability; optional changed files. Envelope: single object", signature: "repo, number, include_files?, fresh?" },
  github_prs: { group: "Collaboration", summary: "Pull request list with state, base, and head filters. Envelope: items[]", signature: "repo, state?, base?, head?, sort?, direction?, page?, per_page?, fresh?" },
  github_release: { group: "Releases", summary: "Latest or tagged release with assets and download URLs; found:false when none. Envelope: single object", signature: "repo, tag?, fresh?" },
  github_releases: { group: "Releases", summary: "Lean release list newest first, notes omitted. Envelope: items[]", signature: "repo, page?, per_page?, include_prereleases?, fresh?" },
  github_repo_health: { group: "Snapshot", summary: "One-call repository snapshot: counts, window health, labels, latest release. Envelope: single object", signature: "repo, window_days?, labels?, fresh?" },
  github_compare_repos: { group: "Snapshot", summary: "Throttled multi-repo breadth comparison; one call for up to 20 repositories. Envelope: single object", signature: "repos, window_days?, fresh?" },
  github_search_repos: { group: "Search", summary: "Repository search by GitHub query syntax; public_only defaults to true. Envelope: items[]", signature: "query, sort?, order?, page?, per_page?, public_only?, fresh?" },
  github_search_code: { group: "Search", summary: "Code search across GitHub; requires a token. Envelope: items[]", signature: "query, page?, per_page?, fresh?" },
  github_search_issues: { group: "Search", summary: "Issue and pull request search by GitHub query syntax. Envelope: items[]", signature: "query, sort?, order?, page?, per_page?, fresh?" },
  github_search_users: { group: "Search", summary: "User search by GitHub query syntax — location, language, followers:>=N, repositories:>=N, fullname: qualifiers; profile detail lives in github_user. Envelope: items[]", signature: "query, sort?, order?, page?, per_page?, fresh?" },
  github_workflows: { group: "Actions", summary: "Actions workflow list for a repository. Envelope: items[]", signature: "repo, page?, per_page?, fresh?" },
  github_workflow_runs: { group: "Actions", summary: "Workflow run list, repo-wide or per workflow. Envelope: items[]", signature: "repo, workflow_id?, branch?, status?, event?, page?, per_page?, fresh?" },
  github_workflow_run: { group: "Actions", summary: "One workflow run with optional jobs and steps on demand. Envelope: single object", signature: "repo, run_id, include_jobs?, fresh?" },
};

export const capabilitiesTool = defineTool({
  name: "github_capabilities",
  title: "GitHub capabilities",
  description:
    "Task-grouped index of every tool in this server. Call this first when unsure which tool fits a job; costs nothing. Returns {total, groups[{group, tools[{name, summary, signature, input}]}]}.",
  inputSchema: {
    group: z
      .string()
      .optional()
      .describe("Restrict the index to one group, e.g. Search or Files; groups are listed in the output"),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler(input, _ctx) {
    //* The registry imports this module, so the tool list is pulled lazily at
    //* call time; an eager import would create a module-evaluation cycle
    //* (capabilitiesTool is a const inside the registry's array).
    const { tools } = await import("./index.js");
    const groups: Array<{ group: string; tools: Array<{ name: string; summary: string; signature: string; input: CapabilityInput[] }> }> = [];
    for (const [name, entry] of Object.entries(CAPABILITY_GROUPS)) {
      let group = groups.find((candidate) => candidate.group === entry.group);
      if (!group) {
        group = { group: entry.group, tools: [] };
        groups.push(group);
      }
      const registered = tools.find((candidate) => candidate.name === name);
      group.tools.push({
        name,
        summary: entry.summary,
        signature: entry.signature,
        input: registered ? capabilityInputs(registered.inputSchema) : [],
      });
    }
    //* `total` counts the full registry on every success path, filtered or not, so
    //* a caller can always tell the index is a filtered view rather than the whole
    //* server. The miss path names every valid group so an agent can self-correct
    //* without a second discovery round.
    const total = Object.keys(CAPABILITY_GROUPS).length;
    if (input.group === undefined) {
      return { total, groups };
    }
    const wanted = input.group.toLowerCase();
    const matched = groups.find((candidate) => candidate.group.toLowerCase() === wanted);
    if (!matched) {
      throw new GithubError(
        "invalid_params",
        `unknown group ${input.group}; valid groups: ${groups.map((candidate) => candidate.group).join(", ")}`,
      );
    }
    return { total, groups: [matched] };
  },
});
