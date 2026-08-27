# AT Grafana 0.1.4 可执行计划 · Part A（Tasks 1–6）

> 执行前先读 [索引](./2026-08-27-agent-implementation-plan.md)。本文件由 claude-fable-5-thinking-xhigh 子代理起草，父代理仅做交叉引用修正。
> 分支：`cursor/implement-optimizations-ef26`（或其后继）。禁止 `master`。
>
> **Parent corrections (must follow):**
> 1. SKILL 真实路径是 `skills/at-grafana-mcp/SKILL.md`（不是 `.cursor/skills/at-grafana/SKILL.md`）。Task 2 改那个文件。
> 2. ADR 目录是 `docs/decisions/`。Task 1 若提到 telemetry ADR，链接写成 [`docs/decisions/ADR-010-zero-telemetry.md`](../decisions/ADR-010-zero-telemetry.md)（Task 15 才创建该文件）。不要写 `docs/adr/`。
> 3. Task 6 子代理草稿引用了不存在的 `src/client/alertHistorian.ts` / `parseHistorianFrames`。**以本文件 Task 6 末尾「Parent rewrite」为准**，对 `src/grafana/GrafanaAlertsApi.ts` 的 `parseHistoryFrame` / `GET /api/v1/rules/history` 写离线夹具测试。

---

## Task 1 — Honest docs + 0.1.3 shipped snapshot + test count 709

**Goal.** Align README / docs with reality (709 tests, 0.1.3 shipped, 0.1.4 unreleased) and add a dated 0.1.3 inventory so later agents do not treat Wave 0–3 as still-open.

**DoD.** Every currently-wrong number/claim is corrected; 0.1.3 inventory exists; 0.1.4 is not claimed released.

### Files

| Path | Action |
|---|---|
| `README.md` | Patch |
| `docs/README.zh-CN.md` | Patch |
| `docs/usage.md` | Patch (test count) |
| `docs/0.1.3-shipped.md` | **Create** |

### Exact edits

**`README.md` line 5:**

```markdown
[![Tests](https://img.shields.io/badge/tests-709-green)](./src/test)
```

**`README.md` line 11:** `AT Grafana **0.1.3** is a VS Code / Cursor extension...`

**`README.md` ~line 60** (replace the 0.1.2 parenthetical with):

```markdown
> **0.1.3 shipped 2026-08-27** (commit `7fbd45a`). **0.1.4 is unreleased.**
> Wave 0–3 landed on `cursor/implement-optimizations-ef26` (HEAD `49e60a8`) — 709 tests, 48 files.
> Full inventory: [`docs/0.1.3-shipped.md`](./docs/0.1.3-shipped.md).
> Next: [`docs/plans/2026-08-27-followup-completeness-roadmap.md`](./docs/plans/2026-08-27-followup-completeness-roadmap.md).
```

**`README.md` ~line 138:** `**0.1.3** ships these 17 tools.`

**`README.md` ~line 142:** add after tool table:

```markdown
> **Telemetry:** AT Grafana does not collect usage, crash, or identity telemetry. Grafana HTTP calls stay on the operator's instance. See [`docs/decisions/ADR-010-zero-telemetry.md`](./docs/decisions/ADR-010-zero-telemetry.md) (file created in Task 15; until then this paragraph is the contract).
```

If Task 15 has not landed, keep the paragraph and use a relative path that will exist after T15. Do not invent metrics.

**`README.md` Docs table:** add row:

```markdown
| 0.1.3 shipped inventory | [`docs/0.1.3-shipped.md`](./docs/0.1.3-shipped.md) |
```

**`docs/README.zh-CN.md`:** same numbers; 中文「0.1.4 **未发布**」；工具表标题「**0.1.3** 提供这 17 个工具」；遥测：「AT Grafana **不采集**使用量、崩溃或身份遥测。」

**`docs/usage.md`:** `npm test` → 709 passing / 48 files.

**`docs/design.md` does not exist** — do **not** create it. If you mention Wave 0–3 in `docs/features.md`, one sentence is enough; do not rewrite the feature list.

