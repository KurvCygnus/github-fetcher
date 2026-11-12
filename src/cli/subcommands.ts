export type FlagKind = "string" | "number" | "boolean" | "string-array";

export interface SubcommandSpec {
  tool: string;
  //? Slots without required: false must be filled; optional slots may stay absent so the
  //? handler's own default applies (github_release's tag: omit for the latest release).
  //? A string-array slot is variadic: it consumes every following non-flag token, so it must
  //? be the last positional in its spec.
  positional: Array<{ key: string; kind: "string" | "number" | "string-array"; required?: boolean }>;
  flags: Record<string, FlagKind>;
}

const REPO_FRESH = { fresh: "boolean" } satisfies Record<string, FlagKind>;

//? satisfies (not a Record annotation): dot access in tests and usage stays concrete, while
//? string-keyed lookups go through subcommandSpec below, the only place that casts to Record.
export const SUBCOMMANDS = {
  capabilities: { tool: "github_capabilities", positional: [], flags: { group: "string" } },
  rate: { tool: "github_rate_limit", positional: [], flags: { resource: "string", all: "boolean" } },
  repo: { tool: "github_repo", positional: [{ key: "repo", kind: "string" }], flags: { ...REPO_FRESH } },
  repos: { tool: "github_repos", positional: [{ key: "repos", kind: "string-array" }], flags: { ...REPO_FRESH } },
  tree: { tool: "github_tree", positional: [{ key: "repo", kind: "string" }], flags: { ref: "string", path: "string", recursive: "boolean", "max-entries": "number", "summary-only": "boolean", ...REPO_FRESH } },
  file: { tool: "github_file", positional: [{ key: "repo", kind: "string" }, { key: "path", kind: "string" }], flags: { ref: "string", "start-line": "number", "end-line": "number", "max-bytes": "number", ...REPO_FRESH } },
  readme: { tool: "github_readme", positional: [{ key: "repo", kind: "string" }], flags: { ...REPO_FRESH } },
  commits: { tool: "github_commits", positional: [{ key: "repo", kind: "string" }], flags: { ref: "string", path: "string", author: "string", since: "string", until: "string", page: "number", "per-page": "number", ...REPO_FRESH } },
  branches: { tool: "github_branches", positional: [{ key: "repo", kind: "string" }], flags: { page: "number", "per-page": "number", ...REPO_FRESH } },
  "compare-refs": { tool: "github_compare_refs", positional: [{ key: "repo", kind: "string" }, { key: "base", kind: "string" }, { key: "head", kind: "string" }], flags: { ...REPO_FRESH } },
  issue: { tool: "github_issue", positional: [{ key: "repo", kind: "string" }, { key: "number", kind: "number" }], flags: { "include-comments": "boolean", "comment-limit": "number", "max-comment-chars": "number", ...REPO_FRESH } },
  issues: { tool: "github_issues", positional: [{ key: "repo", kind: "string" }], flags: { state: "string", type: "string", labels: "string", sort: "string", direction: "string", since: "string", page: "number", "per-page": "number", ...REPO_FRESH } },
  pr: { tool: "github_pr", positional: [{ key: "repo", kind: "string" }, { key: "number", kind: "number" }], flags: { "include-files": "boolean", ...REPO_FRESH } },
  prs: { tool: "github_prs", positional: [{ key: "repo", kind: "string" }], flags: { state: "string", base: "string", head: "string", sort: "string", direction: "string", page: "number", "per-page": "number", ...REPO_FRESH } },
  release: { tool: "github_release", positional: [{ key: "repo", kind: "string" }, { key: "tag", kind: "string", required: false }], flags: { ...REPO_FRESH } },
  releases: { tool: "github_releases", positional: [{ key: "repo", kind: "string" }], flags: { page: "number", "per-page": "number", "include-prereleases": "boolean", ...REPO_FRESH } },
  health: { tool: "github_repo_health", positional: [{ key: "repo", kind: "string" }], flags: { "window-days": "number", labels: "string-array", ...REPO_FRESH } },
  "compare-repos": { tool: "github_compare_repos", positional: [{ key: "repos", kind: "string-array" }], flags: { "window-days": "number", ...REPO_FRESH } },
  user: { tool: "github_user", positional: [{ key: "user", kind: "string" }], flags: {} },
  "user-repos": { tool: "github_user_repos", positional: [{ key: "user", kind: "string" }], flags: { type: "string", sort: "string", order: "string", page: "number", "per-page": "number", ...REPO_FRESH } },
  "user-starred": { tool: "github_user_starred", positional: [{ key: "user", kind: "string" }], flags: { page: "number", "per-page": "number", ...REPO_FRESH } },
  "user-events": { tool: "github_user_events", positional: [{ key: "user", kind: "string" }], flags: { page: "number", "per-page": "number", ...REPO_FRESH } },
  contributors: { tool: "github_contributors", positional: [{ key: "repo", kind: "string" }], flags: { page: "number", "per-page": "number", ...REPO_FRESH } },
  languages: { tool: "github_languages", positional: [{ key: "repo", kind: "string" }], flags: { ...REPO_FRESH } },
  "repo-activity": { tool: "github_repo_activity", positional: [{ key: "repo", kind: "string" }], flags: { "window-days": "number", ...REPO_FRESH } },
  "search-repos": { tool: "github_search_repos", positional: [{ key: "query", kind: "string" }], flags: { sort: "string", order: "string", page: "number", "per-page": "number", "public-only": "boolean", ...REPO_FRESH } },
  "search-code": { tool: "github_search_code", positional: [{ key: "query", kind: "string" }], flags: { page: "number", "per-page": "number", ...REPO_FRESH } },
  "search-issues": { tool: "github_search_issues", positional: [{ key: "query", kind: "string" }], flags: { sort: "string", order: "string", page: "number", "per-page": "number", ...REPO_FRESH } },
  "search-users": { tool: "github_search_users", positional: [{ key: "query", kind: "string" }], flags: { sort: "string", order: "string", page: "number", "per-page": "number", ...REPO_FRESH } },
  workflows: { tool: "github_workflows", positional: [{ key: "repo", kind: "string" }], flags: { page: "number", "per-page": "number", ...REPO_FRESH } },
  "workflow-runs": { tool: "github_workflow_runs", positional: [{ key: "repo", kind: "string" }], flags: { "workflow-id": "number", branch: "string", status: "string", event: "string", page: "number", "per-page": "number", ...REPO_FRESH } },
  "workflow-run": { tool: "github_workflow_run", positional: [{ key: "repo", kind: "string" }, { key: "run_id", kind: "number" }], flags: { "include-jobs": "boolean", ...REPO_FRESH } },
  api: { tool: "github_api_get", positional: [{ key: "path", kind: "string" }], flags: { query: "string-array", fresh: "boolean" } },
  doctor: { tool: "github_doctor", positional: [], flags: {} },
} satisfies Record<string, SubcommandSpec>;

