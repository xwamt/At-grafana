# ADR-002: Single build variant (no base/mcp split)

## Status
Accepted

## Date
2026-07-29

## Context

`at-terminal-series` and `at-jumpserver-series` ship two `.vsix` variants (see `at-terminal-series` ADR-001, "dual-build-variants"): a `base` variant with SSH terminal/SFTP only, and an `mcp` variant that additionally bundles the Bridge, Hub sync, and MCP config installer. This split exists because the base UI (terminal + SFTP) has full standalone value for users who never want Agent involvement at all, and because exposing *any* Bridge process is a meaningfully larger trust surface when the tool catalog includes `exec`-risk tools like `run_remote_command`.

AT-Grafana's stated core value (per `docs/requirements.md` §1) is the *reverse*: making Grafana-configured monitoring data and Grafana metadata available to an Agent for analysis. The dashboard/alert visualization UI is explicitly the secondary, "nice to have because we already fetch the list" experience, not the primary reason this plugin exists.

## Decision

AT-Grafana ships **exactly one build/VSIX**. There is no `package.base.json` / `package.mcp.json` split, no separate packaging scripts per variant. The single package always:

- Registers the Dashboard/Alert tree views and Webview panels
- Starts the `BridgeServer` and publishes to the AT Series registry
- Participates in Hub bundle sync and exposes the MCP install/uninstall commands

The actual privacy/trust boundary is **not** "is the Bridge process running at all" but the per-instance `allowBackgroundAccess` toggle from [ADR-004](ADR-004-mcp-tool-catalog-and-permission-model.md) (default off) plus the fact that every V1 tool is `risk=read` — there is no `exec`-risk surface analogous to `run_remote_command` to gate behind a separate build.

## Consequences

- Simpler release process: one `npm run package`, one `.vsix`, one install path, one README section — no capability comparison table to maintain.
- A user who wants zero Agent involvement still gets a Bridge process running in their extension host, but it publishes to the registry with an empty/authorized-only tool set governed entirely by the per-instance toggle; it is inert (no reachable tools) until the user explicitly opts an instance in.
- If a future version introduces `write`/`exec`-risk tools (e.g. V2 dashboard mutation, alert silence), this ADR should be revisited — that is the point at which the dual-variant pattern from the rest of the series becomes relevant again.