**New `docs/0.1.3-shipped.md`:** copy the "Already landed — do not re-do" table from the follow-up roadmap (lines 39–67), plus:

```markdown
# 0.1.3 shipped inventory (2026-08-27)

- Tag/commit: `7fbd45a` (`feat: release v0.1.3…`)
- Tests on master at ship: **559**
- Tests after Wave 0–3 (`49e60a8`): **709** / 48 files
- 0.1.4: **unreleased**

## Do not re-implement

(table from roadmap)

## Still open after Wave 0–3

See `docs/plans/2026-08-27-followup-completeness-roadmap.md` P0/P1.
```

### Tests

No production tests. After edits: `rg -n "559|0\\.1\\.2 is the|0\\.1\\.4\\*\\*" README.md docs/README.zh-CN.md docs/usage.md` — remaining 0.1.2 mentions must be historical (changelog, PROXY3). `rg "709"` must hit README badge + usage.

### Commit

```
docs: snapshot 0.1.3 shipped state and correct 709 test count
```

---

## Task 2 — SKILL.md incident playbook (P1-5)

**Goal.** Add a copy-paste incident workflow to `.cursor/skills/at-grafana/SKILL.md` so Agent Mode uses `grafana_list_instances` → rule → `grafana_list_alert_instances` → Explore → optional silence text.

**DoD.** SKILL has a named playbook; mentions `isPaused`; does not claim write tools; silence is text-only.

### Files

| Path | Action |
|---|---|
| `skills/at-grafana-mcp/SKILL.md` | Patch（在 `## Core workflow` 之后插入；保留现有 Discover / Defaults） |

### Insert this block

```markdown
## Incident playbook

Use this when the user reports firing alerts, pages, or "what's broken in Grafana?".

1. **Discover instances** — call `grafana_list_instances` with `{}`.
   - If `hint` is present, the MCP server is in **restricted mode** (Cursor/VS Code Agent). Only `list_instances` and `openInIde` work until the user clicks **AT Grafana: Allow Agent Access** (status-bar shield). Do not retry other tools; tell the user to click the shield.
   - If `instances` is empty, stop: ask the user to add an instance in AT Grafana settings (token stays in SecretStorage; never ask them to paste a token into chat).
   - If multiple instances, pick `default` or the id the user named. Pass that `instanceId` on every later call.
2. **List firing rules** — `grafana_list_alert_rules` with `{ "instanceId": "<id>", "states": ["firing"] }`. Optionally add `"folderUid"` if the user named a folder.
   - Each item includes `state` (`firing`/`pending`/`normal`/`unknown`) and `isPaused`. Skip or call out paused rules: they will not fire. There is **no** `grafana_list_alert_instances` tool — live state is already on this list.
   - For a specific uid, `grafana_get_alert_rule` returns `data` (query/condition model) and `notificationSettings`.
3. **Optional history** — `grafana_get_alert_history` with `{ "instanceId": "<id>", "uid": "<rule uid>" }`. A 404 usually means Loki-backed state history is disabled; do not invent samples.
4. **Jump via deeplink** — `grafana_generate_deeplink`:
   - Explore: `{ "instanceId": "<id>", "kind": "explore", "datasourceUid": "<uid>", "expr": "<promql or logql from the rule's data>" }` (URL-only until Task 16).
   - Dashboard: `{ "instanceId": "<id>", "kind": "dashboard", "uid": "<dashboard uid>", "from": "now-6h", "to": "now" }`.
   - Alert rule: `{ "instanceId": "<id>", "kind": "alertRule", "uid": "<rule uid>" }` (`openInIde` waits for Task 8).
5. **Optional silence helper (text only)** — if the user wants a silence, output a copy-paste JSON body for `POST /api/alertmanager/grafana/api/v2/silences`. **Do not POST it.** AT Grafana has no write tools (ADR-004; ADR-008 stays Proposed). Example shape:

```json
{
  "matchers": [{ "name": "alertname", "value": "<name>", "isRegex": false, "isEqual": true }],
  "startsAt": "<ISO-8601>",
  "endsAt": "<ISO-8601>",
  "createdBy": "<user>",
  "comment": "<reason>",
  "status": { "state": "active" }
}
```

Tell the user to run it in Grafana UI (Alerting → Silences) or `curl` with **their** token. Never send a write from this skill.

### Paused rules

`grafana_list_alert_rules` items include `isPaused`. A paused rule will not produce new firing instances. If the tree or API shows paused, say so explicitly instead of hunting instances.
```

