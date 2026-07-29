# AT Grafana

AT-Grafana is the newest member of the **AT Series** of VS Code-ecosystem extensions (alongside `at-terminal-series` and `at-jumpserver-series`). It surfaces Grafana dashboards and alert rules natively inside the IDE, and exposes Grafana's configuration metadata plus a generic datasource query proxy (Prometheus, Loki, ...) to Agents via the shared [`@at-series/mcp-hub`](https://www.npmjs.com/package/@at-series/mcp-hub) Protocol v1.

**Status:** Phase 0 (repository scaffold) complete — the extension is a buildable, testable, SSH-free skeleton with the `at.grafana` MCP identity wired in, but no Grafana domain logic yet. See:

- [`docs/requirements.md`](docs/requirements.md) — full requirements spec (grill-me decision log)
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
