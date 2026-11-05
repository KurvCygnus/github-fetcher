import { defineTool } from "./define.js";

export interface CapabilityEntry {
  group: string;
  summary: string;
  signature: string;
}

//* Data-driven discovery index: one row per registered tool. The guard test
//* fails when a tool is added without a row here, keeping capabilities complete.
export const CAPABILITY_GROUPS: Record<string, CapabilityEntry> = {
  github_capabilities: { group: "Meta", summary: "Task-grouped index of every tool; call this first when unsure which tool fits a job.", signature: "none" },
  github_rate_limit: { group: "Meta", summary: "Current quota per resource with reset times; call it when refused with 403/429.", signature: "resource?" },
  github_api_get: { group: "Meta", summary: "Escape hatch for read-only REST GETs the dedicated tools do not cover; host fixed to api.github.com.", signature: "path, query?" },
  github_repo: { group: "Repository", summary: "Single repository metadata: description, stars, forks, license, default branch.", signature: "repo, fresh?" },
  github_branches: { group: "Repository", summary: "Branch list with head sha and protection state.", signature: "repo, page?, per_page?, fresh?" },
  github_tree: { group: "Files", summary: "File and directory listing at a ref, recursive optional.", signature: "repo, ref?, path?, recursive?, max_entries?, fresh?" },
  github_file: { group: "Files", summary: "One file's text at a ref; reports binary files without bytes.", signature: "repo, path, ref?, start_line?, end_line?, fresh?" },
  github_commits: { group: "History", summary: "Commit list on a ref with path/author/date filters.", signature: "repo, ref?, path?, author?, since?, until?, page?, per_page?, fresh?" },
  github_issue: { group: "Collaboration", summary: "One issue or pull request with comments on demand.", signature: "repo, number, include_comments?, comment_limit?, max_comment_chars?, fresh?" },
  github_issues: { group: "Collaboration", summary: "Issue list with state and label filters; defaults to issues only.", signature: "repo, type?, state?, labels?, sort?, direction?, page?, per_page?, fresh?" },
  github_pr: { group: "Collaboration", summary: "One pull request with stats and optional changed files.", signature: "repo, number, include_files?, fresh?" },
  github_prs: { group: "Collaboration", summary: "Pull request list with state/base/head filters.", signature: "repo, state?, base?, head?, sort?, direction?, page?, per_page?, fresh?" },
  github_release: { group: "Releases", summary: "Latest or tagged release with assets; found:false when none.", signature: "repo, tag?, fresh?" },
  github_releases: { group: "Releases", summary: "Lean release list newest first, notes omitted.", signature: "repo, page?, per_page?, include_prereleases?, fresh?" },
  github_repo_health: { group: "Snapshot", summary: "One-call repository panorama: counts, window health, labels, latest release.", signature: "repo, window_days?, labels?, fresh?" },
  github_compare_repos: { group: "Snapshot", summary: "Throttled multi-repo breadth comparison; one call for up to 20 repositories.", signature: "repos, window_days?, fresh?" },
  github_search_repos: { group: "Search", summary: "Repository search by GitHub query syntax.", signature: "query, sort?, order?, page?, per_page?, public_only?, fresh?" },
  github_search_code: { group: "Search", summary: "Code search; requires a token.", signature: "query, page?, per_page?, fresh?" },
  github_search_issues: { group: "Search", summary: "Issue and pull request search by GitHub query syntax.", signature: "query, sort?, order?, page?, per_page?, fresh?" },
  github_workflows: { group: "Actions", summary: "Actions workflow list for a repository.", signature: "repo, page?, per_page?, fresh?" },
  github_workflow_runs: { group: "Actions", summary: "Workflow run list, repo-wide or per workflow.", signature: "repo, workflow_id?, branch?, status?, event?, page?, per_page?, fresh?" },
  github_workflow_run: { group: "Actions", summary: "One run with jobs and steps on demand.", signature: "repo, run_id, include_jobs?, fresh?" },
};

export const capabilitiesTool = defineTool({
  name: "github_capabilities",
  title: "GitHub capabilities",
  description:
    "Task-grouped index of every tool in this server. Call this first when unsure which tool fits a job; costs nothing.",
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  async handler() {
    const groups: Array<{ group: string; tools: Array<{ name: string; summary: string; signature: string }> }> = [];
    for (const [name, entry] of Object.entries(CAPABILITY_GROUPS)) {
      let group = groups.find((candidate) => candidate.group === entry.group);
      if (!group) {
        group = { group: entry.group, tools: [] };
        groups.push(group);
      }
      group.tools.push({ name, summary: entry.summary, signature: entry.signature });
    }
    return { total: Object.keys(CAPABILITY_GROUPS).length, groups };
  },
});