Keep existing Discover / Core workflow / Defaults. Playbook is additive. Do not claim write tools. If `skills/at-grafana-mcp/references/tool-selection.md` has a silence row, keep it text-only.

### Tests

`rg -n "Incident playbook|isPaused|text only" skills/at-grafana-mcp/SKILL.md` — all hit.

### Commit

```
docs(skill): add incident playbook using list/get alert tools
```

---

## Task 3 — CHANGELOG 0.1.4 (unreleased) from Wave 0–3

**Goal.** User-facing 0.1.4 section; mark **Unreleased**.

**DoD.** Keepers can read what 0.1.4 will contain; no ship date; 0.1.3 section untouched.

### Files

| Path | Action |
|---|---|
| `CHANGELOG.md` | Patch — insert **above** `## [0.1.3] - 2026-08-27` |

### Insert

```markdown
## [0.1.4] - Unreleased

Wave 0–3 on `cursor/implement-optimizations-ef26` (HEAD `49e60a8`). Not tagged.

### Fixed
- TLS TOFU on keep-alive reused sockets (PERF-01): `secureConnect` only fires on new TLS handshakes; reused sockets now run `getPeerCertificate` in `attachCertVerification`.
- Test Connection uses the same TrustStore as runtime (FUNC-02). Self-signed Grafana no longer fails solely because the tester used `rejectUnauthorized: true`.
- `grafana_get_alert_rule` now returns `data` (query/condition model) and `notificationSettings` (FUNC-01).
- Agent `openInIde` no longer deadlocks on first-time TOFU (FUNC-14): `interactiveTls: false` + `assertAgentTlsPreTrusted`.
- Loki instant-query default `limit` raised to 200 with `direction: "backward"` (FUNC-07).

### Added
- `grafana_list_alert_rules`: `isPaused`; tree shows a paused icon (FUNC-09).
- Nested Grafana folders in the dashboard tree (`parentUid`, FUNC-13).
- Dashboard tree + command-palette filters persist in `workspaceState`; empty-result copy names the active filter (UX-03/04).
- MCP tool descriptions include host + `instanceId` (UX-07).
- Status-bar shield for Agent MCP access; 401 copy asks the operator to rotate the token in SecretStorage (UX-08/09).
- Context menus: Open in Browser / Copy UID or URL / Reveal in Grafana (UX-10).
- Alert-count badge on the Alerts tree container; refresh interval setting (UX-13, default 60s).
- Embed: shared HTTPS agent, compression passthrough, rewrite LRU, idle dispose, loading/error shell, instance/token cache (PERF-02/03/04/10/11).
- Forget Trusted Certificate command (FUNC-05).
- Management API response cap 20 MiB (FUNC-17).
- `docker-compose.smoke.yml` + `docs/plans/2026-08-27-live-smoke-checklist.md`.

### Changed
- HTTP client shares a keep-alive `https.Agent` (PERF-01 follow-through).
- MCP bridge passes already-parsed tool args (PERF-07).
- Logger skip-double-redaction via brand (PERF-08).
- Discovery regex: max 256 chars, candidate cap, invalid regex throws (PERF-12).
- Deeplink builder supports `alertRule` + Explore `expr` (FUNC-16).
- Templating variables included in dashboard projection (FUNC-06).
- `grafana_list_instances` returns `{ instances, hint? }` instead of a raw array (UX-19).
- Folders cache is process-wide, not per-tree-provider (PERF-05).
- Tree refresh invalidates the folders cache (`invalidateAll`).

### Docs
- PROXY3 WebSocket degradation; 0.1.2 form-field correction; query metering note.

### Still not in 0.1.4
- Live DoD 1/2/3/9 not executed (Extension Host / Webview DevTools / real MCP client).
- `publisher` remains `"local"` until a human id is supplied.
- MCP write tools, Live WebSocket, Explore-in-IDE, `d-solo`, Legacy Alerting (ADR-003).
- Marketplace VSIX / Open VSX publish.
```

