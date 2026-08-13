# AT Grafana — Features

**Audience:** end users and administrators configuring/using the extension (for the Agent-facing tool contract, see [`skills/at-grafana-mcp/SKILL.md`](../skills/at-grafana-mcp/SKILL.md); for the full requirements spec, see [`requirements.md`](requirements.md)).

## Overview

AT Grafana brings Grafana dashboards and alert rules natively into the IDE, and exposes Grafana's configuration plus its underlying monitoring data (Prometheus, Loki, etc.) to Agents through the shared [`@at-series/mcp-hub`](https://www.npmjs.com/package/@at-series/mcp-hub) Protocol v1 — no separate MCP server entry to configure, no per-plugin setup beyond adding your Grafana instance(s).

## Instance configuration

- Configure one or more Grafana instances (label, URL, Service Account Token). Tokens are stored in VS Code's encrypted `SecretStorage`, never written to plaintext settings.
- First connection to a new host prompts a TLS certificate fingerprint confirmation (Trust-On-First-Use, the same model as SSH host keys); a later fingerprint change blocks the connection instead of silently accepting it.
- Each instance has an independent **"Allow background Agent access"** toggle (default off). Only instances with this enabled are visible to, and callable by, an Agent through MCP — see [Usage](usage.md) for how to enable it.
- "Test connection" on the instance form distinguishes network errors, untrusted certificates, and authentication failures.

## Sidebar tree UI

- **Dashboards** view: Grafana's folder structure, with a name filter. Clicking a dashboard opens it in a Webview.
- **Alerts** view: every Unified Alerting rule with its current state, grouped by folder, with **Firing** rules sorted to the top. Clicking a rule opens its detail in a Webview.
- Both views have a refresh command; dashboards additionally support a title filter.

## Embedded dashboards and alert detail pages

Clicking a dashboard or alert rule opens the **actual, fully interactive native Grafana page** inside a VS Code Webview — panel zoom, tooltips, and the native time-range picker all work exactly as they do in a browser. This works via a local, `127.0.0.1`-only reverse proxy that injects the Service Account Token on the extension's side; the token is never sent to, or visible from, the Webview's own network requests.

## MCP tool catalog (for Agents)

Nine tools, all `risk: read` and auto-approved once the AT Series MCP config is installed — no per-tool approval prompts. Two families:

- **Management family** — `grafana_list_dashboards`, `grafana_get_dashboard`, `grafana_list_folders`, `grafana_list_alert_rules`, `grafana_get_alert_rule`, `grafana_get_alert_history`. For an Agent that wants to know *what is configured*: which dashboards/folders exist, what a panel actually queries (`grafana_get_dashboard` with `fields: "targets"` recommended), how an alert rule is defined and how it has fired historically.
- **Monitoring family** — `grafana_list_datasources`, `grafana_query_datasource`. For an Agent that wants to know *what is actually happening*: the real Prometheus/Loki-style data behind a datasource, queried through Grafana's own proxy API.
- `grafana_list_instances` (discovery) only ever returns instances with background access enabled, and never a token.

`grafana_query_datasource` only allows `GET`/`POST` (never a mutating method), and confines `path` to `/api/datasources/proxy/uid/<datasourceUid>/` — `..`, `\`, and percent-encoded separators are rejected, and the joined path is re-checked after URL normalization, so the tool cannot be steered into Grafana's own APIs by an Agent acting on attacker-authored input. It also enforces configurable time-range and response-size caps — an over-cap request is truncated with a `truncated: true` marker in the result rather than failing, so an Agent can narrow its query and retry.

## Hub / IDE integration

- **AT Grafana: Install/Repair AT Series MCP Config** and **AT Grafana: Uninstall AT Series MCP Config** commands manage the single shared `AT Series` MCP entry (Cursor, Kiro, Continue) used by every AT-family plugin — installing AT Grafana never creates a second, plugin-specific MCP server entry.
- No write/exec tools exist in V1: every tool is read-only by design (dashboard/alert/datasource creation, editing, deletion, silencing, and pause/resume are all out of scope for this release).

## Non-goals (current release)

- Single-panel drill-down (only full dashboards are embedded)
- Legacy Alerting (Unified Alerting only)
- Any write operation against Grafana or a datasource
- Multi-organization support
- Grafana Live / WebSocket push through the embed proxy (dashboards load and can be refreshed manually)
