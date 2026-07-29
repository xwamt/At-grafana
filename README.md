# AT Grafana

[中文](docs/README.zh-CN.md)

AT-Grafana is the newest member of the **AT Series** of VS Code-ecosystem extensions (alongside `at-terminal-series` and `at-jumpserver-series`). It surfaces Grafana dashboards and alert rules natively inside the IDE, and exposes Grafana's configuration metadata plus a generic datasource query proxy (Prometheus, Loki, ...) to Agents via the shared [`@at-series/mcp-hub`](https://www.npmjs.com/package/@at-series/mcp-hub) Protocol v1.

**Status:** **`0.1.0` released** — all 8 phases (instance config/auth, Grafana REST client, dashboard/alert tree UI, embedded native dashboard/alert Webviews via a local reverse proxy, the full 9-tool `at.grafana` MCP catalog wired into the shared AT Series Hub, and final packaging) are implemented, unit/integration-tested (282/282 tests passing), and packaged as `at-grafana-0.1.0.vsix`. The canonical acceptance record — a full scoring against `docs/requirements.md` §7's Definition-of-Done items, including which items still need a human's manual pass against a real Grafana instance/MCP client — is [`docs/releases/0.1.0.md`](docs/releases/0.1.0.md). Docs:

- [`docs/releases/0.1.0.md`](docs/releases/0.1.0.md) — 0.1.0 release notes and Definition-of-Done acceptance record
- [`docs/requirements.md`](docs/requirements.md) — full requirements spec (grill-me decision log, 中文)
- [`docs/features.md`](docs/features.md) ([中文](docs/features.zh-CN.md)) — feature overview for end users/administrators
- [`docs/usage.md`](docs/usage.md) ([中文](docs/usage.zh-CN.md)) — how to add an instance, enable Agent access, and connect an MCP client
- [`skills/at-grafana-mcp/SKILL.md`](skills/at-grafana-mcp/SKILL.md) — Agent-facing guide to the MCP tool catalog
- [`docs/decisions/`](docs/decisions) — ADR-001 through ADR-005
- [`docs/plans/2026-07-29-at-grafana-v1-implementation-plan.md`](docs/plans/2026-07-29-at-grafana-v1-implementation-plan.md) — phased implementation plan and progress checkboxes

Scaffolded from `at-terminal-series` (independent git history, SSH/SFTP/terminal domain code removed) per [ADR-001](docs/decisions/ADR-001-scaffold-from-at-terminal-series.md).

## Development

```bash
npm install
npm run typecheck
npm test
npm run build      # bundles dist/extension.js
npm run package    # produces at-grafana-<version>.vsix
```

Press `F5` in VS Code (with this folder open) to launch an Extension Development Host.
