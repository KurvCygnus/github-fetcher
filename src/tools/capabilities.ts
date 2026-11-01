import { defineTool } from "./define.js";

export interface CapabilityEntry {
  group: string;
  summary: string;
}

//* Data-driven discovery index: one row per registered tool. The guard test
//* fails when a tool is added without a row here, keeping capabilities complete.
export const CAPABILITY_GROUPS: Record<string, CapabilityEntry> = {
  github_capabilities: { group: "Meta", summary: "Task-grouped index of every tool; call this first when unsure which tool fits a job." },
  github_rate_limit: { group: "Meta", summary: "Current quota per resource with reset times; call it when refused with 403/429." },
  github_api_get: { group: "Meta", summary: "Escape hatch for read-only REST GETs the dedicated tools do not cover; host fixed to api.github.com." },
  github_repo: { group: "Repository", summary: "Single repository metadata: description, stars, forks, license, default branch." },
  github_branches: { group: "Repository", summary: "Branch list with head sha and protection state." },
  github_tree: { group: "Files", summary: "File and directory listing at a ref, recursive optional." },
  github_file: { group: "Files", summary: "One file's text at a ref; reports binary files without bytes." },
  github_commits: { group: "History", summary: "Commit list on a ref with path/author/date filters." },
  github_issue: { group: "Collaboration", summary: "One issue or pull request with comments on demand." },
  github_issues: { group: "Collaboration", summary: "Issue list with state and label filters; defaults to issues only." },
  github_pr: { group: "Collaboration", summary: "One pull request with stats and optional changed files." },
  github_prs: { group: "Collaboration", summary: "Pull request list with state/base/head filters." },
  github_release: { group: "Releases", summary: "Latest or tagged release with assets; found:false when none." },
  github_releases: { group: "Releases", summary: "Lean release list newest first, notes omitted." },
  github_repo_health: { group: "Snapshot", summary: "One-call repository panorama: counts, window health, labels, latest release." },
  github_compare_repos: { group: "Snapshot", summary: "Throttled multi-repo breadth comparison; one call for up to 20 repositories." },
  github_search_repos: { group: "Search", summary: "Repository search by GitHub query syntax." },
  github_search_code: { group: "Search", summary: "Code search; requires a token." },
  github_search_issues: { group: "Search", summary: "Issue and pull request search by GitHub query syntax." },
  github_workflows: { group: "Actions", summary: "Actions workflow list for a repository." },
  github_workflow_runs: { group: "Actions", summary: "Workflow run list, repo-wide or per workflow." },
  github_workflow_run: { group: "Actions", summary: "One run with jobs and steps on demand." },
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
    const groups: Array<{ group: string; tools: Array<{ name: string; summary: string }> }> = [];
    for (const [name, entry] of Object.entries(CAPABILITY_GROUPS)) {
      let group = groups.find((candidate) => candidate.group === entry.group);
      if (!group) {
        group = { group: entry.group, tools: [] };
        groups.push(group);
      }
      group.tools.push({ name, summary: entry.summary });
    }
    return { total: Object.keys(CAPABILITY_GROUPS).length, groups };
  },
});
