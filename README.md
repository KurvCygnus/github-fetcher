[English](https://github.com/KurvCygnus/github-fetcher/blob/main/README.md) | [简体中文](https://github.com/KurvCygnus/github-fetcher/blob/main/README.zh-CN.md)

# @kurvcygnus/github-fetcher

[![npm version](https://img.shields.io/npm/v/@kurvcygnus/github-fetcher.svg)](https://www.npmjs.com/package/@kurvcygnus/github-fetcher)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.19-blue)
[![M8ven Trust](https://m8ven.ai/badge/mcp/kurvcygnus/github-fetcher)](https://m8ven.ai/mcp/kurvcygnus/github-fetcher?s=readme)

AI coding agents spend much of their time reading GitHub, and this server makes that read path safe, cheap, and reliable. `@kurvcygnus/github-fetcher` is a read-only GitHub MCP server: it exposes 41 tools over stdio for reading repositories, users, files, commits, issues, pull requests, releases, repository health and activity, side-by-side repository and ref comparison, its own capability index and diagnostics, Actions, and search results through the GitHub REST API. It reuses credentials you already have, routes around unreliable networks, caches responses on disk, and cannot modify anything.

## Built for mainland China networks

GitHub's anonymous REST quota is **60 requests per hour per egress IP**, shared by every tool on the machine. `raw.githubusercontent.com` is frequently DNS-poisoned, and bare HTTP clients that omit `User-Agent` get a 403. This server is built around those failures:

- Reuses the token already in your git credential store; `GITHUB_TOKEN`/`GH_TOKEN` override it.
- Tries `api.github.com` directly first, then your proxy. File reads use the contents API for metadata and inline content, then fetch `raw.githubusercontent.com` through the proxy when GitHub omits the inline body.
- Retries transport failures twice per route, waits out rate-limit windows up to 15 seconds, and reports the exact reset time for longer ones.
- Caches successful responses on disk with ETag revalidation, so repeated reads do not spend quota.

If you are outside mainland China, the same defaults still work; set `GITHUB_PROXY_MODE=direct` to skip proxy attempts entirely.

## The problem

Agents read GitHub constantly (trees, files, issues, pull requests, CI), and direct access fails in ways that waste everyone's time:

- Anonymous REST access is capped at 60 requests per hour per IP, a budget shared by every tool on the machine.
- GitHub answers requests without a `User-Agent` header with 403, so bare scripts fail for a reason that is hard to spot.
- On networks where `raw.githubusercontent.com` is DNS-poisoned (common in mainland China), raw file fetches fail outright.
- Handing agents a write-scoped token for read-only work is a needless risk.
- Without a shared cache, every tool re-fetches the same content.

## What you get

- 41 read-only MCP tools over stdio: repositories, users, trees, files, commits, branches, issues, pull requests, releases, repository health and activity, side-by-side repository and ref comparison, user profiles, stars, and events, a capability discovery index with a self-diagnostic, search, Actions runs, and a generic read-only GET escape hatch.
- Token reuse from the git credential store: the server reads what your git credential helper already holds (for example the GitHub CLI or Git Credential Manager), so no new secrets land on disk. `GITHUB_TOKEN` takes precedence, and with no token at all it falls back to anonymous access (60 requests per hour).
- Proxy routing built for hostile networks: in `auto` mode API requests go direct-first while `raw.githubusercontent.com` requests go proxy-first, with `always` and `direct` overrides. Proxy candidates are tried in order: `GITHUB_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, then your git proxy config.
- An ETag disk cache that survives restarts: entries inside their TTL are served locally, expired entries are revalidated cheaply with `If-None-Match`/`If-Modified-Since`, and a 304 answer reuses the stored body instead of downloading it again.
- Rate-limit handling: short windows (up to 15 seconds) are waited out once automatically, and long ones are reported with the exact reset time.
- Client setup built in: `github-fetcher init` writes the MCP entry for eight clients and backs up every file it edits; `github-fetcher remove` undoes it.

## Comparison with the official server

The official `github/github-mcp-server` is the right choice when you need a general-purpose GitHub MCP server with write tools or remote hosting. This project makes a narrower trade-off:

| Capability | GitHub Fetcher | Official github-mcp-server |
| --- | --- | --- |
| Always read-only | Yes | Read-only mode is opt-in; write tools are available |
| Local stdio | Yes | Yes |
| Remote hosted option | No | Yes |
| Auth | Reuses git credential; `GITHUB_TOKEN`/`GH_TOKEN` | PAT, OAuth, or GitHub App |
| Raw/proxy fallback for China | Yes | No China-specific routing |
| ETag disk cache | Yes | No built-in ETag cache |

Official-server facts were checked against its README on 2026-11-01.

## Quick start

The fastest path is one command:

    npx -y @kurvcygnus/github-fetcher@latest init

`init` detects the supported clients, reuses an existing entry that already points at this package, and backs up every file it changes. The manual entries below are the reference form.

Add the matching entry to your client's MCP configuration.

OpenCode:

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

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@kurvcygnus/github-fetcher@latest"],
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
      "args": ["-y", "@kurvcygnus/github-fetcher@latest"]
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
      "args": ["-y", "@kurvcygnus/github-fetcher@latest"]
    }
  }
}
```

All four clients run the same command; add an `env` block with `GITHUB_TOKEN` where the client supports one, or export the variable in the shell the client launches from.

## CLI

Every tool is also a subcommand of the same binary - useful for shell pipelines and for checking data without an agent in the loop.

After a global install (`npm i -g @kurvcygnus/github-fetcher`), the short alias `ghf` is registered alongside `github-fetcher`, so `ghf releases anomalyco/opencode --per-page 5` works too.

    github-fetcher releases anomalyco/opencode --per-page 5 | jq -r ".items[].tag_name"
    github-fetcher health anthropics/claude-code --window-days 30 --pretty
    github-fetcher file KurvCygnus/github-fetcher README.md

- Bare `github-fetcher` (or `serve`) starts the MCP stdio server; a subcommand runs the CLI.
- Output is compact JSON on stdout (`--pretty` for humans); errors are JSON on stderr with exit codes: 2 usage, 3 rate limited, 4 auth, 5 not found, 6 network, 7 upstream.
- `--version` (`-v`) prints the package version; `--help` lists subcommands, and `github-fetcher <subcommand> --help` shows one tool's flags.
- `init` and `remove` manage MCP client configuration instead of querying GitHub; they are described below.

### `init`

`github-fetcher init` adds the `github` entry to your MCP client configuration. On a terminal it opens a selection menu (Space toggles, `a` toggles all, Enter confirms, Esc cancels; clients whose configuration already exists start selected). Scripts use flags instead:

    github-fetcher init --dry-run
    github-fetcher init --client opencode,cursor
    github-fetcher init --client opencode --name github

- `--client id,id` names clients (comma-separated); `--all` sweeps every adapter; `--dry-run` reports `would-create`, `would-update`, or `would-skip` and leaves files alone; `--name` sets the entry name (default `github`). `--dry-run` with neither `--client` nor `--all` still sweeps every adapter, so undetected clients report `not-installed` instead of `would-create`.
- By default, `init` reuses an existing entry whose `command` or `args` already point at this package, even under a legacy key such as `github-fetcher`, and updates that entry instead of adding a twin. `--name` disables resolution and forces that exact key. A key that already belongs to another server is never overwritten: when no owned legacy key exists, the client reports `skipped`, and `--name` selects another key.
- A missing configuration is created only for a client selected explicitly (`--client`, or a pick in the menu); an undetected client that was not selected reports `not-installed` and nothing is written for it. `--all` alone covers every detected client and reports the rest as `not-installed`.
- Every change to an existing file is preceded by a backup next to it as `<path>.bak.<timestamp>`; the backup completes before the target changes, and a rerun in the same second gets a numeric suffix instead of overwriting the earlier backup.
- stdout carries one JSON array with one object per client (`created`, `updated`, `skipped`, `not-installed`, `would-*`, `error`), including the resolved entry `name`; the resolved auth mode (`token` or `anonymous`) is reported on stderr. Cancelling the menu prints `cancelled` and exits 0.

Supported clients: `opencode`, `claude-desktop`, `claude-code`, `cursor`, `vscode`, `gemini`, `windsurf`, `codex`.

### `remove`

`github-fetcher remove` deletes the entry again. Without flags it offers only clients whose configuration already contains the entry, all preselected; `--client id,id` and `--all` skip the menu, and `--name` selects which entry to remove. A bare `remove` needs an interactive terminal for that menu and exits 2 when stdin is not a TTY; pass `--client` or `--all` to run unattended.

- Only existing entries are touched: a client with no configuration reports `not-installed`, a client whose configuration lacks the entry reports `skipped`, and neither file is rewritten. A key that belongs to another server is never removed; it reports `skipped` with a message.
- The current file is backed up before the removal is written, with the same `<path>.bak.<timestamp>` naming as `init`.
- Removing the last entry deletes a configuration file that would become empty; the result reports `deleted: true`, and the backup remains as the recovery copy. A top-level key or a sibling entry keeps the file.
- ZCode is deliberately unsupported: it is not an adapter, so `init` never offers it and `remove` never reads or writes its configuration.

### Local daemon

The stdio transport needs no setup. Clients that connect over HTTP instead use a background daemon that serves the same 41 tools on loopback only. The three commands are:

    github-fetcher daemon start
    github-fetcher daemon status
    github-fetcher daemon stop

`daemon start` is idempotent: an already-running daemon is reported back instead of a second listener being opened. It writes a state file and a sibling token file under `<user config dir>/github-fetcher/`; `daemon stop` posts to the stop endpoint and removes both files. `daemon status` reports whether the daemon is running along with its pid, port, version, session count, and uptime. The listener binds to `127.0.0.1` on port `41873` by default; set `GITHUB_MCP_DAEMON_PORT` to change it. `serve --daemon` is the internal entry point that `daemon start` launches.

The MCP endpoint is `http://127.0.0.1:41873/mcp` (using the configured port). Every request needs an `Authorization: Bearer <token>` header. The token is generated at start and stored in the sibling token file, never in the state file; `/health` and `POST /daemon/stop` are bearer-checked as well.

`github-fetcher init --transport http` starts the daemon and writes an OpenCode remote MCP entry that points at the `/mcp` URL and reads the bearer token from the token file, so no secret lands in the client configuration. Other adapters have no remote entry and are skipped with a warning.

Tokens and ref pins are per session: every MCP session gets its own credential and pin store, so one session's token or pin never leaks into another. All other settings come from the daemon environment.

## Limitations

- Read-only by design: no writes, no GraphQL, no clone or archive tools.
- 41 tools, not a complete GitHub API client; use `github_api_get` for read-only REST endpoints the dedicated tools do not cover.
- Anonymous access is 60 requests per hour; code search requires a token.
- No proxy is bundled; bring your own HTTP(S) proxy.
- The cache stores response bodies on disk; do not use it on a shared account if that is unacceptable.

## Security model

- Read-only by construction: the server issues only GET requests; GraphQL and write operations are not supported, and `github_api_get` accepts arbitrary read-only GET paths, host fixed to api.github.com.
- Only two hosts are ever contacted: `api.github.com` for API calls and `raw.githubusercontent.com` for raw bytes.
- Redirects are confined to GitHub origins: a redirect that leaves the original host is refused.
- Tokens appear only in the Authorization header, never in logs, errors, tool output, or the cache; cache keys use a SHA-256 hash of the token.
- Cache files are written with 0600 permissions (best effort) under the user's own cache directory.
- Identity is private by default: `github_rate_limit` reports quota only. Setting `GITHUB_MCP_EXPOSE_IDENTITY` opts in to `authenticated_as` and `scopes`; the token and its fingerprint are never returned either way.

## How it works

Every tool call becomes one GET against the GitHub REST API. Success results travel a single channel: the response carries `structuredContent` only, and the `content` array stays empty, so legacy text-only clients see an empty payload instead of a duplicated text rendering that wastes tokens; error results carry the error envelope on both channels, with the same compact JSON in `structuredContent` and a `content` text block, so text-only clients and error banners surface the real code and message. A cache layer sits in front of it: entries younger than the endpoint TTL are served locally, expired entries are revalidated with ETag validators, and only successful responses are cached, so a not-found answer is never cached and surfaces as `not_found` every time. Every API-reading tool except `github_rate_limit` accepts a `fresh` option that bypasses the cache for a single request; `github_api_get` responses are cached like every other tool; `github_capabilities` takes no input. Paths reaching the API client are validated with the same rules as the raw path. Every network-backed response ends with `meta: {cache, age_s, quota}`; on a cache hit, quota reflects the fetch that produced the cached body, and `age_s` tells you how old that body is. The optional `calls` field counts client invocations — including cache hits and internal ref resolution — so it tracks activity rather than quota consumption; GitHub's per-window used counter is the quota ground truth. A warm cache hit still counts as one client invocation. `github_pin_ref` pins a repository to a commit sha in server memory: file, tree, grep, and batch reads without an explicit `ref` anchor to that pin for the rest of the session, and the pin is lost on restart. An anchored read echoes `pinned_sha` in its success envelope; an explicit `ref` suppresses it. `github_doctor` lists this session's pinned repositories in `pinned_repos`. `github_file_grep` is cache-first: a warm cache answers with zero upstream calls and a miss costs one. Below the cache, the HTTP layer picks a route per request, retries transport failures, waits out short rate-limit windows, and refreshes a rejected token once before failing.

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
| `GITHUB_MCP_GREP_TIMEOUT_MS` | `2000` | Time budget in milliseconds for `github_file_grep` pattern matching; overruns return `matches_truncated` with a hint. |
| `GITHUB_MCP_MAX_FILE_BYTES` | `262144` | Maximum response text in UTF-8 bytes before truncation (per-call `max_bytes` caps it further). |
| `GITHUB_MCP_EXPOSE_IDENTITY` | unset | Opt-in: `1`/`true`/`yes`/`on` makes `github_rate_limit` and `github_doctor` add `authenticated_as` and `scopes`; every other value keeps identity off. |
| `GITHUB_MCP_LOG` | `error` | Parsed and validated; currently unused — warnings always go to stderr regardless of level. |

Invalid values are ignored with a warning on stderr and the default applies.

## Tool capabilities at a glance

Agents receive the full input schema for every tool via `tools/list`; `github_capabilities` carries the same facts as derived per-tool input rows (name, optionality, description), so the index and the schema cannot drift apart. The groups match the index returned by `github_capabilities`.

- Meta: `github_capabilities` (one-line summaries with `Envelope:` tags, plus per-tool derived `input` rows and an input signature; `group` restricts the index to one group), `github_rate_limit` (projects core and search by default; `all: true` expands to every bucket; identity opt-in via `GITHUB_MCP_EXPOSE_IDENTITY`), `github_api_get` (arbitrary read-only GET on api.github.com; a query string in `path` and scalar `query` values; `pagination` carries the Link-header URLs; GraphQL unsupported), `github_doctor` (one-screen health check: token presence, opt-in identity, proxy reachability from the doctor's own API probe, cache state, quota, and current session `pinned_repos`), `github_pin_ref` (pins a repository to a commit sha for the session: file, tree, grep, and batch reads without an explicit `ref` anchor to the pin echo `pinned_sha`, which lives in server memory and is lost on restart)
- Repository: `github_repo` (reports `visibility`), `github_repos` (batch lookup of up to 20 repositories with per-item ok/error), `github_compare_refs` (ahead/behind counts, total commits, `total_files` for the full diff size, and up to 100 changed files with patches capped at 4000 characters and per-file `patch_truncated`), `github_branches`, `github_languages` (bytes per language, sorted descending), `github_contributors` (login, account type, and contribution count), `github_repo_activity` (pull, issue, commit, contributor, and release counts for a window, from core endpoints only, with truncation flags), `github_stargazers` (stargazers with the `starred_at` time via the star+json media type; pages run oldest-first, so paged calls build a star timeline)
- User: `github_user` (one profile: name, type, bio, company, location, blog, and follower counts), `github_user_repos` (a user's repositories with the house projection including `created_at`; `type` defaults to `owner`; forks are dropped by default and `include_forks: true` keeps them; `min_stars` sets a star floor; every mode gathers up to 10 pages of 100 and filters the whole window before slicing so a requested page is full, costing up to 10 core calls; `sort: created|updated|pushed|full_name` keeps upstream ordering, `sort: stars` ranks client-side and ignores order, reporting `gather_truncated` when the cap stopped the gather), `github_user_starred` (starred repositories with the `starred_at` time), `github_user_events` (public events only; a 422 from the 90-day/300-event cap becomes a hinted invalid_params error), `github_user_health` (one-call audit: original vs fork split with `fork_share`, total stars, top repositories by stars, language distribution, and 90-day push activity; 2-11 core calls; detail metrics exclude forks unless `include_forks: true`)
- Files: `github_tree` (reads raw response bytes and clips locally to `max_bytes`, default 2 MiB, with a `max_bytes` hint; `path_prefix` and `glob` filter entries before `max_entries`, default 1000; reports `total_entries`, a type `summary`, `truncated` for local clipping or upstream truncation, and `api_truncated` for the upstream-only signal; a `glob` with `/` or `**` implies recursion unless `recursive` is explicitly false, and a timed-out recursive listing degrades to top-level entries with `degraded: true`; `summary_only: true` drops `entries` and returns `total_bytes` plus `top_dirs` for the full tree), `github_file` (supports 1-based `start_line`/`end_line` ranges and a per-call `max_bytes` budget), `github_readme` (fetches the repository's README through GitHub's readme endpoint, which resolves the default naming variant; use `github_file` for a specific path), `github_file_grep` (regex search in one file with 1-based line and column, `context_lines` defaulting to 2, and `max_matches` defaulting to 50 with `matches_truncated`; cache-first, so a warm cache costs zero upstream calls; matching runs in a worker thread with a 2000 ms time budget (`GITHUB_MCP_GREP_TIMEOUT_MS`); overruns degrade to `matches_truncated` instead of blocking the session; binary or non-UTF-8 files are rejected), `github_files` (batch read of up to 10 paths from one repository, one core call per uncached path, per-item ok/error so one missing path never rejects the call; optional `max_bytes` clips decoded text only and leaves binary rows untouched); `github_file` and `github_tree` 404 misses carry a recovery `hint` — branch/tag advice for a ref miss, cached sibling names for a path miss — built from the local cache with no extra upstream calls
- History: `github_commits` (`max_message_chars` truncates each commit message), `github_commit` (single-commit detail: message, author, additions/deletions, and the changed files with bounded patches; up to 100 files with `files_truncated` and patch text capped at 4000 characters; 1 core call)
- Collaboration: `github_issue`, `github_issues` (accepts `since`, an ISO 8601 timestamp, to filter by update time), `github_pr`, `github_prs`
- Releases: `github_release` (latest or tagged release with assets and download URLs; assets carry `digest` where GitHub provides one), `github_releases`
- Snapshot: `github_repo_health`, `github_compare_repos` (throttled breadth comparison of up to 20 repositories in one call)
- Search: `github_search_repos` (reports `private`, `visibility`, `topics`, `license`, `created_at`, and `pushed_at` per item; `public_only` defaults to `true` — pass `false` to include private items — filters client-side, and reports `filtered_count`, while `total_count` stays GitHub's unfiltered total), `github_search_code` (token required; `repo:`, `path:`, `state:`, and `label:` qualifiers parsed from the free-form query), `github_search_issues` (a `repo:` query uses the repository issues endpoint with a null `total_count`, a `repo_scoped` marker, and pull requests filtered out; `sort: reactions` is unsupported there), `github_search_users` (user search by GitHub query syntax — `location:`, `language:`, `followers:>=N`, `repositories:>=N` qualifiers; lean profiles, with detail in `github_user`), `github_trending` (computed approximation from GitHub search, NOT GitHub's trending page: a rising lens of repositories created inside the window and an active lens of repositories pushed inside it, both star-sorted; each observation is snapshotted, so repeated calls with the same lens gain `stars_gained` against the prior; 2 search calls)
- Actions: `github_workflows`, `github_workflow_runs`, `github_workflow_run`

## Troubleshooting

| Symptom | Meaning | What to do |
| --- | --- | --- |
| 403/429 with `rate_limited` | The quota for this credential is exhausted | Call `github_rate_limit` and wait for the reset it reports |
| DNS or connection failures for raw or API hosts | The path to GitHub is unreliable on this network | Set `GITHUB_PROXY` or `HTTPS_PROXY` |
| `auth_missing` | The endpoint needs a token; `github_search_code` requires one | Set `GITHUB_TOKEN` or `GH_TOKEN` |
| `not_found` | The repository, ref, path, or release tag does not exist, or is private | Check `owner/name` and the ref |
| TLS errors | TLS interception (corporate MITM) or a broken proxy path | Point `GITHUB_PROXY` or `HTTPS_PROXY` at a working proxy, or try `GITHUB_PROXY_MODE=direct` |

## Development

- `npm test`: run the test suite
- `npm run typecheck`: strict TypeScript check
- `npm run build`: production build
- `npm run smoke`: spawns the built server over stdio and asserts that all 41 tools are listed
- `GITHUB_SMOKE=1 npm test`: runs the suite with `GITHUB_SMOKE` set; the variable is reserved and currently unused

## License

MIT. Copyright (c) 2026 Kurv Cygnus. See [LICENSE](LICENSE).
