# AT Grafana

[中文](docs/README.zh-CN.md)

AT-Grafana is the newest member of the **AT Series** of VS Code-ecosystem extensions (alongside `at-terminal-series` and `at-jumpserver-series`). It surfaces Grafana dashboards and alert rules natively inside the IDE, and exposes Grafana's configuration metadata plus a generic datasource query proxy (Prometheus, Loki, ...) to Agents via the shared [`@at-series/mcp-hub`](https://www.npmjs.com/package/@at-series/mcp-hub) Protocol v1.

**Status:** Phases 0–7 complete — instance config/auth, dashboard/alert tree UI, embedded native dashboard/alert Webviews via a local reverse proxy, and the full 9-tool `at.grafana` MCP catalog (management + monitoring data families, all `risk: read`, wired into the shared AT Series Hub) are all implemented and unit/integration-tested. Phase 8 (final packaging + a real-Grafana-instance end-to-end verification pass) is the only remaining phase before a `0.1.0` release — see the implementation plan for exactly which checkpoints still need a human's manual pass with a live Grafana instance. Docs:

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
