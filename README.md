# AT Grafana

[中文](docs/README.zh-CN.md)

AT Grafana is a VS Code / Cursor extension in the **AT Series** (alongside `at-terminal-series` and `at-jumpserver-series`). It brings Grafana dashboards and Unified Alerting into the IDE, and exposes read-only Grafana metadata plus datasource queries (Prometheus, Loki, …) to Agents through the shared [`@at-series/mcp-hub`](https://www.npmjs.com/package/@at-series/mcp-hub) Protocol v1.

**Current version: `0.1.0`** — V1 feature-complete. Automated suite: typecheck + **292** tests. Live Grafana / real MCP-client smoke checks are still listed as pending in [`docs/releases/0.1.0.md`](docs/releases/0.1.0.md).

## Features

- **Multi-instance config** — label, URL, Grafana Service Account Token (9.1+); tokens live in VS Code `SecretStorage`, never in plaintext settings
- **TLS Trust-On-First-Use** — first connection prompts for certificate fingerprint confirmation; fingerprint changes fail closed
- **Dashboards sidebar** — Grafana folder tree, title filter, refresh; open a dashboard in an embedded Webview
- **Alerts sidebar** — Unified Alerting rules with live state, folder grouping, Firing rules sorted first
- **Native embedded pages** — fully interactive Grafana dashboard / alert detail UI via a local `127.0.0.1` reverse proxy that injects `Authorization` on the extension side (token never visible to the Webview)
- **Per-instance Agent gate** — “Allow background Agent access” (default off); only enabled instances appear to MCP tools
- **9 MCP tools** (`risk: read`, auto-approved after AT Series MCP install):
  - Discovery: `grafana_list_instances`
  - Management: `grafana_list_dashboards`, `grafana_get_dashboard`, `grafana_list_folders`, `grafana_list_alert_rules`, `grafana_get_alert_rule`, `grafana_get_alert_history`
  - Monitoring: `grafana_list_datasources`, `grafana_query_datasource` (`GET`/`POST` only; configurable time-range / response-size caps)
- **Shared AT Series Hub** — one `AT Series` MCP entry for Cursor / Kiro / Continue; no plugin-specific MCP server

## Not in this release

- Single-panel drill-down (full dashboards only)
- Legacy Alerting (Unified Alerting only)
- Any write / mute / pause against Grafana or datasources
- Multi-organization support
- Grafana Live / WebSocket push through the embed proxy

## Install

1. Build a VSIX (or use a release asset once published):

   ```bash
   npm install
   npm run package   # produces at-grafana-0.1.0.vsix
   ```

2. In VS Code / Cursor: **Extensions → ⋯ → Install from VSIX…** and select the file.

3. Open the **AT Grafana** activity-bar views, then run **AT Grafana: Add Instance**.

## Quick start

1. Create a Grafana **Service Account** with **Viewer** and copy a token.
2. **AT Grafana: Add Instance** → label, base URL, token → **Test connection** → confirm TLS fingerprint → save.
3. Browse **Dashboards** / **Alerts**; click a node to open the native page in a Webview.
4. (Optional, for Agents) Edit the instance and enable **Allow background Agent access**.
5. (Optional) **AT Grafana: Install/Repair AT Series MCP Config**, then reconnect your MCP client.

Full walkthrough: [`docs/usage.md`](docs/usage.md) · [中文](docs/usage.zh-CN.md)

## Agent skill

| Skill | Purpose |
| --- | --- |
| [`at-grafana-mcp`](skills/at-grafana-mcp/SKILL.md) | Inspect dashboards / alert rules and query Prometheus/Loki-style data through AT Grafana MCP |

Install with the skills CLI:

```bash
npx skills add xwamt/At-grafana --skill at-grafana-mcp
```

## Development

```bash
npm install
npm run typecheck
npm test
npm run build      # bundles dist/extension.js (+ webview + hub copy via package scripts)
npm run package    # produces at-grafana-<version>.vsix
```

Press `F5` with this folder open to launch an Extension Development Host.

Requires Node.js 20+ and a VS Code / Cursor host matching `engines.vscode` (`^1.85.0`).

## Documentation

| Doc | Description |
| --- | --- |
| [`docs/features.md`](docs/features.md) ([中文](docs/features.zh-CN.md)) | Feature overview |
| [`docs/usage.md`](docs/usage.md) ([中文](docs/usage.zh-CN.md)) | Setup, Agent access, MCP client |
| [`docs/releases/0.1.0.md`](docs/releases/0.1.0.md) | Release notes & Definition-of-Done record |
| [`docs/requirements.md`](docs/requirements.md) | Full requirements (中文) |
| [`skills/at-grafana-mcp/SKILL.md`](skills/at-grafana-mcp/SKILL.md) | Agent-facing MCP catalog guide |
| [`docs/decisions/`](docs/decisions) | ADR-001 … ADR-005 |
| [`docs/plans/2026-07-29-at-grafana-v1-implementation-plan.md`](docs/plans/2026-07-29-at-grafana-v1-implementation-plan.md) | Phased implementation history |

Scaffolded from `at-terminal-series` (independent git history; SSH/SFTP/terminal domain removed) — see [ADR-001](docs/decisions/ADR-001-scaffold-from-at-terminal-series.md).

## License

[MIT](LICENSE)
