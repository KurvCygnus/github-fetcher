# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [0.6.0] - Unreleased

### Added

- `github_tree` accepts a `glob` to filter returned entry paths: `**` crosses directory separators, `*` stays within one segment, and `?` matches one character. The filter is an entry-list filter, so it runs before `max_entries` and is ignored under `summary_only`, where there is no entry list to filter; `total_entries` and `returned_entries` count matched entries in entries mode.
- `github_files` per-item success data reports `total_lines`, the whole-file line count measured before the byte budget clips the text (matching `github_file`), with `null` for binary files.
- `github_commits` accepts `first` to serve the oldest page of the history instead of the newest, resolving the final page from the Link `last` rel in at most two calls; combined with `path`, it hunts creation commits.
- CLI usage errors carry a recovery `hint` (the usage line plus the specific convention that fixes the mistake), and top-level help lists every subcommand's arg shape with `<angle>` required and `[square]` optional positionals and the bare-boolean versus `--flag value` conventions.
- MCP error results carry the error envelope on the text channel: a `content` text block mirrors the same compact JSON as `structuredContent`, so text-only clients and error banners surface the real code and message.
- A local HTTP daemon for clients that cannot use stdio: `github-fetcher daemon start|stop|status` manages a loopback listener on port `41873` (overridden by `GITHUB_MCP_DAEMON_PORT`), and `init --transport http` writes an OpenCode remote MCP entry for the `/mcp` endpoint. The bearer token and ref pins are isolated per MCP session.

### Changed

- CLI usage errors now carry a `hint` on the error envelope's `error` object alongside the code and message (0.5-era envelopes carried the message only), so a script can recover without re-reading help.
- Tool error results gain a `content` text block mirroring `structuredContent` (0.5-era failures were `structuredContent`-only with an empty `content` array, which text-only clients rendered as a generic error); success results stay `structuredContent`-only.

## [0.5.0] - 2026-11-19

### Added

- `github_commit` reads one commit in full: message, author, additions/deletions, and the changed files with bounded patches — at most 100 files with `files_truncated`, patch text capped at 4000 characters; 1 core call. `github_commits` lists commits; this reads one.
- `github_file_grep` runs pattern matching in a worker thread with a configurable time budget: `GITHUB_MCP_GREP_TIMEOUT_MS` (default 2000, minimum 100) bounds the match loop, so a pathological pattern cannot hold the session.
- `github_api_get` paths are validated with the same rules as the raw path: dot segments (`..` and encoded variants), `//`, raw backslashes, raw `#`, and a second `?` are rejected on every call path, closing the dual-layer divergence between the tool's shortcut and the raw transport.
- The `github_file`/`github_tree` path-miss `hint` gains a last-resort probe of the ref's cached `?recursive=1` root listing, recovering the sibling set for nested paths when no scoped listing is cached — still with no extra upstream calls.
- Internal: the contents decode pipeline (inline base64, `download_url` fallback, binary rejection) consolidates into one shared module consumed by `github_file`, `github_file_grep`, `github_files`, and `github_readme`.

### Changed

- `github_file_grep` degrades a pattern that exceeds the time budget to `matches_truncated` with a hint instead of blocking the session until the match loop finishes (the previous behavior).
- The `max_message_chars` (`github_commits`) and `max_comment_chars` (`github_issue`) descriptions state UTF-8 bytes, matching what the truncation actually clips.

### Fixed

- `github_file_grep` patterns matching empty strings no longer produce duplicate empty matches capped at `max_matches`: the scan steps one character past a zero-length match instead of returning it forever (a 0.4 behavior changed in code and only now documented).
- Unsupported-content errors share one message, `GitHub did not provide readable content`, replacing the previous per-tool variants.

## [0.4.0] - 2026-11-18

### Added

