# AT Grafana — Agent-executable follow-up implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Implement **one task at a time**. Track progress with the checkboxes in the part files. Do not skip verification (`npm run typecheck` and `npm test` unless the task says otherwise).

**Goal:** Take AT Grafana from “internally usable 0.1.3 + Wave 0–3” to a **provable, installable 0.2.x** without reopening V1 non-goals. An implementing agent should be able to land each task from the part file alone.

**This document is the index.** Detailed steps, snippets, tests, and commit messages live in:

| Part | Tasks | File |
|---|---|---|
| A — 0.1.4 verification & honesty | 1–6 | [2026-08-27-agent-implementation-plan-a.md](2026-08-27-agent-implementation-plan-a.md) |
| B — 0.2.0 IDE / Agent / consent | 7–12 | [2026-08-27-agent-implementation-plan-b.md](2026-08-27-agent-implementation-plan-b.md) |
| C — i18n, CI, telemetry ADR, Explore, engines | 13–18 | [2026-08-27-agent-implementation-plan-c.md](2026-08-27-agent-implementation-plan-c.md) |
| D — pagination, bookmarks, defaults, ADRs, smoke pin | 19–26 | [2026-08-27-agent-implementation-plan-d.md](2026-08-27-agent-implementation-plan-d.md) |

**Analysis / roadmap (do not re-implement Wave 0–3):**

- [2026-08-27-perf-completeness-ux-optimization.md](2026-08-27-perf-completeness-ux-optimization.md) — already **Implemented** on `cursor/implement-optimizations-ef26`
- [2026-08-27-followup-completeness-roadmap.md](2026-08-27-followup-completeness-roadmap.md) — product ranking
- [2026-08-27-live-smoke-checklist.md](2026-08-27-live-smoke-checklist.md) — human DoD 1/2/3/9

**Tech stack:** TypeScript, Zod, Vitest, existing Bridge / `GrafanaApiClient` / Hub Protocol v1, VS Code contribution points.

**Branch:** stack on `cursor/implement-optimizations-ef26` (or current HEAD that already contains Wave 0–3). **Never start from `master` / `main`.** Suggested working branch: `feat/followup-0.2` (or `cursor/<task-name>-ef26` if using the cloud agent naming policy).

**Out of scope for this entire plan (code):**

- Dashboard / rule / datasource CRUD, ack, pause
- Implementing Alertmanager silence (Task 24 writes **ADR-008 text only**)
- Grafana Live WebSocket proxy (Task 25 documents refusal only)
- Official 50-tool catalog, Tempo typed tools, OnCall/Sift/Incident
- `d-solo` panel embed, multi-org `X-Grafana-Org-Id`, base/mcp dual variant
- `vsce publish` / `ovsx publish`
- Telemetry implementation
- Re-doing Wave 0–3 (keep-alive TOFU, `get_alert_rule.data`, Test Connection TOFU, context menus, embed cache, etc.)

---

## Sequencing (do not parallelize across a shared file)

```
Part A
  T1, T2, T3  ── parallel (disjoint files)
  T4          ── after T3; HUMAN gate (publisher id)
  T5          ── after compose pin; Docker + HUMAN DoD rows
  T6          ── after T5 fixture exists

Part B
  T7 → T8 → T9 → T10  ── serial (all edit extension.ts; T9 then T13 share GrafanaEmbedProxy)
  T11                 ── after T7 (both edit package.json nls)
  T12                 ── after T7–T11 (documents the new UX)

Part C
  T13                 ── after T9 if T9 landed (merge 401 copy into GrafanaEmbedProxyCopy; never two injection bags)
  T14 → T17           ── serial (.github/workflows/ci.yml)
  T15, T18            ── independent
  T16                 ── AFTER T8 and T13 (deeplink dispatch + html/proxy)

Part D
  T19                      ── independent
  T20 → T21                ── serial (contextValue dashboardFavorite)
  T22                      ── independent of T20
  T23                      ── independent
  T24, T25                 ── docs only, independent
  T26                      ── if T5 already pinned compose, only add workflow; do NOT re-pin a different Grafana tag
```

**Grafana image pin (one source of truth):** Task 5 pins `grafana/grafana:11.5.2` (and Prometheus + Loki historian) so captured fixtures cite an exact tag. If Task 5 has not run, Task 26 may pin compose **to that same 11.5.2 pair**, not a newer 13.x, unless a human explicitly bumps and re-captures fixtures.

**ADR numbers (do not steal):**