//? noUncheckedIndexedAccess types every Record<string, _> read as possibly undefined, and
//? TypeScript cannot express "may be absent" without it; funnel all string lookups through
//? this single typed view instead of casting at each call site.
const SPECS_BY_NAME: Record<string, SubcommandSpec> = SUBCOMMANDS;

export function subcommandSpec(name: string | undefined): SubcommandSpec | undefined {
  return name === undefined ? undefined : SPECS_BY_NAME[name];
}

export function usageFor(subcommand: string | undefined): string {
  const spec = subcommandSpec(subcommand);
  if (spec && subcommand !== undefined) {
    const positionals = spec.positional
      .map((slot) => {
        const label = slot.kind === "string-array" ? `${slot.key}...` : slot.key;
        return slot.required === false ? `[${label}]` : `<${label}>`;
      })
      .join(" ");
    const flags = Object.keys(spec.flags).map((key) => `--${key}`).join(" ");
    return `github-fetcher ${subcommand} ${positionals}\n  tool: ${spec.tool}\n  flags: ${flags || "(none)"}\n`;
  }
  //? init/remove are config management, not tools: they never appear in tools/list, so their
  //? rows are spelled out here instead of coming from the SUBCOMMANDS table.
  const lines = [
    ...Object.entries(SUBCOMMANDS).map(([name, entry]) => `  ${name.padEnd(15)} ${entry.tool}`),
    `  ${"init".padEnd(15)} configure MCP clients interactively (TUI; --client/--all/--dry-run)`,
    `  ${"remove".padEnd(15)} remove the github entry from configured clients.`,
  ];
  return [
    "Usage: github-fetcher [serve | <subcommand> ...]",
    "",
    "Bare invocation (or `serve`) starts the MCP stdio server.",
    "Top-level flags: --help, --version.",
    "",
    "Subcommands:",
    ...lines,
    "",
    "Flags are kebab-case schema keys; flag arrays are comma-separated; booleans are bare.",
    "Positional list arguments take one value per argument.",
    "Output is compact JSON on stdout; errors go to stderr as JSON with family exit codes.",
  ].join("\n") + "\n";
}
