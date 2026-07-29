# AT-Grafana V1 Implementation Plan

**Goal:** Ship a single-VSIX VS Code extension that (1) lets a user configure one or more Grafana instances and browse/view their dashboards and alert rules natively inside the IDE, and (2) exposes that same data — plus generic datasource query access — to Agents via the shared AT Series MCP Hub, gated by a per-instance background-access toggle.

**Spec:** [../requirements.md](../requirements.md)
**Architecture decisions:** [../decisions/ADR-001](../decisions/ADR-001-scaffold-from-at-terminal-series.md) · [ADR-002](../decisions/ADR-002-single-build-variant.md) · [ADR-003](../decisions/ADR-003-panel-alert-embedding-via-local-proxy.md) · [ADR-004](../decisions/ADR-004-mcp-tool-catalog-and-permission-model.md) · [ADR-005](../decisions/ADR-005-at-series-hub-protocol-v1-adoption.md)

**Tech stack:** TypeScript, VS Code Extension API, esbuild, `@at-series/mcp-hub`, Node `http` (Bridge + reverse proxy), Zod (input validation, per series convention), Vitest (per series convention — confirm against copied scaffold).

---

## Architecture decisions (summary — see ADRs for full rationale)

- Single build variant, no base/mcp split (ADR-002)
- Scaffold copied from `at-terminal-series`, independent git history (ADR-001)
- Webview dashboards/alerts embedded via local reverse proxy injecting `Authorization: Bearer <token>` (ADR-003)
- Two MCP tool families (management + monitoring), all `risk=read`, per-instance `allowBackgroundAccess` toggle as the sole authorization gate (ADR-004)
- Direct Hub Protocol v1 adoption, no legacy migration path (ADR-005)

---

## Phase 0: Repository scaffold

**Goal of phase:** A buildable, testable, SSH-free VS Code extension skeleton with the Grafana identity wired in, before any Grafana domain logic exists.

### Task 0.1: Import and strip scaffold

**Description:** Copy `at-terminal-series` into a new `at-grafana-series` directory with independent git history (`rm -rf .git && git init`), then remove all SSH/SFTP/terminal-specific code and rename product identity.

**Files:**
- Delete: `src/ssh/`, `src/sftp/`, `src/terminal/`, `src/webview/TerminalPanel.ts`, `src/tree/SftpTreeProvider.ts`, `src/tree/SftpTreeItems.ts`, `src/assets/` (asset import/export was SSH-server-specific), corresponding `test/` files
- Modify: `package.json` (`name`, `displayName`, `description`, `publisher`, remove `xterm`/`ssh2`/`ssh2-sftp-client`-equivalent dependencies), `src/extension.ts` (strip SSH command registrations, keep MCP activation skeleton), `README.md`, `docs/README.zh-CN.md`
- Keep as-is initially (adapt in later phases): `src/mcp/*`, `src/config/ConfigManager.ts` (will be renamed/adapted in Task 1.1), `src/ssh/HostKeyStore.ts` (will be renamed/adapted in Task 1.3), `esbuild.config.mjs`, `scripts/*.mjs`

**Acceptance criteria:**
- [ ] `npm install && npm run typecheck` passes with zero SSH-domain files remaining
- [ ] `npm test` passes (SSH-specific tests deleted, not skipped)
- [ ] `npm run package` (single variant per ADR-002 — simplify away the `package:base`/`package:mcp` distinction in `package.json` scripts) produces one `.vsix`
- [ ] Extension activates in a dev host window with no command errors, even though it does nothing Grafana-specific yet

**Verification:** `npm run typecheck`, `npm test`, `npm run package`, manual `F5` launch.

**Dependencies:** None.

**Estimated scope:** L (many deletions, touches most top-level dirs, but mechanical).

### Task 0.2: Rename plugin identity end-to-end

**Description:** Replace all `AT_TERMINAL_*` / `sshManager.*` / `at.terminal` identifiers with Grafana equivalents.

