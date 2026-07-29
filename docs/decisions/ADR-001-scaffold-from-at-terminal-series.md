# ADR-001: Scaffold at-grafana-series from at-terminal-series

## Status
Accepted

## Date
2026-07-29

## Context

AT-Grafana is a brand-new AT-family plugin. Building a VS Code extension from zero would require re-solving problems the series has already solved and hardened in `at-terminal-series`:

- Encrypted credential storage pattern (`ConfigManager` + `SecretStorage`)
- Trust-on-first-use certificate/host-key confirmation UX
- Tree view provider pattern for a sidebar list backed by async config state
- `BridgeServer` implementing the AT Series Hub Bridge HTTP contract (`/health` `/tools` `/invoke`)
- Hub bundle sync (`syncPackagedHub`) and MCP config installer wiring (`ensureAtSeriesConfigForCurrentIde`)
- esbuild-based packaging pipeline and `.vsix` packaging scripts
- Test harness and CI-friendly `npm test` / `npm run typecheck` setup

`at-terminal-series` itself was created this way: [ADR-005 in at-terminal-series](../../../at-terminal-series/docs/decisions/ADR-005-at-series-hub-adaptation.md) documents importing `ssh-plugins` as an independent git history and adapting it, rather than building the Hub integration from scratch. This is the established series pattern.

## Decision

1. **Copy `at-terminal-series` as the starting point for `at-grafana-series`, with independent git history.** No shared remote, no shared git history with `at-terminal-series`. This repository does not modify `at-terminal-series`.
2. **Reuse infrastructure, remove domain code.** Keep and adapt:
   - `ConfigManager` / `SecretStorage` pattern → becomes `GrafanaInstanceConfigManager` (instances instead of SSH servers)
   - `HostKeyStore` TOFU pattern → becomes `GrafanaCertTrustStore` (certificate fingerprint instead of SSH host key)
   - `ServerTreeProvider` pattern → becomes `DashboardTreeProvider` / `AlertTreeProvider`
   - `BridgeServer` / `BridgeProtocol` → adapted for `at.grafana` plugin id and the new tool catalog
   - `McpConfigInstaller` usage, `hubSync.ts`, `hostApp.ts` → reused near-verbatim (these are Hub-protocol concerns, not SSH-specific)
   - esbuild config, `package-variant.mjs`-equivalent scripts (simplified per [ADR-002](ADR-002-single-build-variant.md)), test tooling
   Remove entirely:
   - SSH/SFTP/terminal domain code (`src/ssh`, `src/sftp`, `src/terminal`, `src/webview/TerminalPanel.ts`, `src/tree/SftpTreeProvider.ts`, `xterm.js` dependency, asset import/export)
3. **Own ADR numbering starts at ADR-001 in this repo.** Cross-references to `at-terminal-series` ADRs are informative, not normative for this repo.

## Consequences

- Fast, low-risk bootstrap: the Hub integration plumbing (the highest-risk, most-tested part of the series) is reused rather than reimplemented.
- Must audit and rename all SSH-specific identifiers (`sshManager.*` commands, `AT_TERMINAL_*` constants, `ssh-plugins` package name) during the initial scaffold task — leaving stale SSH naming in a Grafana plugin is a defect, not cosmetic debt.
- `at-terminal-series` remains untouched and independently maintained; this repo does not need to track its changes except by manually porting future Hub-protocol-level fixes if any.
- Test suite inherited from `at-terminal-series` will initially reference SSH concepts; those tests must be deleted or rewritten as part of scaffold adaptation, not left disabled.
