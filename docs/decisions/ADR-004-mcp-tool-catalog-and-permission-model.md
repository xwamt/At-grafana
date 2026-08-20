# ADR-004: MCP tool catalog and permission model

## Status
Accepted

## Date
2026-07-29

## Context

Requirements (see `docs/requirements.md` §4.4/§4.5) split MCP tools into two families serving two different kinds of agents:

- **Grafana management tools** — for an agent that inspects/reasons about Grafana's own configuration (which dashboards exist, what a dashboard's panels actually query, what alert rules are defined and how they're currently firing).
- **Monitoring data tools** — for an agent that analyzes the actual metrics/logs behind Prometheus/Loki-style datasources, using Grafana purely as the aggregation/auth boundary in front of those datasources.

Separately, the series has an established precedent (`at-terminal-series`, 0.2.17) for gating background Agent access per managed target: SSH servers require an explicit "Allow background connections" checkbox before `list_ssh_servers`/`run_remote_command` can reach them in the absence of an actively open terminal. AT-Grafana needed an equivalent decision: should Agent tool calls require a Webview panel to be open first (mirroring "front-end must be connected"), or should there be an independent background-access toggle, or neither?

## Decision

### Permission model

Each configured Grafana instance has one boolean setting: **`allowBackgroundAccess`** (default `false`).

- When `false`: the instance does not appear in `grafana_list_instances`, and any tool call naming that `instanceId` explicitly fails with a `VALIDATION_ERROR`-class authorization error. This holds **regardless of whether a Webview panel for that instance happens to be open** — unlike AT Terminal, there is no "front-end connection" concept that substitutes for the toggle, because Grafana tool calls are not tied to a stateful connection/session the way an SSH terminal is.
- When `true`: **all** `risk=read` tools for that instance are callable by the Agent at any time, with no requirement that any panel be open. This is intentional: requirement S4 (`docs/requirements.md` §2.2) is unattended/background monitoring analysis, which is incompatible with a "must have a panel open" gate.

This is a deliberate, explicit divergence from the "front-end connected OR background toggle" dual-path model used by `at-terminal-series` for `run_remote_command`. That dual path exists there because SSH exec is `risk=exec` and highly sensitive; every AT-Grafana V1 tool is `risk=read`, so a single per-instance toggle is a sufficient and simpler control.

### Tool catalog (all `risk=read`, prefix `grafana_`, per [ADR-005](ADR-005-at-series-hub-protocol-v1-adoption.md) pluginId `at.grafana`)

**Discovery**

| Tool | Purpose |
|---|---|
| `grafana_list_instances` | List instances with `allowBackgroundAccess=true` (id/label/url only, never the token) |

**Grafana management family**

| Tool | Purpose |
|---|---|
| `grafana_list_dashboards` | List dashboards grouped by folder (uid/title/tags/folder). Optional `query` / `tag` / `folderUid` mapped to Grafana `/api/search`. |
| `grafana_get_dashboard` | Dashboard by uid. Optional `fields`: `targets` (default) / `summary` / `full`; optional `panelIds` / `titleContains` filter. Pass `fields: "full"` for the complete model (see ADR-006). |
| `grafana_list_folders` | Folder tree |
| `grafana_list_alert_rules` | All alert rules + current state |
| `grafana_get_alert_rule` | Full rule definition (condition, for, labels, annotations, notification policy refs) |
| `grafana_get_alert_history` | State-change/event history for a rule |

**Monitoring data family**