**Files:**
- Modify: `src/mcp/BridgeProtocol.ts` (→ `AT_GRAFANA_PLUGIN_DISPLAY_NAME = 'AT Grafana'`), `src/mcp/toolCatalog.ts` (→ `AT_GRAFANA_PLUGIN_ID = 'at.grafana' as const`, empty tool array placeholder for now), `package.json` (command namespace `sshManager.*` → `atGrafana.*`), all `vscode.commands.registerCommand('sshManager....')` call sites

**Acceptance criteria:**
- [ ] `grep -ri "ssh" src/` (excluding node_modules/dist) returns nothing except intentional historical comments, if any (prefer zero)
- [ ] `grep -ri "at.terminal\|AT_TERMINAL\|sshManager" src/` returns nothing
- [ ] Extension still activates cleanly

**Verification:** `npm run typecheck`, `npm test`, manual grep checks above.

**Dependencies:** Task 0.1.

**Estimated scope:** M.

### Checkpoint: Phase 0

- [ ] `npm test` and `npm run typecheck` green
- [ ] One `.vsix` builds
- [ ] No SSH-domain code or naming remains
- [ ] Review with human before proceeding to Phase 1

---

## Phase 1: Instance configuration & auth

### Task 1.1: `GrafanaInstanceConfigManager`

**Description:** Adapt `ConfigManager`/`schema.ts` from server configs to Grafana instance configs.

**Files:**
- Create/modify: `src/config/schema.ts` (`GrafanaInstanceConfig { id, label, url, allowBackgroundAccess: boolean }`, token stored separately in SecretStorage keyed by instance id), `src/config/GrafanaInstanceConfigManager.ts` (CRUD + SecretStorage-backed token get/set/delete)
- Test: `test/config/GrafanaInstanceConfigManager.test.ts`

**Acceptance criteria:**
- [ ] Can add/edit/delete an instance; token never appears in `globalState`, only in `SecretStorage`
- [ ] `allowBackgroundAccess` defaults to `false` on creation
- [ ] Deleting an instance also deletes its SecretStorage token entry

**Verification:** `npm test -- test/config`

**Dependencies:** Phase 0.

**Estimated scope:** M.

### Task 1.2: Instance form Webview (add/edit)

**Description:** Adapt `ServerFormPanel` into `GrafanaInstanceFormPanel` (label, URL, token input, `allowBackgroundAccess` checkbox, "Test connection" button calling Grafana `/api/health`).

**Files:**
- Create: `src/webview/GrafanaInstanceFormPanel.ts`
- Test: `test/webview/GrafanaInstanceFormPanel.test.ts` (logic only, not full Webview rendering)

**Acceptance criteria:**
- [ ] Form validates URL format before save
- [ ] "Test connection" surfaces distinct messages for network error / TLS untrusted / 401-403 auth error / success (per requirements §5.4)

**Verification:** `npm test -- test/webview`, manual `F5` check.

**Dependencies:** Task 1.1.

**Estimated scope:** M.

### Task 1.3: TLS Trust-On-First-Use store

**Description:** Adapt `HostKeyStore` into `GrafanaCertTrustStore` keyed by instance URL host, storing certificate fingerprint instead of SSH host key fingerprint.

**Files:**
- Create: `src/grafana/GrafanaCertTrustStore.ts`
- Modify: HTTP client construction (Task 2.1) to consult this store before establishing any HTTPS connection
- Test: `test/grafana/GrafanaCertTrustStore.test.ts`

**Acceptance criteria:**
- [ ] First connection to a new host prompts fingerprint confirmation (modal, matches SSH host key UX)
- [ ] Fingerprint change blocks connection with an error notification (no silent fallback)
- [ ] Trusted fingerprints persist across reloads (`globalState`)

**Verification:** `npm test -- test/grafana/GrafanaCertTrustStore`

**Dependencies:** Task 1.1.

**Estimated scope:** S.

### Checkpoint: Phase 1

