import { defineTool } from "./define.js";

export interface CapabilityEntry {
  group: string;
  summary: string;
  signature: string;
}

//* Data-driven discovery index: one row per registered tool. The guard test
//* fails when a tool is added without a row here, keeping capabilities complete.
export const CAPABILITY_GROUPS: Record<string, CapabilityEntry> = {
  github_capabilities: { group: "Meta", summary: "Task-grouped index of every tool with name, one-line summary, and input signature; call this first when unsure which tool fits a job. Takes no input and makes no network calls.", signature: "none" },
  github_rate_limit: { group: "Meta", summary: "Current quota per resource with reset times; call it when refused with 403/429. resource: one bucket name such as core or search; omit for all buckets. Identity fields appear only when GITHUB_MCP_EXPOSE_IDENTITY is on.", signature: "resource?" },
  github_api_get: { group: "Meta", summary: "Escape hatch for read-only REST GETs the dedicated tools do not cover; host fixed to api.github.com. path: absolute path like /repos/owner/name/readme, may carry one query string; query: {name: string, number, or boolean} overriding path pairs with the same key; GraphQL and writes are rejected.", signature: "path, query?, fresh?" },
  github_repo: { group: "Repository", summary: "Single repository metadata: description, visibility, stars, forks, license, default branch. repo: owner/name; fresh bypasses the cache for one call.", signature: "repo, fresh?" },
  github_branches: { group: "Repository", summary: "Branch list with head sha and protection state. repo: owner/name; page 1-based; per_page 1-100 default 20; fresh bypasses the cache.", signature: "repo, page?, per_page?, fresh?" },
  github_tree: { group: "Files", summary: "File and directory listing at a ref, recursive optional. repo: owner/name; ref: branch/tag/commit, defaults to the default branch; path: subdirectory inside the ref; recursive: true for the complete tree; max_entries: 1-10000 default 1000; fresh bypasses the cache.", signature: "repo, ref?, path?, recursive?, max_entries?, fresh?" },
  github_file: { group: "Files", summary: "One file's text at a ref; reports binary files without bytes. repo: owner/name; path: file path inside the repository; ref: branch/tag/commit, defaults to the default branch; start_line/end_line: 1-based inclusive range, defaults to the whole file; fresh bypasses the cache.", signature: "repo, path, ref?, start_line?, end_line?, fresh?" },
  github_commits: { group: "History", summary: "Commit list on a ref: short sha, message, author, and date. repo: owner/name; ref: branch/tag/commit, defaults to the default branch; path: only commits touching this path; author: login or email; since/until: ISO 8601 bounds; page 1-based; per_page 1-100 default 20; fresh bypasses the cache.", signature: "repo, ref?, path?, author?, since?, until?, page?, per_page?, fresh?" },
  github_issue: { group: "Collaboration", summary: "One issue or pull request with labels and assignees. repo: owner/name; number: issue or PR number; include_comments: true fetches the latest comments chronologically; comment_limit: 1-100 default 20; max_comment_chars: truncates each comment body; fresh bypasses the cache.", signature: "repo, number, include_comments?, comment_limit?, max_comment_chars?, fresh?" },
  github_issues: { group: "Collaboration", summary: "Issue list with filters, defaults to issues only. repo: owner/name; type: issue/pr/all; state: open/closed/all, default open; labels: comma-separated names; sort: created/updated/comments; direction: asc/desc; page 1-based; per_page 1-100 default 20; fresh bypasses the cache.", signature: "repo, type?, state?, labels?, sort?, direction?, page?, per_page?, fresh?" },
  github_pr: { group: "Collaboration", summary: "One pull request with branches, stats, and mergeability; optional changed files. repo: owner/name; number: PR number; include_files: true fetches up to 100 files with patches; fresh bypasses the cache.", signature: "repo, number, include_files?, fresh?" },
  github_prs: { group: "Collaboration", summary: "Pull request list with state, base, and head filters. repo: owner/name; state: open/closed/all, default open; base: base branch; head: owner:branch; sort: created/updated/popularity/long-running; direction: asc/desc; page 1-based; per_page 1-100 default 20; fresh bypasses the cache.", signature: "repo, state?, base?, head?, sort?, direction?, page?, per_page?, fresh?" },
  github_release: { group: "Releases", summary: "Latest or tagged release with assets and download URLs; found:false when none. repo: owner/name; tag: release tag, omit for the latest release; fresh bypasses the cache.", signature: "repo, tag?, fresh?" },
  github_releases: { group: "Releases", summary: "Lean release list newest first, notes omitted. repo: owner/name; page 1-based; per_page 1-100 default 20; include_prereleases: false filters prereleases and drafts client-side; fresh bypasses the cache; fetch one release's notes with github_release.", signature: "repo, page?, per_page?, include_prereleases?, fresh?" },
  github_repo_health: { group: "Snapshot", summary: "One-call repository snapshot: counts, window opened/closed, per-label open counts, and the latest release; about 10 upstream calls inside the search quota. repo: owner/name; window_days: 1-365 default 30; labels: array of label names, default bug/regression/data-loss/reproduced; fresh bypasses the cache.", signature: "repo, window_days?, labels?, fresh?" },
  github_compare_repos: { group: "Snapshot", summary: "Throttled multi-repo breadth comparison, about 10 repos per minute. repos: 1-20 entries in owner/name form; window_days: 1-365 default 30; fresh bypasses the cache.", signature: "repos, window_days?, fresh?" },
  github_search_repos: { group: "Search", summary: "Repository search by GitHub query syntax; every item reports private/visibility, public_only filters client-side and reports filtered_count while total_count stays unfiltered. query: GitHub search syntax like stars:>100 language:rust; sort: stars/forks/help-wanted-issues/updated; order: asc/desc; page 1-based; per_page 1-100 default 20; fresh bypasses the cache.", signature: "query, sort?, order?, page?, per_page?, public_only?, fresh?" },
  github_search_code: { group: "Search", summary: "Code search across GitHub; requires a token, capped at 10 requests/minute and 1000 results. query: GitHub code search syntax like repo:owner/name logger; page 1-based; per_page 1-100 default 20; fresh bypasses the cache.", signature: "query, page?, per_page?, fresh?" },
  github_search_issues: { group: "Search", summary: "Issue and pull request search by GitHub query syntax; per-repository aggregate counts live in github_repo_health. query: syntax like is:issue state:open repo:owner/name; sort: comments/reactions/created/updated; order: asc/desc; page 1-based; per_page 1-100 default 20; fresh bypasses the cache.", signature: "query, sort?, order?, page?, per_page?, fresh?" },
  github_workflows: { group: "Actions", summary: "Actions workflow list for a repository, including disabled and legacy workflows. repo: owner/name; page 1-based; per_page 1-100 default 20; fresh bypasses the cache.", signature: "repo, page?, per_page?, fresh?" },
  github_workflow_runs: { group: "Actions", summary: "Workflow run list, repo-wide or per workflow. repo: owner/name; workflow_id: numeric workflow id, omit for all workflows; branch: branch filter; status: run status or conclusion as GitHub accepts it; event: event filter such as push or pull_request; page 1-based; per_page 1-100 default 20; fresh bypasses the cache.", signature: "repo, workflow_id?, branch?, status?, event?, page?, per_page?, fresh?" },
  github_workflow_run: { group: "Actions", summary: "One workflow run with branch, sha, status, and conclusion; optional jobs. repo: owner/name; run_id: numeric run id; include_jobs: true fetches up to 100 jobs with step conclusions; fresh bypasses the cache.", signature: "repo, run_id, include_jobs?, fresh?" },
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
