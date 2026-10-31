[English](README.md) | [简体中文](README.zh-CN.md)

# @kurvcygnus/github-fetcher

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520.18-blue)

AI coding agents spend much of their time reading GitHub, and this server makes that read path safe, cheap, and reliable. `@kurvcygnus/github-fetcher` is a read-only GitHub MCP server: it exposes 20 tools over stdio for reading repositories, files, commits, issues, pull requests, releases, repository health, Actions, and search results through the GitHub REST API. It reuses credentials you already have, routes around unreliable networks, caches responses on disk, and cannot modify anything.

## The problem

Agents read GitHub constantly (trees, files, issues, pull requests, CI), and direct access fails in ways that waste everyone's time:

- Anonymous REST access is capped at 60 requests per hour per IP, a budget shared by every tool on the machine.
- GitHub answers requests without a `User-Agent` header with 403, so bare scripts fail for a reason that is hard to spot.
- On networks where `raw.githubusercontent.com` is DNS-poisoned (common in mainland China), raw file fetches fail outright.
- Handing agents a write-scoped token for read-only work is a needless risk.
- Without a shared cache, every tool re-fetches the same content.

## What you get

- 20 read-only MCP tools over stdio: repositories, trees, files, commits, branches, issues, pull requests, releases, repository health, search, Actions runs, and a generic read-only GET escape hatch.
- Token reuse from the git credential store: the server reads what your git credential helper already holds (for example the GitHub CLI or Git Credential Manager), so no new secrets land on disk. `GITHUB_TOKEN` takes precedence, and with no token at all it falls back to anonymous access (60 requests per hour).
- Proxy routing built for hostile networks: in `auto` mode API requests go direct-first while `raw.githubusercontent.com` requests go proxy-first, with `always` and `direct` overrides. Proxy candidates are tried in order: `GITHUB_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, then your git proxy config.
- An ETag disk cache that survives restarts: entries inside their TTL are served locally, expired entries are revalidated cheaply with `If-None-Match`/`If-Modified-Since`, and a 304 answer reuses the stored body instead of downloading it again.
- Rate-limit handling: short windows (up to 15 seconds) are waited out once automatically, and long ones are reported with the exact reset time.

## Quick start

Add the matching entry to your client's MCP configuration.

OpenCode:

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

Claude Desktop, in `claude_desktop_config.json`:

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

## CLI

Every tool is also a subcommand of the same binary - useful for shell pipelines and for checking data without an agent in the loop.

    github-fetcher releases anomalyco/opencode --per-page 5 | jq -r ".items[].tag_name"
    github-fetcher health anthropics/claude-code --window-days 30 --pretty
    github-fetcher file KurvCygnus/github-fetcher README.md

- Bare `github-fetcher` (or `serve`) starts the MCP stdio server; a subcommand runs the CLI.
- Output is compact JSON on stdout (`--pretty` for humans); errors are JSON on stderr with exit codes: 2 usage, 3 rate limited, 4 auth, 5 not found, 6 network, 7 upstream.
- `--help` lists subcommands; `github-fetcher <subcommand> --help` shows one tool's flags.

## Security model

- Read-only by construction: the server issues only GET requests; GraphQL and write operations are not supported, and `github_api_get` accepts arbitrary read-only GET paths, host fixed to api.github.com.
- Only two hosts are ever contacted: `api.github.com` for API calls and `raw.githubusercontent.com` for raw bytes.
- Redirects are confined to GitHub origins: a redirect that leaves the original host is refused.
- Tokens appear only in the Authorization header, never in logs, errors, tool output, or the cache; cache keys use a SHA-256 hash of the token.
- Cache files are written with 0600 permissions (best effort) under the user's own cache directory.

## How it works

Every tool call becomes one GET against the GitHub REST API. A cache layer sits in front of it: entries younger than the endpoint TTL are served locally, expired entries are revalidated with ETag validators, and only successful responses are cached, so a not-found answer is never cached and surfaces as `not_found` every time. Every tool except `github_rate_limit` and `github_api_get` accepts a `fresh` option that bypasses the cache for a single request. Below the cache, the HTTP layer picks a route per request, retries transport failures, waits out short rate-limit windows, and refreshes a rejected token once before failing.

`stdio MCP → tool registry → GithubClient (ETag cache) → HttpClient (routing, proxy, retries) → GitHub REST`

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | unset | GitHub token, tried first. |
| `GH_TOKEN` | unset | Fallback token, used when `GITHUB_TOKEN` is not set. |
| `GITHUB_PROXY` | unset | Dedicated proxy URL (`http://` or `https://`), tried before the general proxy variables. |
| `GITHUB_PROXY_MODE` | `auto` | Proxy routing mode: `auto`, `always`, or `direct`. |
| `HTTPS_PROXY` | unset | General HTTPS proxy fallback. |
| `HTTP_PROXY` | unset | General HTTP proxy fallback, tried after `HTTPS_PROXY`. |
| `GITHUB_CACHE` | `disk` | Cache backend: `disk`, `memory`, or `off`. |
| `GITHUB_CACHE_DIR` | platform cache directory | Overrides the disk cache location. |
| `GITHUB_MCP_TIMEOUT_MS` | `30000` | Per-request timeout in milliseconds. |
| `GITHUB_MCP_MAX_FILE_BYTES` | `262144` | Maximum text length returned by content tools before truncation. |
| `GITHUB_MCP_LOG` | `error` | Parsed and validated; currently unused — warnings always go to stderr regardless of level. |

Invalid values are ignored with a warning on stderr and the default applies.

## Tool capabilities at a glance

Agents receive the full input schema for every tool via `tools/list`; this is a name-only map.

- Quota: `github_rate_limit`
- Repository: `github_repo`, `github_tree`, `github_file`, `github_commits`, `github_branches`
- Issues & pull requests: `github_issue`, `github_issues`, `github_pr`, `github_prs`
- Releases: `github_release`, `github_releases`
- Repo health: `github_repo_health`
- Search: `github_search_repos`, `github_search_code` (token required), `github_search_issues`
- Actions: `github_workflows`, `github_workflow_runs`, `github_workflow_run`
- Escape hatch: `github_api_get` (arbitrary read-only GET on api.github.com; GraphQL unsupported)

## Troubleshooting

| Symptom | Meaning | What to do |
| --- | --- | --- |
| 403/429 with `rate_limited` | The quota for this credential is exhausted | Call `github_rate_limit` and wait for the reset it reports |
| DNS or connection failures for raw.githubusercontent.com | The path to GitHub is unreliable on this network | Set `GITHUB_PROXY` or `HTTPS_PROXY` |
| `auth_missing` | The endpoint needs a token; `github_search_code` requires one | Set `GITHUB_TOKEN` or `GH_TOKEN` |
| `not_found` | The repository, ref, path, or release tag does not exist, or is private | Check `owner/name` and the ref |
| TLS errors | TLS interception (corporate MITM) or a broken proxy path | Point `GITHUB_PROXY` or `HTTPS_PROXY` at a working proxy, or try `GITHUB_PROXY_MODE=direct` |

## Development

- `npm test`: run the test suite
- `npm run typecheck`: strict TypeScript check
- `npm run build`: production build
- `npm run smoke`: spawns the built server over stdio and asserts that all 20 tools are listed
- `GITHUB_SMOKE=1 npm test`: runs the suite with `GITHUB_SMOKE` set; the variable is reserved and currently unused

## License

MIT. Copyright (c) 2026 Kurv Cygnus. See [LICENSE](LICENSE).