- [ ] Can fully configure a real Grafana instance end-to-end (add, test connection, trust cert) with no dashboard/alert features yet
- [ ] Review with human before proceeding to Phase 2

---

## Phase 2: Grafana REST client

### Task 2.1: `GrafanaApiClient`

**Description:** Typed HTTP client wrapping Grafana REST endpoints needed by later phases, using the trust store from Task 1.3 and the token from Task 1.1.

**Files:**
- Create: `src/grafana/GrafanaApiClient.ts` with methods: `health()`, `search()` (dashboards/folders via `/api/search`), `getFolders()` (`/api/folders`), `getDashboardByUid(uid)` (`/api/dashboards/uid/:uid`), `listAlertRules()` (`/api/v1/provisioning/alert-rules` or `/api/ruler/grafana/api/v1/rules` — confirm exact endpoint during implementation, see Open Questions), `getAlertRuleHistory(uid)`, `listDatasources()` (`/api/datasources`), `proxyDatasourceRequest(datasourceUid, method, path, query, body)` (`/api/datasources/proxy/uid/:uid/*`)
- Test: `test/grafana/GrafanaApiClient.test.ts` (mock HTTP layer)

**Acceptance criteria:**
- [ ] Every method returns typed results and throws a typed error distinguishing network / TLS / auth / Grafana-API-error failure modes
- [ ] No method logs the token
- [ ] `proxyDatasourceRequest` rejects methods outside `{GET, POST}` before making any network call (ADR-004 MON4)

**Verification:** `npm test -- test/grafana/GrafanaApiClient`

**Dependencies:** Task 1.1, Task 1.3.

**Estimated scope:** L (this is the widest-surface single file; consider splitting `alerts`/`dashboards`/`datasources` into separate modules composed by `GrafanaApiClient` if it grows past ~300 lines, per writing-plans file-size guidance).

### Checkpoint: Phase 2

- [ ] Every requirement's underlying API call (§4.2–§4.5) has a client method with a passing unit test against a mocked HTTP layer
- [ ] Review with human before proceeding to Phase 3

---

## Phase 3: Tree UI

### Task 3.1: Dashboard tree provider

**Description:** `DashboardTreeProvider` — folder → dashboard tree, backed by `GrafanaApiClient.search()`/`getFolders()`, with a filter/search command.

**Files:**
- Create: `src/tree/DashboardTreeProvider.ts`, `src/tree/GrafanaTreeItems.ts` (folder/dashboard item classes)
- Modify: `src/extension.ts` (register tree view + refresh/filter commands), `package.json` (`contributes.views`, `contributes.commands`)
- Test: `test/tree/DashboardTreeProvider.test.ts`

**Acceptance criteria:** UI1 (requirements §4.2) — expand/collapse, name filter.

**Verification:** `npm test -- test/tree`, manual `F5` check against a real or mocked Grafana instance.

**Dependencies:** Phase 2.

**Estimated scope:** M.

### Task 3.2: Alert tree provider

**Description:** `AlertTreeProvider` — folder/namespace-grouped alert rule list with state, Firing sorted first.

**Files:**
- Create: `src/tree/AlertTreeProvider.ts`
- Modify: `src/extension.ts`, `package.json`
- Test: `test/tree/AlertTreeProvider.test.ts`

**Acceptance criteria:** UI2 (requirements §4.2) — all rules shown, Firing first, grouped.

**Verification:** `npm test -- test/tree`

**Dependencies:** Phase 2.

**Estimated scope:** M.

### Checkpoint: Phase 3

- [ ] Sidebar shows real dashboard and alert data from a configured instance
- [ ] Review with human before proceeding to Phase 4

---

## Phase 4: Local reverse proxy + Webview embedding

### Task 4.1: `GrafanaEmbedProxy`

**Description:** Local HTTP reverse proxy per ADR-003 — binds `127.0.0.1`, ephemeral port, routes `/instances/:instanceId/*` to the real Grafana origin with injected `Authorization` header, rewrites absolute redirect/asset URLs to stay under the proxy origin.

