# ADR-005: Direct adoption of AT Series Hub Protocol v1 (no migration)

## Status
Accepted

## Date
2026-07-29

## Context

`at-terminal-series` and `at-jumpserver-series` both had to *migrate* away from a legacy per-plugin stdio MCP server (`dist/mcp-server.js`) and VS Code `languageModelTools` surface toward the shared `@at-series/mcp-hub` Protocol v1 (see `at-terminal-series` ADR-004/ADR-005). That migration work — dual-header token compatibility, installer migration of old config entries, removal of legacy surfaces — does not apply here: AT-Grafana has no prior release and no legacy surface to migrate away from.

## Decision

AT-Grafana integrates against `@at-series/mcp-hub` **Protocol v1** from its first commit, with no transitional/legacy code path:

- Depend on the published `@at-series/mcp-hub` npm package (no local clone, no `file:` link — same as `at-terminal-series`'s post-0.3.0 model).
- `pluginId = at.grafana` (matches the required `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$` pattern).
- Tool name prefix `grafana_` (satisfies Protocol v1 §4.4's "new plugins MUST use a dedicated prefix" rule; matches pattern `^[a-z][a-z0-9_]*$`).
- Bridge implements exactly `GET /health`, `GET /tools`, `POST /invoke` with `x-at-series-token` auth — **no** legacy token header support (nothing to be legacy-compatible with).
- Registry published under `~/.at-series/bridges/<hostApp>/<bridgeId>.json` per Protocol v1 §3/§5.
- Uses `FsBridgePublisher`, `syncHubBundle`, `ensureAtSeriesMcpConfig`, `defaultAutoApproveToolNames` from `@at-series/mcp-hub` exactly as documented in [`docs/guides/plugin-integration.md`](../../../at-series-mcp-hub/docs/guides/plugin-integration.md) of the Hub repo — no custom Bridge HTTP framework, no reimplementation of registry/installer logic.
- Never registers `languageModelTools` for the same capabilities (Protocol v1 §1.2 non-goal, still applicable to new plugins by convention even though it was never present here).

## Consequences

- No migration ADR, no legacy-header acceptance code, no "remove old surface" cleanup task exists in this repo's implementation plan — those are `at-terminal-series`/`at-jumpserver-series` concerns only.
- Must still track and pass the Protocol v1 §11 compliance checklist during implementation and verification (does not register a separate MCP entry, implements all three Bridge endpoints, publishes/deletes registry correctly, declares `risk` on every tool, unique tool names via the `grafana_` prefix, never returns credentials).
- A new Grafana instance/agent, once this repo's `.vsix` is installed alongside any other AT plugin, requires **zero** additional IDE MCP configuration — it is picked up by the same `AT Series` entry per Protocol v1 §9 ("no Hub business code changes, no new IDE MCP server entry" for new plugins).