Bump `package.json` version **only if** a human asks. Default: leave `0.1.3`.

### Tests

`rg -n "0.1.4.*Unreleased|PERF-01|FUNC-01|FUNC-02" CHANGELOG.md`

### Commit

```
docs: add unreleased 0.1.4 CHANGELOG from Wave 0–3
```

---

## Task 4 — Gated publisher / publish checklist (HUMAN-GATED)

**Goal.** Document how to set `publisher` and package a VSIX **without publishing**. Do **not** write a real publisher id.

**DoD.** `package.json` `publisher` is still `"local"` unless `AT_GRAFANA_PUBLISHER` is a non-placeholder value provided in-session. Checklist exists. No `vsce publish`.

### Files

| Path | Action |
|---|---|
| `package.json` | Patch **only** the `publisher` field, and **only** if gated |
| `docs/publish-checklist.md` | **Create** |
| `README.md` | Link the checklist in Docs table |
| `docs/README.zh-CN.md` | Same |

### Publisher patch (gated)

```json
"publisher": "local"
```

**IF AND ONLY IF** the human message contains a publisher id that is **not** `local`, **not** `REPLACE_ME`, **not** empty — then set `"publisher": "<that exact id>"`.

If the id looks like a placeholder (`YOUR_PUBLISHER`, `todo`, `xxx`), **refuse** and leave `"local"`.

Never run `npx vsce publish` or `ovsx publish`.

### New `docs/publish-checklist.md`

```markdown
# Publish checklist (0.1.4+)

AT Grafana ships with `"publisher": "local"` in `package.json`. Marketplace and Open VSX **reject** `local`. This file is the human gate.

## 1. Publisher id (human)

1. Create a publisher on [VS Marketplace](https://marketplace.visualstudio.com/manage) (and optionally Open VSX).
2. Tell the implementing agent the **exact** publisher id (e.g. `xwamt`).
3. Agent sets `package.json` `"publisher"` to that id. Do not invent one.
4. `name` stays `at-grafana`. Display name stays `AT Grafana`.

Until step 3, keep `"publisher": "local"` so accidental `vsce publish` cannot succeed.

## 2. Package a VSIX (safe)

```bash
npm ci
npm run typecheck
npm test
npx vsce package --no-rewrite-relative-links --allow-star-activation
# produces at-grafana-0.1.x.vsix — do not attach secrets
```

`--allow-star-activation` is required because `activationEvents` is `["*"]`.

## 3. Install locally

```bash
code --install-extension ./at-grafana-0.1.x.vsix
# or Cursor: cursor --install-extension ./at-grafana-0.1.x.vsix
```

## 4. Do not publish from the agent

- Do **not** run `vsce publish` or `ovsx publish`.
- Do **not** put PATs in the repo, CI logs, or chat.
- Human publishes from a trusted machine after DoD 1/2/3/9 (see live-smoke checklist).

## 5. After a real publisher id lands

- Search-replace remaining "unpublished" / "sideload only" copy in README if it would be false.
- Tag `v0.1.4` only when CHANGELOG is dated (not Unreleased) **and** a human asks.
```

README Docs table row: `| Publish checklist | [\`docs/publish-checklist.md\`](./docs/publish-checklist.md) |`

### Tests

`node -e "const p=require('./package.json'); if(p.publisher!=='local' && process.env.AT_GRAFANA_PUBLISHER_CONFIRMED!=='1') process.exit(1)"` — optional; default assert publisher is `local`.

`test -f docs/publish-checklist.md`

**Forbidden:** `vsce publish`, writing `.vscode/PAT`, committing `*.vsix`.

### Commit

```
docs: add publish checklist; keep publisher local until human id
```

