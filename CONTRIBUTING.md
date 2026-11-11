# Contributing

## Requirements

- Node.js >= 22.19 (the release workflow uses Node 24).
- npm (the repository is a standard npm package with a lockfile).

## Setup

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run smoke
npm run verify:launch
```

`npm run smoke` starts the built server over stdio and asserts 32 tools. `npm run verify:launch` checks metadata and documentation consistency offline; add `-- --online` to check the public links.

## Development rules

- Keep the server read-only. Do not add POST, PUT, PATCH, DELETE, or GraphQL.
- Do not add runtime dependencies without owner approval.
- New tools must be added to `src/tools/index.ts`, `src/tools/capabilities.ts`, `EXPECTED_TOOL_COUNT`, the smoke assertion, and both READMEs.
- Tests must not hit the real network. Inject a fake `FetchLike` for `HttpClient` or a fake client for tool tests, and use `vi.fn` for I/O boundaries; see `test/core/http.test.ts` and `test/tools/issues.test.ts`.
- TypeScript is strict; do not use `any`. Prefer `unknown` plus a guard.
- Comments explain why, not what. Do not refer to planning documents in code comments.

## Commits

Use a short imperative subject, for example `fix: handle a foreign client entry` or `docs: explain proxy precedence`. Keep each commit focused.

## Release fallback

The default release path is npm Trusted Publishing over OIDC. If Trusted Publishing is unavailable, the owner may add a granular `NPM_TOKEN` repository secret scoped to `@kurvcygnus/github-fetcher`; the workflow uses it only when present, as `NODE_AUTH_TOKEN`, and falls back to OIDC when it is absent. Remove the secret once OIDC works. Never commit a token or print it in workflow logs.
