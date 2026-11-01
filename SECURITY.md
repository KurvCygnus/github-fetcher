# Security Policy

## Supported versions

Security fixes are provided for the latest published minor version. `0.2.x` is the upcoming release; `0.1.0` is the currently published version.

## Threat model

GitHub Fetcher is a read-only local MCP server. It issues GET requests to `api.github.com` and `raw.githubusercontent.com`; it has no write tools, no GraphQL endpoint, and no hosted component. The main risks are credential disclosure, proxy interception, and cache contents on a shared machine.

- Tokens are read from `GITHUB_TOKEN`, `GH_TOKEN`, or the git credential store. They are sent only in the `Authorization` header to the two GitHub hosts.
- Tokens never appear in logs, errors, tool output, or cache keys. Cache keys use a SHA-256 token fingerprint.
- Cache files are written with owner-only permissions where the platform supports it and contain response bodies, which may include private repository data.
- `GITHUB_PROXY`, `HTTPS_PROXY`, and `HTTP_PROXY` are trusted inputs. A malicious proxy can observe the traffic it carries; use a proxy you control.
- Redirects are confined to the original GitHub host. A redirect to another host is refused.

## Reporting a vulnerability

Use GitHub Security Advisories on `KurvCygnus/github-fetcher` (`Security` -> `Advisories` -> `Report a vulnerability`). Do not open a public issue for a credential leak, a bypass of the read-only boundary, or a proxy/TLS flaw.

Include the version, the client, the command or tool call, and a redacted reproduction. Never include a live token.