- `github_file_grep` searches one file's text with a regular expression and reports 1-based line and column with context; cache-first, so a warm cache costs zero upstream calls; binary and non-UTF-8 files are rejected.
- `github_files` batch-reads up to 10 paths from one repository with per-item ok/error, so one missing or malformed path never rejects the call; one core call per uncached path.
- `github_pin_ref` pins a repository to a full commit sha for the session; the pin lives in server memory and is lost on restart, and a branch moving mid-session can never shift the anchored references.
- `github_user_health` audits a user in one call: original vs fork split with `fork_share`, total stars, top repositories by stars, language distribution, and 90-day push activity, for 2-11 core calls.
- `github_trending` computes a trending approximation from GitHub search, NOT GitHub's trending page: a rising lens (repositories created inside the window) and an active lens (repositories pushed inside it), both star-sorted; every observation is snapshotted, so repeated calls with the same lens gain `stars_gained` against the previous snapshot.
- `github_stargazers` lists a repository's stargazers with the `starred_at` time (star+json media type); pages run oldest-first, so paged calls build a star timeline.
- `github_file` and `github_tree` not-found errors carry a recovery `hint` built from the local cache only, with no extra upstream calls: branch/tag advice for a ref miss, cached sibling names for a path miss.
- Network-backed handlers report `meta.calls`, the handler's client invocation count (raw CDN fallbacks excluded), so a call's cost is readable from the response alone: every single-request handler reports `calls: 1`, and multi-request handlers report their total.
- Reads anchored by a `github_pin_ref` pin report `pinned_sha`; `github_file`, `github_tree`, `github_file_grep`, `github_files`, and `github_commits` anchor to the pin when no explicit `ref` is given.

### Changed

- `github_tree` accepts `.` and `./` as the repository root: both normalize to a path-less ref listing, while `..` and deeper dot segments stay rejected.
- The `github_file`/`github_tree` 404 message discriminates the miss: `path "<p>" not found at ref <r>` for a path miss versus `ref <r> not found` for a ref miss.

## [0.3.0] - 2026-11-14

### Added

