# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).

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