**Files:**
- Create: `src/webview/GrafanaEmbedProxy.ts`
- Test: `test/webview/GrafanaEmbedProxy.test.ts` (verify header injection, method/host allowlisting, URL rewriting on a mocked upstream)

**Acceptance criteria:** PROXY1–PROXY5 (requirements §4.3).

**Verification:** `npm test -- test/webview/GrafanaEmbedProxy`

**Dependencies:** Phase 1 (token + trust store), can run in parallel with Phase 3.

**Estimated scope:** L (URL/redirect rewriting is the highest-risk sub-task here; budget extra time, consider a spike/prototype against a real Grafana instance before finalizing the rewrite rules).

### Task 4.2: Dashboard Webview panel

**Description:** `DashboardPanel` — opens on tree click, loads `<iframe src="http://127.0.0.1:<port>/instances/<id>/d/<uid>">` with CSP restricted to the proxy origin.

**Files:**
- Create: `src/webview/DashboardPanel.ts`
- Modify: `src/tree/DashboardTreeProvider.ts` (click handler), `src/extension.ts`
- Test: `test/webview/DashboardPanel.test.ts` (HTML/CSP generation logic, not real rendering)

**Acceptance criteria:** UI3.

**Dependencies:** Task 4.1, Task 3.1.

**Estimated scope:** S.

### Task 4.3: Alert detail Webview panel

**Description:** `AlertDetailPanel` — same pattern as 4.2, targeting the native alert rule view URL.

**Files:**
- Create: `src/webview/AlertDetailPanel.ts`
- Modify: `src/tree/AlertTreeProvider.ts`, `src/extension.ts`

**Acceptance criteria:** UI4.

**Dependencies:** Task 4.1, Task 3.2.

**Estimated scope:** S.

### Checkpoint: Phase 4

- [ ] Clicking a dashboard/alert node in a real dev host shows the live, interactive native Grafana page
- [ ] Browser devtools network panel (Webview devtools) shows requests going to `127.0.0.1`, never the real Grafana origin with a visible token
- [ ] Review with human before proceeding to Phase 5 (this is the highest-risk phase technically; do not proceed to MCP work until this checkpoint is genuinely green against a real Grafana instance)

---

## Phase 5: MCP Bridge — management tools

### Task 5.1: Bridge schemas + dispatch for management tools

**Description:** Extend `toolCatalog.ts` and `BridgeServer.ts` (adapted per Task 0.2) with `grafana_list_instances`, `grafana_list_dashboards`, `grafana_get_dashboard`, `grafana_list_folders`, `grafana_list_alert_rules`, `grafana_get_alert_rule`, `grafana_get_alert_history`.

**Files:**
- Create: `src/mcp/bridgeSchemas.ts` (Zod schemas per tool, `instanceId` required on every tool except `grafana_list_instances`)
- Modify: `src/mcp/toolCatalog.ts` (`AT_GRAFANA_TOOL_CATALOG` array, all `risk: 'read'`), `src/mcp/BridgeServer.ts` (`dispatchTool` switch cases)
- Create: `src/agent/GrafanaAgentToolService.ts` (the `AgentToolService`-equivalent authority: checks `allowBackgroundAccess` before delegating to `GrafanaApiClient`)
- Test: `test/mcp/toolCatalog.test.ts`, `test/agent/GrafanaAgentToolService.test.ts`, `test/mcp/BridgeServer.test.ts` (extend existing suite)

**Acceptance criteria:** MGT1–MGT7 (requirements §4.4); a call naming an instance with `allowBackgroundAccess=false` returns an authorization error, not a Grafana API error (ADR-004 consequence).

**Verification:** `npm test -- test/mcp test/agent`

**Dependencies:** Phase 2 (client), Phase 1.1 (`allowBackgroundAccess` flag).

**Estimated scope:** L (7 tools; consider splitting into two tasks — instances/dashboards/folders vs. alert rules/history — if it exceeds ~5 files per the planning-and-task-breakdown sizing guideline).

