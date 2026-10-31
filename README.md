# @kurvcygnus/github-fetcher

A read-only GitHub MCP server. It exposes 18 tools for reading repositories, files, commits, issues, pull requests, releases, Actions, and search results over the GitHub REST API. Authentication uses a personal access token when one is available, requests are routed through an optional HTTP proxy with automatic fallback for networks where GitHub is unreliable (for example raw.githubusercontent.com DNS pollution in China), and responses are cached on disk with ETag revalidation to stay well inside GitHub rate limits.

## Requirements

- Node.js >= 20.18
- npm (for `npx` installation)
- git (optional): lets the server reuse credentials already stored by your git credential helper, such as the GitHub CLI or Git Credential Manager

## Quick start with OpenCode

```json
{
  "mcp": {
    "github": {
      "type": "local",
      "command": ["npx", "-y", "@kurvcygnus/github-fetcher"],
      "enabled": true
    }
  }
}
```

## Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@kurvcygnus/github-fetcher"],
      "env": { "GITHUB_TOKEN": "ghp_your_token" }
    }
  }
}
```

## Cursor and VS Code

Cursor, in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@kurvcygnus/github-fetcher"]
    }
  }
}
```

VS Code, in `.vscode/mcp.json`:

```json
{
  "servers": {
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@kurvcygnus/github-fetcher"]
    }
  }
}
```

All four clients run the same command; add an `env` block with `GITHUB_TOKEN` where the client supports one, or export the variable in the shell the client launches from.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | unset | GitHub token, tried first. |
| `GH_TOKEN` | unset | Fallback token, used when `GITHUB_TOKEN` is not set. |
| `GITHUB_PROXY` | unset | Dedicated proxy URL (`http://` or `https://`), tried before the general proxy variables. |
| `GITHUB_PROXY_MODE` | `auto` | Proxy routing mode: `auto`, `always`, or `direct`. See Proxy support below. |
| `HTTPS_PROXY` | unset | General HTTPS proxy fallback. |
| `HTTP_PROXY` | unset | General HTTP proxy fallback, tried after `HTTPS_PROXY`. |
| `GITHUB_CACHE` | `disk` | Cache backend: `disk`, `memory`, or `off`. |
| `GITHUB_CACHE_DIR` | platform cache directory | Overrides the disk cache location. |
| `GITHUB_MCP_TIMEOUT_MS` | `30000` | Per-request timeout in milliseconds. |
| `GITHUB_MCP_MAX_FILE_BYTES` | `262144` | Maximum text length returned by content tools before truncation. |
| `GITHUB_MCP_LOG` | `error` | Log level written to stderr: `error`, `info`, or `debug`. |

Invalid values are ignored with a warning on stderr and the default applies.

## Authentication

The server resolves a token in this order:

1. `GITHUB_TOKEN`
2. `GH_TOKEN`
3. `git credential fill` for `github.com`, which reuses whatever your git credential helper has stored (for example the GitHub CLI or Git Credential Manager)
4. Anonymous access, limited by GitHub to 60 requests per hour per IP

With a token, limits follow your account plan (5,000 requests per hour for most plans). `github_search_code` requires a token: under anonymous access it returns the `auth_missing` error. If GitHub rejects the token (401), the server refreshes the credential once and retries before reporting `auth_failed`. Tokens are never printed to logs, errors, or tool output.

## Proxy support

Proxy candidates are tried in order until one is configured: `GITHUB_PROXY`, then `HTTPS_PROXY`, then `HTTP_PROXY`, then the git config value `http.https://github.com.proxy`, then a direct connection.

`GITHUB_PROXY_MODE` controls how the chosen proxy is used:

- `auto` (default): API requests to api.github.com try the direct connection first and fall back to the proxy; requests to raw.githubusercontent.com try the proxy first and fall back to direct. This suits networks where the API is reachable but raw file downloads are not.
- `always`: every request goes through the proxy first, with direct as fallback.
- `direct`: the proxy is ignored and every request is direct.

Routing is a fixed order with automatic fallback on transport failure. The server does no port probing and opens no extra listeners. Invalid proxy URLs are rejected with a warning and skipped, as if unset.

## Cache behavior

- Backends: `GITHUB_CACHE=disk` (default) stores entries under the platform cache directory (`%LOCALAPPDATA%\github-fetcher\cache` on Windows, `~/Library/Caches/github-fetcher/cache` on macOS, `$XDG_CACHE_HOME/github-fetcher/cache` or `~/.cache/github-fetcher/cache` elsewhere); `memory` keeps entries for the current process only; `off` disables caching. `GITHUB_CACHE_DIR` overrides the disk location.
- Keys are scoped to the credential: the cache key is derived from the request URL and a hash of the token, so different credentials never share cached bodies.
- Fresh entries (younger than the endpoint TTL) are served without a network request. Expired entries are revalidated with `ETag`/`If-None-Match` and `Last-Modified`/`If-Modified-Since`; a 304 answer reuses the stored body without downloading it again.
- TTLs per endpoint: workflow runs and jobs 60 seconds; commit, branch, issue, and pull request listings 120 seconds; file contents, search results, and workflow listings 300 seconds; repository metadata, trees, and releases 600 seconds. Only successful responses are cached; a not-found answer is never cached and surfaces as a `not_found` error every time.
- Every tool except `github_rate_limit` and `github_api_get` accepts `fresh: true` to bypass the cache entirely for that request.
- Disk entries are written with 0600 permissions (best effort) and pruned after 7 days, keeping the newest entries.