If publisher was actually changed: `chore: set marketplace publisher id` as a **second** commit, same PR, only after human id.

---

## Task 5 — Live smoke compose + fixture capture runbook

**Goal.** Pin Grafana **11.5.2**, optional Loki historian, golden-copy paths, HUMAN-only DoD 1/2/3/9.

**Canonical image pin for the whole 0.1.4 plan: `grafana/grafana:11.5.2`.** Task 26 must not change this to 13.2.0 unless a human bump + recapture.

**DoD.** `docker compose -f docker-compose.smoke.yml up -d` is copy-pasteable; `docs/fixtures/README.md` exists; checklist § HUMAN REQUIRED names Extension Host / Webview / MCP client.

### Files

| Path | Action |
|---|---|
| `docker-compose.smoke.yml` | Patch |
| `docs/plans/2026-08-27-live-smoke-checklist.md` | Patch |
| `docs/fixtures/README.md` | **Create** |
| `.gitignore` | Patch if `docs/fixtures/**/*.bin` should stay untracked — **prefer committing small JSON/HTML**; ignore `*.bin` dumps >100KiB |

### `docker-compose.smoke.yml` — replace with:

```yaml
# Local Grafana + optional Loki historian for AT Grafana live smoke (DoD 1/2/3/9).
# Not started by `npm test`. Token = admin:admin via basic auth OR a SA token you create in the UI.
#
#   docker compose -f docker-compose.smoke.yml up -d
#   open http://localhost:3000  (admin / admin)
#   docker compose -f docker-compose.smoke.yml down -v
services:
  grafana:
    image: grafana/grafana:11.5.2
    ports:
      - "3000:3000"
    environment:
      GF_SECURITY_ADMIN_USER: admin
      GF_SECURITY_ADMIN_PASSWORD: admin
      GF_AUTH_ANONYMOUS_ENABLED: "false"
      GF_FEATURE_TOGGLES_ENABLE: ""
      GF_UNIFIED_ALERTING_ENABLED: "true"
      GF_LOG_LEVEL: info
    volumes:
      - grafana-smoke-data:/var/lib/grafana
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/api/health || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 20

  # Optional Loki so Alerting → historian queries have a backend.
  # Leave running; AT Grafana does not require it for dashboard embed.
  loki:
    image: grafana/loki:3.3.2
    ports:
      - "3100:3100"
    command: -config.file=/etc/loki/local-config.yaml
    profiles: ["historian"]

volumes:
  grafana-smoke-data:
```

Loki on profile `historian`: `docker compose -f docker-compose.smoke.yml --profile historian up -d`

### New `docs/fixtures/README.md`

```markdown
# Live-smoke fixtures (not used by `npm test`)

Capture **after** a successful HUMAN smoke against `docker-compose.smoke.yml`.
These files are reference dumps for regressions; the automated suite must not read them.

## Layout

```
docs/fixtures/
  README.md                 (this file)
  grafana-health.json       GET /api/health
  search-dashboards.json    GET /api/search?type=dash-db&limit=5
  alert-rules.json          GET /api/v1/provisioning/alert-rules (redact tokens)
  folders.json              GET /api/folders
  dashboard-<uid>.json      GET /api/dashboards/uid/<uid> (one small dashboard)
```

Do **not** commit: session cookies, `grafana_session`, Bearer tokens, `*.bin` HAR with Authorization headers.

## Capture commands (Grafana at http://localhost:3000, admin/admin)

```bash
mkdir -p docs/fixtures
AUTH="admin:admin"
BASE=http://localhost:3000
curl -sfu "$AUTH" "$BASE/api/health" | jq . > docs/fixtures/grafana-health.json
curl -sfu "$AUTH" "$BASE/api/search?type=dash-db&limit=5" | jq . > docs/fixtures/search-dashboards.json
curl -sfu "$AUTH" "$BASE/api/folders" | jq . > docs/fixtures/folders.json
curl -sfu "$AUTH" "$BASE/api/v1/provisioning/alert-rules" | jq . > docs/fixtures/alert-rules.json
# Pick a uid from search-dashboards.json:
# curl -sfu "$AUTH" "$BASE/api/dashboards/uid/<uid>" | jq . > docs/fixtures/dashboard-<uid>.json
```

If the implementing agent cannot reach Docker, create the directory + this README and leave JSON out. Do not invent Grafana payloads.
```