### Checkpoint: Phase 5

- [ ] All 7 management tools reachable via a direct `POST /invoke` test against a running Bridge (no Hub needed yet)
- [ ] Review with human before proceeding to Phase 6

---

## Phase 6: MCP Bridge — monitoring data tools

### Task 6.1: `grafana_list_datasources` and `grafana_query_datasource`

**Description:** Add the two monitoring-family tools, including the hard caps and method allowlist from ADR-004.

**Files:**
- Modify: `src/mcp/toolCatalog.ts`, `src/mcp/BridgeServer.ts`, `src/mcp/bridgeSchemas.ts`
- Create: `src/grafana/QueryLimits.ts` (default/max time-range and response-size constants + truncation logic, exposed as a plugin setting per requirements §5.2)
- Test: `test/mcp/toolCatalog.test.ts`, `test/grafana/QueryLimits.test.ts`, extend `test/mcp/BridgeServer.test.ts` with: method-rejection case, over-cap truncation case, `allowBackgroundAccess=false` rejection case

**Acceptance criteria:** MON1–MON4 (requirements §4.5); acceptance criteria #7–#8 from `docs/requirements.md` §7.

**Verification:** `npm test -- test/mcp test/grafana/QueryLimits`

**Dependencies:** Phase 5 (shares Bridge dispatch scaffolding), Phase 2 (`proxyDatasourceRequest`).

**Estimated scope:** M.

### Checkpoint: Phase 6

- [ ] `grafana_query_datasource` verified against a real Prometheus and a real Loki datasource proxied through a real Grafana instance
- [ ] Over-cap request produces a truncated result with a clear message, not a crash or silent empty result
- [ ] Review with human before proceeding to Phase 7

---

## Phase 7: Hub integration wiring

### Task 7.1: Wire `syncPackagedHub`, `FsBridgePublisher`, `ensureAtSeriesConfigForCurrentIde`

**Description:** Adapt `src/extension.ts`'s MCP activation block (already present from the scaffold) to use the new `AT_GRAFANA_PLUGIN_ID`/`AT_GRAFANA_TOOL_CATALOG`/`GrafanaAgentToolService`, remove the `MCP_ENABLED` conditional entirely per ADR-002 (always on).

**Files:**
- Modify: `src/extension.ts`, `src/buildFlags.ts` (remove or hardcode `true`)
- Test: `test/mcp/hubSync.test.ts`, `test/mcp/BridgeServer.test.ts`, `test/extension/McpInstallCommand.test.ts` (adapt existing suites)

**Acceptance criteria:** HUB1–HUB7 (requirements §4.6); Protocol v1 §11 compliance checklist.

**Verification:** `npm test`, then manual: install the built `.vsix`, run `AT Series: Install/Repair MCP Config`, confirm via `at_list_providers` (callable from any already-configured MCP client) that `at.grafana` shows up with all 9 tools, all auto-approved.

**Dependencies:** Phase 5, Phase 6.

**Estimated scope:** M.

### Task 7.2: Skill + docs

**Description:** Author an `at-grafana-mcp`-equivalent Agent Skill (mirroring `skills/at-terminal-mcp/SKILL.md`) describing when/how an agent should use the management vs. monitoring tool families, plus update `README.md` / `docs/features.md` / `docs/usage.md` (EN + zh-CN, matching series convention).

**Files:**
- Create: `skills/at-grafana-mcp/SKILL.md`, `docs/features.md`, `docs/features.zh-CN.md`, `docs/usage.md`, `docs/usage.zh-CN.md`
- Modify: `README.md`, `docs/README.zh-CN.md`

**Acceptance criteria:** Skill clearly distinguishes "use `grafana_query_datasource`/`grafana_list_datasources` for analyzing monitoring data" from "use `grafana_get_dashboard`/`grafana_list_alert_rules`/etc. for understanding Grafana's own configuration", matching the user's original framing in `docs/requirements.md` §1.