## Tools

`repo` is always `owner/name`. Every tool except `github_rate_limit` and `github_api_get` accepts an optional `fresh` boolean to bypass the cache. Read tools that page accept `page` (1-based) and `per_page` (1-100).

| Tool | Required arguments | Description |
| --- | --- | --- |
| `github_rate_limit` | none | Report the API quota and reset times per resource; call this first when a request is refused with 403 or 429. |
| `github_repo` | `repo` | Repository metadata: description, default branch, stars, forks, open issues, language, license, topics, and timestamps. |
| `github_tree` | `repo` | List files and directories at a ref with the git trees API; `path` selects a subdirectory, `recursive` returns the whole tree. |
| `github_file` | `repo`, `path` | Read one file at a ref as UTF-8 text; binary files are reported with `binary: true` instead of content. |
| `github_commits` | `repo` | List commits on a ref, filterable by `path`, `author`, and `since`/`until` date range; returns short sha, message, author, and date. |
| `github_branches` | `repo` | List branches with their head sha and protection state. |
| `github_issue` | `repo`, `number` | Read one issue or pull request with labels and assignees; `include_comments` adds the latest 20 comments in chronological order. |
| `github_issues` | `repo` | List issues and pull requests with `state`, `labels`, sort, and direction filters; each item carries `type: "issue"` or `type: "pr"`. |
| `github_pr` | `repo`, `number` | Read one pull request with branches, stats, and mergeability; `include_files` adds up to 100 changed files with patches. |
| `github_prs` | `repo` | List pull requests with `state`, `base`, `head`, sort, and direction filters. |
| `github_release` | `repo` | Read the latest release, or the release for `tag`, including assets and download URLs. |
| `github_search_repos` | `query` | Search repositories with GitHub search syntax; sorting by stars, forks, help-wanted-issues, or updated. |
| `github_search_code` | `query` | Search code across GitHub; requires a token (10 requests per minute, results capped at 1,000 by GitHub). |
| `github_search_issues` | `query` | Search issues and pull requests with syntax such as `is:issue`, `is:pr`, `state:open`, or `repo:owner/name`. |
| `github_workflows` | `repo` | List GitHub Actions workflows, including disabled ones. |
| `github_workflow_runs` | `repo` | List workflow runs for the repository or one `workflow_id`, filterable by `branch`, `status`, and `event`. |
| `github_workflow_run` | `repo`, `run_id` | Read one workflow run; `include_jobs` adds up to 100 jobs with their step statuses. |
| `github_api_get` | `path` | Escape hatch for read-only REST GET requests the dedicated tools do not cover; the host is fixed to api.github.com, and GraphQL and writes are not supported. |

## Pagination and truncation

Listing tools return `items`, `page`, `per_page`, `has_more`, and `next_page`; search tools additionally return `total_count` and `incomplete_results`. Follow `next_page` until `has_more` is false. `per_page` defaults to 20 and is capped at 100.

Text bodies are clipped to `GITHUB_MCP_MAX_FILE_BYTES` characters (262,144 by default) and flagged with `truncated: true`; this applies to file contents, issue and pull request bodies, comments, release notes, and `github_api_get` responses. A pull request's per-file patches are clipped to 4,000 characters, and `files_truncated` reports when more than 100 files changed. `github_issue` returns the latest 20 comments and sets `comments_truncated` when older ones exist. Very large trees can be truncated by GitHub itself, reported by the `truncated` field of `github_tree`.

## Troubleshooting

| Symptom | Meaning | What to do |
| --- | --- | --- |
| 403 or 429 with `rate_limited` | The GitHub quota for this credential is exhausted | Call `github_rate_limit` for the reset time, wait for the reset, or authenticate to raise the limit |
| DNS or connection failures for raw.githubusercontent.com | Common on networks where that host is unreliable | Set `GITHUB_PROXY` so raw requests go through the proxy first in `auto` mode, or use `GITHUB_PROXY_MODE=always` |
| `auth_missing` | No token was found and the endpoint requires one (`github_search_code`) | Set `GITHUB_TOKEN` or `GH_TOKEN`, or store a github.com credential with your git credential helper |
| `auth_failed` | The token was rejected (401) | Check the token value and expiry, and confirm it still grants access |
| `not_found` | The repository, ref, path, or release tag does not exist, or is private | Verify `owner/name` and the ref; private repositories need a token with access |
| TLS errors | TLS interception or a broken proxy path | Point `GITHUB_PROXY` or `HTTPS_PROXY` at a working proxy, or try `GITHUB_PROXY_MODE=direct` |

## Security and privacy

- Read-only: the server issues only GET requests. GraphQL and write operations are not supported, and `github_api_get` accepts only fixed API paths.
- Fixed hosts: API requests can only reach api.github.com and raw bytes only raw.githubusercontent.com; redirects that leave the original host are refused.
- No token in logs: tokens never appear in logs, errors, or tool output; cache keys use a hash of the token instead of the token itself.
- Cache files are written with 0600 permissions (best effort) under the user's own cache directory.

## Development

- `npm test`: run the test suite
- `npm run typecheck`: run the strict TypeScript check
- `npm run build`: compile the production build
- `npm run smoke`: start the built server over stdio, initialize, and verify that all 18 tools are listed
- `GITHUB_SMOKE=1 npm test`: run the test suite with `GITHUB_SMOKE` set; the variable is reserved and currently unused by the suite

## License

MIT. See LICENSE.