### Checklist patch — add at top of `docs/plans/2026-08-27-live-smoke-checklist.md` (after title):

```markdown
## HUMAN REQUIRED — DoD 1 / 2 / 3 / 9

Automated `npm test` does **not** cover these. An agent must **not** tick them.

| DoD | What | Where to look | Agent may mark Done? |
|---|---|---|---|
| 1 | Extension Host: `AT Grafana` output, no uncaught exceptions on activate / Test Connection / open dashboard | VS Code/Cursor **Output** panel → `AT Grafana`; **Help → Toggle Developer Tools** Console | **No** |
| 2 | Webview: Grafana iframe loads; DevTools Network has `/d/<uid>` through `127.0.0.1:<embedPort>`; no mixed-content / CSP kill | Webview Developer Tools (command `Developer: Open Webview Developer Tools`) | **No** |
| 3 | MCP: `grafana_list_instances` then `grafana_open_in_ide` from a **real** Cursor/VS Code Agent chat, not a unit test | Cursor Agent / Copilot Chat with AT Grafana MCP registered | **No** |
| 9 | After allow: restricted tools work; before allow: only `list_instances` + `openInIde` + `hint` | Same MCP client; status-bar shield | **No** |

### Agent-allowed prep

- Start compose; create `docs/fixtures/README.md`; capture JSON **if** Docker is up.
- Tick only compose-up / fixture-file existence in a PR comment, never DoD 1/2/3/9.
```

Renumber existing checklist sections if they already use 1. 2. 3. — keep body, add HUMAN banner first.

### Tests

`docker compose -f docker-compose.smoke.yml config` must succeed (needs Docker). If Docker missing, skip and note in PR.

`test -f docs/fixtures/README.md`

**Forbidden:** marking DoD 1/2/3/9 complete; committing tokens; changing pin away from 11.5.2 without human + fixture recapture.

### Commit

```
chore: pin smoke Grafana 11.5.2 and add fixture capture runbook
```

---

## Task 6 — Alert-history DataFrame fixture + parser tests (no live Grafana)

**Parent rewrite.** The first draft invented `src/client/alertHistorian.ts`, `parseHistorianFrames`, and a Prometheus `query_range` matrix. **Those files/APIs do not exist.** Production path is:

- HTTP: `GET /api/v1/rules/history?ruleUID=:uid` (`GrafanaAlertsApi.getAlertRuleHistory`)
- Parser: module-private `parseHistoryFrame` / `unwrapHistoryFrame` in `src/grafana/GrafanaAlertsApi.ts`
- Shape: Grafana **DataFrameJSON** `{ schema: { fields }, data: { values } }`, optionally wrapped as `{ results: <frame> }`
- Existing coverage: `test/grafana/GrafanaAlertsApi.test.ts` already has an inline DataFrameJSON case

**Goal.** Commit a redacted golden JSON (the shape we will recapture from Grafana 11.5.2 in Task 5) and drive the parser from that file so a later live recapture is a file swap, not a test rewrite. **Do not** call live Grafana. **Do not** invent a second parser.

**DoD.** Fixture committed; tests load it via `readFileSync` (Vitest, `test/` tree — **not** Mocha/`src/test`); `results` wrapper also accepted; unrecognized shapes still throw `invalid-response`; `npm test` green; no network.

### Files

| Path | Action |
|---|---|
| `test/fixtures/alert-history-dataframe.json` | **Create** (DataFrameJSON, no tokens) |
| `test/fixtures/alert-history-results-wrapper.json` | **Create** (`{ "results": <same frame> }`) |
| `test/grafana/GrafanaAlertsApi.test.ts` | Patch — load fixtures instead of (or in addition to) inline JSON |
| `src/grafana/GrafanaAlertsApi.ts` | Read-only unless a real 11.5.2 field name is missing from `parseHistoryFrame` — then add the alias with a comment, do not expand product scope |