- Every tool description declares its output shape in a `Returns` sentence, and `github_capabilities` summaries carry an `Envelope:` tag.
- `github_api_get` responses join the ETag cache; the tool accepts `fresh`.
- `github_file` accepts a per-call `max_bytes` budget on top of `GITHUB_MCP_MAX_FILE_BYTES`.
- Drift guards keep capability signatures and CLI flags in lockstep with the tool schemas.
- `github_user`, `github_user_repos`, `github_user_starred`, and `github_user_events` read a user's profile, repositories, starred repositories (with `starred_at`), and public events.
- `github_languages` reports the byte-accurate language breakdown, and `github_contributors` lists contributors with login, type, and contribution counts.
- `github_repo_activity` aggregates a repository's window activity (pulls, issues, commits, active contributors, releases) from core endpoints only, with truncation flags for the page-capped walks.
- `github_repos` fetches up to 20 repositories in one call with per-item ok/error, and `github_compare_refs` compares two refs with ahead/behind counts and file patches capped at 4000 characters.
- `github_doctor` is a one-screen health check: token presence, opt-in identity, proxy reachability, cache state, and quota.
- Every network-backed response ends with `meta: {cache, age_s, quota}` — cache state and age from the ETag cache, quota captured from the response headers (cache hits report the stored fetch's values); `github_capabilities` omits it.
- `github_api_get` exposes Link pagination as `pagination: {next, prev, first, last}`.
- `github_search_repos` items gain `topics`, `license` (spdx id), `created_at`, and `pushed_at`.
- `github_capabilities` accepts `group` to restrict the index to one group (case-insensitive; an unknown name rejects with the valid groups listed).
- `github_readme` fetches a repository's README through GitHub's readme endpoint, which resolves the default naming variant (`README.md`, `README.zh-CN.md`, and friends); use `github_file` for a specific path.
- `github_search_users` searches users by GitHub query syntax (`location:`, `language:`, `followers:>=N`); items stay lean (`login`, `type`, `html_url`) because profile detail lives in `github_user`.
- `github_user_repos` gains `include_forks` (default false, so forks are dropped unless asked for), `min_stars`, and a `stars` sort that gathers up to 10 pages of 100 client-side, ranks by stars descending, and reports `gather_truncated` when the cap stopped the gather.
- `github_commits` accepts `max_message_chars` to truncate each commit message.
- `github_compare_repos` documents its timing honestly: about 5 upstream calls per repository, roughly 10 repositories per minute, with the throttle riding the search quota.
- `github_issues` accepts `since` (ISO 8601) to filter the list by update time.
- Release assets carry `digest` where GitHub provides one.
- `github_tree` degrades a timed-out recursive listing to top-level entries with `degraded: true`, and accepts `summary_only` to answer with `total_bytes` and `top_dirs` totals instead of an entries payload.

### Changed

- Tool calls return `structuredContent` only: the `content` array stays empty, so legacy text-only clients see an empty payload instead of a duplicated text rendering.
- `github_search_repos` now defaults to `public_only: true`; private repositories enter results only with an explicit `public_only: false`.
- Truncation clips at real UTF-8 bytes, matching the `BYTES` name of the budget variables.
- The `github_tree` hint names the cause: GitHub-side truncation suggests narrowing path/ref instead of raising `max_entries`.
- `github_rate_limit` defaults to projecting the core and search buckets; `all: true` restores every bucket (`resource` still wins when given).
- `github_api_get`'s top-level `cache` and `cache_age_seconds` keys fold into the universal `meta` envelope (an earlier, never-published shape, reshaped freely at 0.3.0).

### Fixed

- Range-style query values (`stars:10..20`) pass `github_api_get`; the path-part traversal checks stay intact and raw `#` fragments stay rejected.
- Encoded dot segments (`%2e%2e`, `.%2E`, `%2e.`) can no longer traverse through `github_api_get`; the segment-aware check keeps dots inside longer segments (`my..file.md`) working.

## [0.2.1] - 2026-11-05

### Added

- `github_search_repos` reports `private` and `visibility` per result and accepts `public_only` with a `filtered_count`.
- `github_repo` reports `visibility`.
- `github_rate_limit` identity opt-in: `GITHUB_MCP_EXPOSE_IDENTITY=1` adds `authenticated_as` and `scopes`; off by default and never emits the token or its fingerprint.
- `github_api_get` accepts a query string in `path` and number/boolean `query` values; explicit `query` entries override path pairs.
- `github_file` accepts 1-based `start_line`/`end_line` and reports `total_lines`.
- `github_tree` caps output at `max_entries` (default 1000) and reports `total_entries`, `returned_entries`, a type `summary`, and `api_truncated`.
- `github_capabilities` lists a compact input `signature` for every tool.
- `github_capabilities` summaries carry each tool's key input contracts (formats, defaults, enums) so agents can call correctly from the index alone.
- CLI flags: `search-repos --public-only`, `file --start-line/--end-line`, `tree --max-entries`.

### Changed

- `github_tree` returns at most 1000 entries by default; larger trees report `truncated: true` with a hint.

## [0.2.0] - 2026-11-01

### Added

- `github_capabilities`, a zero-network index of all 22 tools grouped by task.
- `github_compare_repos`, a throttled breadth comparison for up to 20 repositories.
- `github_issues.type`, `github_issue.comment_limit`, `github_issue.max_comment_chars`, and `github_rate_limit.resource`.
- `github-fetcher init` and `github-fetcher remove` for OpenCode, Claude Desktop, Claude Code, Cursor, VS Code, Gemini, Windsurf, and Codex.
- CLI subcommands `capabilities` and `compare-repos`, plus the new issue/rate flags.
- `--version`/`-v` prints the package version.
- Client configuration adapters with backup-before-write, foreign-entry protection, empty-file cleanup, and TOML-aware Codex handling.
- GitHub Actions release workflow with a three-platform verify matrix and npm Trusted Publishing.

### Changed

- The server now exposes 22 tools instead of 20.
- Node.js 22.19 or newer is required, matching the `undici` runtime dependency.
- `init` reuses an existing package-owned entry, including legacy `github-fetcher` keys, instead of adding a duplicate.
- Backups preserve the source file mode.

### Fixed

- TOML section removal no longer deletes sibling sections or treats `[` inside comments as a header.
- `github_issue` paginates comments beyond the first 100 before applying the budget.
- Client entry matching is scoped to this package and does not overwrite or delete a foreign `github` entry.

## [0.1.0] - 2026-10-31

### Added

- Initial public release: a read-only GitHub MCP server with 20 tools over stdio.
- Token reuse from `GITHUB_TOKEN`, `GH_TOKEN`, or the git credential store.
- Direct/proxy routing for API and raw hosts, with retries and rate-limit reporting.
- ETag disk cache with TTL and token fingerprinting.
- CLI subcommands for every tool and the `ghf` alias.