| Tool | Purpose |
|---|---|
| `grafana_list_datasources` | uid/name/type/url only, never credentials |
| `grafana_query_prometheus` | Typed PromQL: `instanceId` + `datasourceUid` + `expr` + `queryType` (`instant`\|`range`, default `range`) + optional `start`/`end`/`step`/`time`. Builds a confined proxy call to `api/v1/query` or `api/v1/query_range`, then uses the existing `queryDatasource` pipeline. |
| `grafana_query_loki` | Typed LogQL: `instanceId` + `datasourceUid` + `expr` + `queryType` (default `range`) + optional `start`/`end`/`time`/`limit`/`direction`. Builds a confined proxy call to `loki/api/v1/query` or `loki/api/v1/query_range`, then uses the existing `queryDatasource` pipeline. |
| `grafana_query_datasource` | Escape hatch for other datasources and unusual Prom/Loki endpoints (metadata, labels, custom paths). Generic pass-through to `/api/datasources/proxy/uid/<uid>/<path>`. Inputs: `instanceId`, `datasourceUid`, `method` (`GET`\|`POST` only), `path`, `query`/`body`. |

Typed Prom/Loki tools and the default dashboard projection are specified in [ADR-006](ADR-006-typed-query-tools-and-context-defaults.md); this ADR still owns authorization, path confinement, and `risk=read`.

### Safety constraints on `grafana_query_datasource`

- Method allowlist `{GET, POST}` enforced in the Bridge handler itself (not left to the agent's discretion) — any other method returns `422 VALIDATION_ERROR` before any request reaches Grafana.
- **Path confinement**: `path` must resolve under `/api/datasources/proxy/uid/<datasourceUid>/`. `..`, `\`, and the percent-encoded separator forms (`%2e`/`%2f`/`%5c`) are rejected, and the joined path is re-checked against that prefix *after* URL normalization. Enforced in three places: the Zod/JSON-Schema `path` constraint at the Bridge transport layer, an input check in `GrafanaDatasourcesApi.proxyDatasourceRequest`, and the post-join assertion in `buildDatasourceProxyPath`.

  This constraint is load-bearing for the `risk=read` classification below, and it was **absent** until 2026-08-13. Without it `path` normalized through `new URL(...)`, so `POST ../../../../../api/auth/keys` reached Grafana's Admin API under the instance's Service Account Token — enough to mint a long-lived API key, overwrite dashboards via `/api/dashboards/db`, or silence alerts. The caller here is an Agent, so the input may be attacker-authored (a poisoned dashboard description, an injected log line) rather than merely mistaken.
- Default and maximum time-range and response-size caps are enforced in the Bridge (exact default values are an implementation parameter tracked in the implementation plan, not re-litigated here); requests exceeding the cap are truncated with an explicit truncation notice in the tool result rather than silently dropped or hard-failed, so the agent can retry with a narrower range.
- Tool is `risk=read` because, **given the path confinement above**, the reachable surface is the datasource's own query API, and the allowed methods cannot mutate Grafana or datasource state there (Prometheus/Loki query APIs are read operations even when issued as `POST`). Note this is a property of the *Grafana* surface only: what an arbitrary datasource exposes under its own proxy subtree is not enumerated. A per-datasource-type endpoint allowlist (which Prometheus/Loki paths to permit) is the natural next tightening and needs its own ADR.

### V1 write scope

No tool in this catalog creates, updates, deletes, silences, or pauses anything. This is a hard V1 boundary (`docs/requirements.md` §6, non-goals #1–#2); any future write/exec tool requires a new ADR and revisits [ADR-002](ADR-002-single-build-variant.md)'s single-build-variant reasoning.

## Consequences

- Every V1 tool qualifies for the Hub installer's default `autoApprove` set (Protocol v1 §6/§9.2: `risk=read` → auto-approved), so a fresh `AT Series: Install/Repair MCP Config` run makes the full catalog usable without per-tool manual approval.
- The per-instance toggle is the *only* authorization gate in V1. It must be enforced at the Bridge invoke layer (`AgentToolService`-equivalent), not just hidden from `grafana_list_instances` — an agent that already knows an `instanceId` (e.g. from a previous session before the toggle was disabled) must still be rejected.
- Because there is no "open panel" gate, background monitoring/analysis (requirement S4) works out of the box once a user opts an instance in — this is the intended trade-off versus stricter-but-less-useful gating.