### Fixture `test/fixtures/alert-history-dataframe.json`

Match the existing unit-test shape (column-oriented DataFrameJSON). Times are epoch **ms**. No URLs, cookies, or tokens.

```json
{
  "schema": {
    "fields": [
      { "name": "time", "type": "time" },
      { "name": "current", "type": "string" },
      { "name": "labels", "type": "other" }
    ]
  },
  "data": {
    "values": [
      [1700000000000, 1700000060000, 1700000120000],
      ["Alerting", "Pending", "Normal"],
      [
        { "alertname": "HighErrorRate", "label_env": "lab" },
        { "alertname": "HighErrorRate", "label_env": "lab" },
        { "alertname": "HighErrorRate", "label_env": "lab" }
      ]
    ]
  }
}
```

`test/fixtures/alert-history-results-wrapper.json`:

```json
{ "results": { "...paste the same frame object..." } }
```

(Keep the inner object identical so a byte-level recapture can replace both files.)

### Tests to add in `test/grafana/GrafanaAlertsApi.test.ts`

Reuse the file's existing `listen` HTTP harness (do **not** export `parseHistoryFrame` unless you must — prefer going through `client.getAlertRuleHistory` so the GET path stays covered).

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dataframeFixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'test/fixtures/alert-history-dataframe.json'), 'utf8')
) as unknown;
const wrappedFixture = JSON.parse(
  readFileSync(resolve(process.cwd(), 'test/fixtures/alert-history-results-wrapper.json'), 'utf8')
) as unknown;

it('getAlertRuleHistory() parses the committed DataFrameJSON fixture (NEXT-Q-09 offline)', async () => {
  server = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(dataframeFixture));
  });
  const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });
  await expect(client.getAlertRuleHistory('r1')).resolves.toEqual([
    { time: 1700000000000, state: 'Alerting', labels: { alertname: 'HighErrorRate', label_env: 'lab' } },
    { time: 1700000060000, state: 'Pending', labels: { alertname: 'HighErrorRate', label_env: 'lab' } },
    { time: 1700000120000, state: 'Normal', labels: { alertname: 'HighErrorRate', label_env: 'lab' } }
  ]);
});

it('getAlertRuleHistory() unwraps a { results: frame } envelope from the committed wrapper fixture', async () => {
  server = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(wrappedFixture));
  });
  const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });
  const entries = await client.getAlertRuleHistory('r1');
  expect(entries).toHaveLength(3);
  expect(entries[0]?.state).toBe('Alerting');
});
```

Keep the existing inline DataFrameJSON test — it is the contract. The new tests prove the **file** is loadable.

If Task 5 later recaptures a live 11.5.2 payload whose field is `state` or `line` instead of `current`, replace the fixture and keep the parser's `findIndex` aliases (`current|state|line` already exist). Do not add PromQL matrix parsing.

### Tests to run

```bash
npx vitest run test/grafana/GrafanaAlertsApi.test.ts
npm run typecheck && npm test
```

Expect 709 + 2. Do **not** update the README test badge here unless Task 1 already landed and you are in the same branch — mention the new count in the commit body.

**Forbidden:** Mocha/`src/test/` layout; `src/client/alertHistorian.ts`; network calls; marking live DoD 9 done.

### Commit

```
test: add offline alert-history DataFrame fixtures for rules/history parser
```

---

## Suggested sequence

1 → 3 → 4 (docs) in one PR is fine; **2** can ride along; **5** compose+checklist; **6** independent (code + test).

Do not combine Task 6 production parser changes with Task 5 Docker pins in the same commit.

## Out of scope (later tasks)

Alert tree filter, `openInIde` `alertRule`, embed 401 HTML, MCP first-run modal, walkthrough, usage.md UX sync, i18n inject, CI VSIX, ADR-010, Explore-in-IDE, `engines`, nonce tests, listing pagination, favorites, time-range picker, default instance, folders soft-fail, ADR-008.
