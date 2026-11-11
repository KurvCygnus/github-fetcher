# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

## [0.3.0] - Unreleased

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
- `github_search_repos` items gain `topics` and `license` (spdx id).
- `github_issues` accepts `since` (ISO 8601) to filter the list by update time.
- Release assets carry `digest` where GitHub provides one.
- `github_tree` degrades a timed-out recursive listing to top-level entries with `degraded: true`, and accepts `summary_only` to answer with `total_bytes` and `top_dirs` totals instead of an entries payload.

### Changed

- `github_search_repos` now defaults to `public_only: true`; private repositories enter results only with an explicit `public_only: false`.
- Truncation clips at real UTF-8 bytes, matching the `BYTES` name of the budget variables.
- The `github_tree` hint names the cause: GitHub-side truncation suggests narrowing path/ref instead of raising `max_entries`.
- `github_rate_limit` defaults to projecting the core and search buckets; `all: true` restores every bucket (`resource` still wins when given).
- `github_api_get`'s top-level `cache` and `cache_age_seconds` keys fold into the universal `meta` envelope (an unpublished Part 1 shape, reshaped freely at 0.3.0).

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
