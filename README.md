[English](https://github.com/KurvCygnus/github-fetcher/blob/main/README.md) | [简体中文](https://github.com/KurvCygnus/github-fetcher/blob/main/README.zh-CN.md)

# @kurvcygnus/github-fetcher

[![npm version](https://img.shields.io/npm/v/@kurvcygnus/github-fetcher.svg)](https://www.npmjs.com/package/@kurvcygnus/github-fetcher)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.19-blue)
[![M8ven Trust](https://m8ven.ai/badge/mcp/kurvcygnus/github-fetcher)](https://m8ven.ai/mcp/kurvcygnus/github-fetcher?s=readme)

`@kurvcygnus/github-fetcher` is a read-only GitHub MCP server with 44 tools, one-command client setup, an optional single-process loopback daemon, and honest quota and cost metadata. It reuses the credentials you already have, survives hostile networks, caches responses on disk, and cannot modify anything.

## Why this server

- **Read-only by construction.** Every tool issues GET requests only. The official server exposes write tools and needs `--read-only` to remove them.
- **No token in client config.** `init` writes entries without secrets; credentials come from your git credential store or environment. The official local server asks for a PAT or an OAuth login per host.
- **Built for hostile networks.** Direct API first, proxy fallback for both API and raw bytes, ETag disk cache, bounded retries. No Docker or Go toolchain required.
- **One local process for every session.** The optional loopback daemon serves many MCP sessions from one Node process with isolated credentials and pins; stdio clients keep working unchanged. The official local server runs one process per stdio client, or you move to its hosted remote server.
- **One command configures the clients you have.** `init` detects eight clients, previews paths, backs up every file it edits, and writes only after you confirm. The official docs provide per-host snippets and install buttons.
- **Costs and limits are visible.** Every response carries cache and quota metadata; byte caps and timeouts make truncation explicit instead of silent.
- **Search investigations stay in one toolset.** Repo, user, code, and issue search sit next to label discovery, repo health, release diffs, and bounded cross-repo snapshots, so an agent can triangulate a question with a few calls instead of stitching raw endpoints by hand.

## Built for mainland China networks

GitHub's anonymous REST quota is **60 requests per hour per egress IP**, shared by every tool on the machine. `raw.githubusercontent.com` is frequently DNS-poisoned, and bare HTTP clients that omit `User-Agent` get a 403. This server is built around those failures:

- Reuses the token already in your git credential store; `GITHUB_TOKEN` and `GH_TOKEN` override it.
- Tries `api.github.com` directly first, then your proxy. File reads use the contents API for metadata and inline content, then fetch `raw.githubusercontent.com` through the proxy when GitHub omits the inline body.
- Retries transport failures twice per route, waits out rate-limit windows up to 15 seconds, and reports the exact reset time for longer ones.
- Caches successful responses on disk with ETag revalidation, so repeated reads do not spend quota.

Outside mainland China the same defaults still work; set `GITHUB_PROXY_MODE=direct` to skip proxy attempts entirely.

## Quick start

Run one command and follow the wizard:

    npx -y @kurvcygnus/github-fetcher@latest init

The wizard writes the MCP entry for eight supported clients and backs up every file it edits. Existing entries that already point at this package are updated in place. Stdio needs no further setup. For an HTTP client, start the daemon once:

    github-fetcher daemon start

After a global install (`npm i -g @kurvcygnus/github-fetcher`), the short alias `ghf` is available too. Every tool is also a CLI subcommand, so you can inspect data without an agent:

    ghf labels facebook/react --per-page 100 --with-counts
    ghf release-diff facebook/react v19.3.0 v19.3.1 --include-commits
    ghf batch-activity oven-sh/bun denoland/deno nodejs/node --window-days 30 --top-n 5

A manual client entry is available in the appendix at the end of this document.

## Agent workflows

These short paths show what the tools are for. The same calls work over MCP and as CLI subcommands.

**Triage a repository.** List real label names with `github_labels`, then pass an exact label to `github_issues` and inspect a specific report with `github_issue`. `github_repo_health` adds issue, pull request, and release counts for a window.

**Reconstruct a release.** `github_release_diff` returns the changed files and commit list between two refs in one call. Use `github_commit` when one commit needs its full patch and file list, and `github_releases` to find the tags worth comparing.

**Compare projects.** `github_batch_activity` produces a bounded snapshot for several repositories at once, including open issue and pull request counts, recent commits, CI conclusions, and top contributor share. `github_compare_repos` covers broader repository metadata comparison.

**Read code safely.** `github_tree` clips large trees at the byte level and accepts `glob` and `path_prefix`. `github_file` and `github_files` respect per-call byte budgets, and `github_file_grep` runs bounded regex matching in a worker. Pin a repository with `github_pin_ref` to anchor a whole investigation to one commit.

## Transports and session model

Stdio is the default transport and needs no configuration. Clients that use HTTP connect to the loopback daemon, which serves the same 44 tools on `http://127.0.0.1:41873/mcp` by default. Set `GITHUB_MCP_DAEMON_PORT` to change the port.

    github-fetcher daemon start
    github-fetcher daemon status
    github-fetcher daemon stop

`daemon start` is idempotent. It writes a state file and a sibling token file under `<user config dir>/github-fetcher/`; `daemon stop` posts to the stop endpoint and removes both files. `daemon status` reports pid, port, version, session count, and uptime. Every request to `/mcp`, `/health`, and `POST /daemon/stop` requires `Authorization: Bearer <token>`.

`github-fetcher init --transport http` starts the daemon and writes an OpenCode remote MCP entry that reads the bearer token from the token file, so the secret never lands in client configuration. Other adapters have no remote entry and are skipped with a warning.

Credentials and ref pins are per session. One session's token or pin never leaks into another; all other settings come from the daemon environment.

## CLI

Every tool is a subcommand of the same binary. Output is compact JSON on stdout, with `--pretty` for humans; errors are JSON on stderr with exit codes 2 usage, 3 rate limited, 4 auth, 5 not found, 6 network, and 7 upstream. Use `--help` for the subcommand list and `<subcommand> --help` for one tool's flags.

`init` and `remove` manage client configuration. `init` accepts `--client id,id`, `--all`, `--dry-run`, and `--name`; `remove` accepts `--client`, `--all`, and `--name`. Both back up files before writing and print one JSON result array on stdout. Interactive prompts go to stderr. Supported clients: `opencode`, `claude-desktop`, `claude-code`, `cursor`, `vscode`, `gemini`, `windsurf`, `codex`. ZCode is intentionally unsupported.

## Tool capabilities at a glance

Agents receive the full input schema for every tool through `tools/list`. `github_capabilities` carries the same facts as derived input rows, so the index and the schema cannot drift apart. These groups match the index returned by that tool.

- Meta: `github_capabilities`, `github_rate_limit`, `github_api_get`, `github_doctor`, `github_pin_ref` — capability index with group filtering, quota projection, the guarded GET escape hatch, self-diagnostics, and session pinning.
- Repository: `github_repo`, `github_repos`, `github_compare_refs`, `github_branches`, `github_languages`, `github_contributors`, `github_repo_activity`, `github_stargazers` — repository metadata, batched lookup, ref and repository comparison, language and contributor breakdowns, windowed activity, and star timelines.
- User: `github_user`, `github_user_repos`, `github_user_starred`, `github_user_events`, `github_user_health` — profiles, repositories, stars, public events, and a one-call user audit.
- Files: `github_tree`, `github_file`, `github_readme`, `github_file_grep`, `github_files` — byte-clipped trees with glob filtering, ranged file reads, README resolution, bounded regex search, and batch reads.
- History: `github_commits`, `github_commit` — oldest-first or newest-first commit walks with message limits, plus single-commit detail with bounded patches.
- Collaboration: `github_issue`, `github_issues`, `github_pr`, `github_prs`, `github_labels` — issues, pull requests, and exact label discovery for filters.
- Releases: `github_release`, `github_releases`, `github_release_diff` — single releases, release lists, and two-ref diffs with bounded patches and commit projection.
- Snapshot: `github_repo_health`, `github_compare_repos`, `github_batch_activity` — health checks, throttled broad comparison, and bounded cross-repository activity snapshots.
- Search: `github_search_repos`, `github_search_code`, `github_search_users`, `github_search_issues`, `github_trending` — repository, code, user, and issue search with honest projections, plus a search-derived trend lens.
- Actions: `github_workflows`, `github_workflow_runs`, `github_workflow_run` — workflow definitions, runs, and a single run with jobs.

## Comparison with the official server

The official `github/github-mcp-server` is the right choice for a general-purpose GitHub MCP server with write tools or remote hosting. This project makes a narrower trade-off:

| Capability | GitHub Fetcher | Official github-mcp-server |
| --- | --- | --- |
| Always read-only | Yes | Read-only mode is opt-in; write tools are available |
| Local stdio | Yes | Yes |
| Remote hosted option | No | Yes |
| Auth | Reuses git credential; `GITHUB_TOKEN`/`GH_TOKEN` | PAT, OAuth, or GitHub App |
| Raw/proxy fallback for China | Yes | No China-specific routing |
| ETag disk cache | Yes | No built-in ETag cache |
| One-command multi-client setup | Yes | No built-in wizard |

Official-server facts were checked against its README on 2026-11-01.

## Security model

- Read-only by construction: the server issues only GET requests. GraphQL and write operations are unsupported, and `github_api_get` accepts arbitrary read-only GET paths only when `ihaveto: true` acknowledges that no dedicated tool covers the endpoint.
- Only two hosts are contacted: `api.github.com` for API calls and `raw.githubusercontent.com` for raw bytes.
- Redirects are confined to GitHub origins; a redirect that leaves the original host is refused.
- Tokens appear only in the Authorization header, never in logs, errors, tool output, or the cache. Cache keys use a SHA-256 hash of the token.
- Cache files are written with 0600 permissions on a best-effort basis under the user's own cache directory.
- Identity is private by default. `GITHUB_MCP_EXPOSE_IDENTITY` opts `github_rate_limit` and `github_doctor` into `authenticated_as` and `scopes`; the token and its fingerprint are never returned either way.

## How it works

Every tool call becomes one GET against the GitHub REST API.

- Success results carry `structuredContent` only and keep `content` empty, so text-only clients do not pay for a duplicated rendering. Error results mirror the same compact JSON in `structuredContent` and a `content` text block.
- A cache layer serves fresh entries locally, revalidates expired entries with ETag validators, and never caches a not-found answer. Every API-reading tool accepts `fresh` for a single bypass.
- Every network-backed response ends with `meta: {cache, age_s, quota}`. The optional `calls` field counts client invocations, including cache hits and internal ref resolution; a warm cache hit still reports `calls: 1`. Quota consumption comes from GitHub's used counter.
- `github_pin_ref` pins a repository to a commit sha in memory for the session. Anchored reads echo `pinned_sha`; an explicit `ref` suppresses it. `github_doctor` lists the session's pinned repositories in `pinned_repos`.
- Below the cache, the HTTP layer selects a route per request, retries transport failures, waits out short rate-limit windows, and refreshes a rejected token once before failing.

`stdio or loopback HTTP MCP → tool registry → GithubClient (ETag cache) → HttpClient (routing, proxy, retries) → GitHub REST`

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | unset | GitHub token, tried first. |
| `GH_TOKEN` | unset | Fallback token when `GITHUB_TOKEN` is unset. |
| `GITHUB_PROXY` | unset | Dedicated proxy URL (`http://` or `https://`), tried before general proxy variables. |
| `GITHUB_PROXY_MODE` | `auto` | Proxy routing: `auto`, `always`, or `direct`. |
| `HTTPS_PROXY` | unset | General HTTPS proxy fallback. |
| `HTTP_PROXY` | unset | General HTTP proxy fallback, tried after `HTTPS_PROXY`. |
| `GITHUB_CACHE` | `disk` | Cache backend: `disk`, `memory`, or `off`. |
| `GITHUB_CACHE_DIR` | platform cache directory | Overrides the disk cache location. |
| `GITHUB_MCP_DAEMON_PORT` | `41873` | Loopback daemon port. |
| `GITHUB_MCP_TIMEOUT_MS` | `30000` | Per-request timeout in milliseconds. |
| `GITHUB_MCP_GREP_TIMEOUT_MS` | `2000` | Time budget for regex matching; overruns return `matches_truncated`. |
| `GITHUB_MCP_MAX_FILE_BYTES` | `262144` | Response text byte ceiling before truncation; per-call `max_bytes` caps it further. |
| `GITHUB_MCP_EXPOSE_IDENTITY` | unset | `1`/`true`/`yes`/`on` opts identity fields into rate-limit and doctor output. |
| `GITHUB_MCP_LOG` | `error` | Parsed and validated; currently unused. Warnings always go to stderr. |

Invalid values are ignored with a warning on stderr and the default applies.

## Limitations

- Read-only by design: no writes, no GraphQL, no clone or archive tools.
- 44 tools cover a broad read path, but this is not a complete GitHub API client. Use `github_api_get` with `ihaveto: true` for endpoints no dedicated tool covers.
- Anonymous access is 60 requests per hour; code search requires a token.
- No proxy is bundled; bring your own HTTP(S) proxy.
- The cache stores response bodies on disk; avoid it on a shared account if that is unacceptable.

## Troubleshooting

| Symptom | Meaning | What to do |
| --- | --- | --- |
| 403/429 with `rate_limited` | The quota for this credential is exhausted | Call `github_rate_limit` and wait for the reset it reports |
| DNS or connection failures for raw or API hosts | The path to GitHub is unreliable on this network | Set `GITHUB_PROXY` or `HTTPS_PROXY` |
| `auth_missing` | The endpoint needs a token; code search requires one | Set `GITHUB_TOKEN` or `GH_TOKEN` |
| `not_found` | The repository, ref, path, or release tag does not exist, or is private | Check `owner/name` and the ref |
| TLS errors | TLS interception or a broken proxy path | Point `GITHUB_PROXY` or `HTTPS_PROXY` at a working proxy, or try `GITHUB_PROXY_MODE=direct` |

## Manual client setup

`init` handles all supported clients. For a manual entry, the canonical stdio form for OpenCode is:

```json
{
  "mcp": {
    "github": {
      "type": "local",
      "command": ["npx", "-y", "@kurvcygnus/github-fetcher@latest"],
      "enabled": true
    }
  }
}
```

Other clients use their own top-level MCP key with the same command and arguments. Run `github-fetcher init --dry-run` to see the exact entries for the clients installed on your machine.

## Development

- `npm test`: run the test suite
- `npm run typecheck`: strict TypeScript check
- `npm run build`: production build
- `npm run smoke`: start the built server over stdio and assert that all 44 tools are listed
- `npm run verify:launch`: check release metadata and README consistency

## License

MIT. Copyright (c) 2026 Kurv Cygnus. See [LICENSE](LICENSE).