| ADR | Topic | Task |
|---|---|---|
| 008 | Alert silence write gate (Proposed, no code) | 24 |
| 009 | Query limit calibration | 5 |
| 010 | Zero telemetry | 15 |

If Task 1 already added a README telemetry bullet, Task 15 only adds the ADR and a link — do not duplicate the bullet.

**ADR-009:** write it in Task 5 (or immediately after the human smoke) only when 12h/5MiB calibration has a conclusion — even if the conclusion is “keep defaults”. Do not steal the number for unrelated docs.

---

## How a later agent executes this plan

1. Read **this index** end-to-end, then open **one** part file.
2. Stack a branch on `cursor/implement-optimizations-ef26` (must already contain Wave 0–3). **Never start from `master`.** Cloud-agent branch names: `cursor/<task-slug>-ef26`.
3. Implement **one task**, tick its `- [ ]` boxes, run `npm run typecheck && npm test`, commit with the message in the part file, then stop or continue to the next **unshared-file** task.
4. When two tasks share a hot file, finish and commit the earlier one first (see File ownership).
5. Skip every **HUMAN** checkbox. Do not tick DoD 1/2/3/9. Do not `vsce publish`.
6. Sub-agents used to **write** this plan used `claude-fable-5-thinking-xhigh`. Implementation may use whatever the operator sets; still follow the part file literally.

**Parent corrections applied after sub-agent drafts (do not revert):**

| Item | Wrong in a draft | Canonical |
|---|---|---|
| SKILL path | `.cursor/skills/at-grafana/SKILL.md` | `skills/at-grafana-mcp/SKILL.md` |
| ADR path | `docs/adr/010-…` | `docs/decisions/ADR-010-zero-telemetry.md` |
| Task 6 parser | invented `src/client/alertHistorian.ts` / Prom `query_range` | `GrafanaAlertsApi.parseHistoryFrame` + `GET /api/v1/rules/history` DataFrameJSON |
| Task 2 tools | `grafana_list_alert_instances`, `grafana_open_in_ide` | `grafana_list_alert_rules` + `grafana_generate_deeplink` |
| `docs/design.md` | Task 1 patched it | **file does not exist** — skip |
| Grafana pin | Task 26 suggested 13.2.0 | **11.5.2** only |
| engines | “^1.90” | keep `^1.85.0` unless a human raises it |
| Proxy i18n | T9 `strings` vs T13 `copy` | **one** injected copy table |

---

## File ownership (hot files)

| File | Tasks that edit it |
|---|---|
| `src/extension.ts` | 7, 8, 10, 13, 16, 20, 21, 22 |
| `src/agent/GrafanaAgentToolService.ts` | 8, 16, 19, 22 |
| `src/mcp/bridgeSchemas.ts` / `toolCatalog.ts` | 2, 8, 16, 19, 22 |
| `src/webview/GrafanaEmbedProxy.ts` | 9, 13, 16 |
| `src/tree/AlertTreeProvider.ts` | 7, 22, 23 |
| `src/tree/DashboardTreeProvider.ts` | 20, 22, 23 |
| `package.json` | 4 (gated), 5 (gated defaults), 7, 11, 17, 20, 21, 22 |
| `l10n/bundle.l10n.zh-cn.json` | 7, 9, 10, 13, 16, 20, 21, 22, 23 |
| `docker-compose.smoke.yml` | 5 then 26 (same pin) |

When two tasks share a file, finish and commit the earlier task before starting the later one.

---

## Global implementation rules

1. User-visible strings go through `t()` and `l10n/bundle.l10n.zh-cn.json`. `package.json` contributes titles use `%nls%` keys in both `package.nls.json` and `package.nls.zh-cn.json`. Run `npx vitest run test/i18n/nls.test.ts` after nls edits.
2. Keep tools `risk: read` except the ADR-008 **document**, which forbids write tools until Accepted.
3. Do not import `vscode` into `GrafanaHttpClient`, `GrafanaEmbedProxy` (except via injected plain strings), `grafanaDeeplink.ts`, or `GrafanaAgentToolService`.
4. After every task: `npm run typecheck` && `npm test` (Task 5 live suite must stay `skipIf` without env vars).
5. Commit per task using the message in the part file.
6. Steps marked **HUMAN** stay unchecked; report them; do not fake DoD 1/2/3/9.

---

## Suggested 0.2.0 cut line

Must land before calling the tree “0.2.0”: **Tasks 1–3, 5–13, 14, 15** (and T4 if publisher id exists).  
0.2.x: **16–23, 26**.  
V2 prep only: **24–25**.