**Verification:** `test/docs/*.test.ts` if the scaffold enforces doc-link tests (per `at-terminal-series` convention — check `test/docs/AtTerminalMcpSkill.test.ts` pattern and adapt).

**Dependencies:** Task 7.1.

**Estimated scope:** M.

### Checkpoint: Phase 7

- [ ] Full end-to-end: install `.vsix`, configure an instance, enable background access, run `AT Series: Install/Repair MCP Config`, and successfully call all 9 tools plus see live dashboard/alert Webviews — from a single coherent session
- [ ] Review with human before proceeding to Phase 8

---

## Phase 8: Packaging and release readiness

### Task 8.1: Final packaging pass

**Description:** Confirm single-VSIX packaging script (renamed from the dual-variant scripts per ADR-002), version `0.1.0`, changelog/release doc following `at-terminal-series`'s `docs/releases/*.md` convention.

**Files:**
- Modify: `package.json` (scripts, version), `esbuild.config.mjs` (drop base/mcp branching)
- Create: `docs/releases/0.1.0.md`

**Acceptance criteria:** `docs/requirements.md` §7 (Definition of Done) items 1–10 all verified and checked off with evidence, in the style of `at-terminal-series`'s P0b acceptance record (`docs/superpowers/plans/2026-07-27-p0b-acceptance.md`).

**Verification:** Full `npm test`, `npm run typecheck`, `npm run package`, manual end-to-end pass against a real Grafana instance (dashboards + alerts + Prometheus + Loki datasources).

**Dependencies:** All prior phases.

**Estimated scope:** S.

### Checkpoint: Phase 8 (release)

- [ ] All Definition of Done items in `docs/requirements.md` §7 checked with evidence
- [ ] `.vsix` installable and functional in a clean VS Code / Cursor profile

---

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Grafana HTML/JS response rewriting for the embed proxy (Task 4.1) is more fragile than anticipated across Grafana versions | High — blocks Phase 4 checkpoint | Spike against a real Grafana instance before writing tests; consider capping supported Grafana version range explicitly if rewriting proves too version-sensitive |
| Exact Unified Alerting REST endpoints differ across Grafana minor versions | Medium — affects Task 2.1, 5.1, 6.x | Confirm against the target Grafana version's Swagger/OpenAPI spec during Task 2.1 implementation; document the confirmed endpoints back into `docs/requirements.md` if they differ from the sketch in this plan |
| WebSocket proxying for Grafana Live (used by some panels for real-time updates) adds significant proxy complexity | Medium — could degrade to "dashboard loads but doesn't live-update" | Acceptable degraded fallback: proxy can initially reject/no-op WebSocket upgrades; document as a known limitation rather than blocking Phase 4 |
| Default query time-range/size caps (Task 6.1) are guessed without real-world Prometheus/Loki cardinality data | Low-Medium — caps could be too strict or too loose | Make caps a plugin setting (visible, adjustable ceiling) from day one rather than a hardcoded constant, per requirements §5.2 |
| Scaffold copy (Phase 0) accidentally leaves a stale SSH dependency or naming that only surfaces at packaging time | Low | Explicit grep-based acceptance criteria in Task 0.2, not just "looks done" |

## Open questions (to resolve during implementation, not blocking plan approval)

1. Exact Unified Alerting list/get/history endpoints to standardize on (`/api/v1/provisioning/alert-rules` vs `/api/ruler/grafana/api/v1/rules` vs `/api/prometheus/grafana/api/v1/rules` for state) — resolve in Task 2.1 against the actual target Grafana version.
2. Concrete default/max values for `grafana_query_datasource` time-range and response-size caps (ADR-004) — propose concrete numbers in Task 6.1 based on typical Prometheus/Loki result sizes, subject to user review.
3. Whether the embed proxy (Task 4.1) and the MCP Bridge (Phase 5/6) should be the same `http.Server` instance with different route prefixes, or two separate servers — decide during Task 4.1 based on what's simplest to test in isolation; both are consistent with ADR-003.
