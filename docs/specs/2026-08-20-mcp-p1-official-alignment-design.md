# MCP P1 Official Alignment — Design

**Date:** 2026-08-20  
**Status:** Draft for review (not implemented)  
**Branch:** `feat/mcp-p1-official-alignment` (stacked on P0 `feat/mcp-p0-official-alignment`)  
**Decision record:** [ADR-007](../decisions/ADR-007-discovery-annotations-deeplink.md)

## 1. Goal

Close the four remaining P1 gaps versus grafana/mcp-grafana, without copying its 50-tool dump or any write tools:

1. Prometheus/Loki metric and label discovery so S4 analysis works when there is no dashboard.
2. `grafana_generate_deeplink` that always returns a Grafana URL, with optional `openInIde` to open the existing AT Grafana Webview.
3. Read-only annotations (`GET /api/annotations`) for correlating deploys / events with a time window.
4. Optional `states` filter on `grafana_list_alert_rules` (same `firing | pending | normal | unknown` set the tree already uses).

The fifth original P1 item — compose official `grafana/skills` instead of duplicating PromQL docs — is already done in P0 (`skills/at-grafana-mcp/references/compose-grafana-skills.md`). This spec does not redo it; implementation only adds tool-selection rows for the new tools.

## 2. Context

P0 (ADR-006) added typed Prom/Loki *query* tools, dashboard search, and default `targets` projection. It explicitly deferred discovery, annotations, and deeplink. Official mcp-grafana exposes many more tools (`list_prometheus_metric_metadata`, `list_prometheus_label_names`, `get_annotation_tags`, `create_annotation`, …). AT Grafana keeps a thin catalog: four discovery tools, one annotations tool, one deeplink tool, and a filter parameter on the existing alert list.

Catalog after this change: **17 tools**, all `risk: read` / autoApprove.

| Family | Count | Members |
|---|---|---|
| Discovery (instances) | 1 | `grafana_list_instances` |
| Management | 8 | existing six dashboard/alert tools + `grafana_list_annotations` + `grafana_generate_deeplink` |
| Monitoring | 8 | existing four + four discovery tools |

(`grafana_list_instances` stays in `AT_GRAFANA_MANAGEMENT_TOOL_NAMES` as today; README continues to list it as the instance-discovery row. Requirements DoD becomes 9 management including instance list + 8 monitoring = 17.)

## 3. Catalog and inputs

### 3.1 `grafana_list_prometheus_metric_names`

- Required: `instanceId`, `datasourceUid`
- Optional: `regex` (JS `RegExp` source, no flags; invalid pattern → `VALIDATION_ERROR`), `start`, `end` (strings, same as typed query tools; omitted if unset)
- Builder path: `GET api/v1/label/__name__/values`
- Result: `{ values: string[], truncated?: true }` after optional regex filter, capped at **200**

### 3.2 `grafana_list_prometheus_label_values`

- Required: `instanceId`, `datasourceUid`, `label` matching `^[a-zA-Z_][a-zA-Z0-9_]*$`
- Optional: `matcher` (single Prometheus series selector, sent as query key `match[]`), `start`, `end`, `regex`
- Builder path: `GET api/v1/label/<label>/values` (`label` is interpolated only after the regex check)
- Result: same `{ values, truncated? }` shape and cap

### 3.3 `grafana_list_loki_label_names`

- Required: `instanceId`, `datasourceUid`
- Optional: `start`, `end`, `regex`
- Builder path: `GET loki/api/v1/labels`
- Result: same list shape and cap

### 3.4 `grafana_list_loki_label_values`

- Required: `instanceId`, `datasourceUid`, `label` (same regex as Prom labels)
- Optional: `start`, `end`, `regex`
- Builder path: `GET loki/api/v1/label/<label>/values`
- Result: same list shape and cap

Not added (escape hatch `grafana_query_datasource` remains): `list_prometheus_metric_metadata`, `list_prometheus_label_names`, `get_annotation_tags`.

### 3.5 `grafana_list_annotations`

- Required: `instanceId`
- Optional: `from`, `to` (**integers, Unix epoch ms**), `dashboardUid` (maps to Grafana query key `dashboardUID`), `tag` (single tag, maps to Grafana `tags`), `limit` (positive int, **max 100**, default 100). The HTTP layer stringifies `from`/`to`/`limit` for `GrafanaHttpClient` (`Record<string, string | undefined>`).
- HTTP: `GET /api/annotations` via a new `GrafanaAnnotationsApi` on the existing `GrafanaHttpClient` (not the datasource proxy)
- Result items: `{ id, time, timeEnd?, text, tags, dashboardUID?, panelId? }`
- No create / update / delete

### 3.6 `grafana_generate_deeplink`

- Required: `instanceId`, `kind` (`dashboard` | `explore`)
- Dashboard: required `uid`; optional `panelId` (number), `from`, `to` (Grafana time strings, e.g. `now-1h` / epoch ms)
- Explore: required `datasourceUid`; optional `from`, `to` (default range in the Explore payload: `now-1h` .. `now`)
- Optional: `openInIde` (boolean, **default false**), `title` (used only when opening a dashboard Webview)
- Always returns `{ grafanaUrl: string, openedInIde: boolean }`
- `openInIde: true` is valid only for `kind: dashboard` with `uid`. Explore + `openInIde` → `VALIDATION_ERROR`
- URL construction is local (instance `url` from config). No Grafana HTTP.
  - Dashboard: `{origin}/d/{uid}` plus query `viewPanel`, `from`, `to` when present. `origin` is the instance base URL with no trailing slash.
  - Explore: `{origin}/explore?left=` + URL-encoded JSON `{ datasource: datasourceUid, queries: [{ refId: "A", datasource: { uid: datasourceUid } }], range: { from, to } }`
- When `openInIde` is true, call injected `openDashboardInIde({ instanceId, uid, title, search })` where `search` is the same query string (`viewPanel`/`from`/`to`) so the embed matches the Grafana URL. The callback wraps `atGrafana.openDashboard`. If the callback throws or is missing, still return `ok: true` with `grafanaUrl` and `openedInIde: false` plus a short `message`.

### 3.7 `grafana_list_alert_rules` (existing)

- Add optional `states`: non-empty array of `'firing' | 'pending' | 'normal' | 'unknown'`
- Empty array or unknown member → `VALIDATION_ERROR`
- Omit `states` → current unfiltered list (backward compatible)
- Filter **after** `correlateAlertState` / `normalizeAlertState` (OR across the array)

## 4. Data flow

```
Bridge POST /invoke
  → GrafanaAgentToolService.withAuthorizedClient (allowBackgroundAccess + token)
  → tool-specific work
```

**Discovery tools:** `buildPrometheusMetricNamesCall` / `buildPrometheusLabelValuesCall` / `buildLokiLabelNamesCall` / `buildLokiLabelValuesCall` → existing private `queryDatasource` (rate limit, `maxResponseBytes`, path confinement). `QueryLimits` range clamp stays limited to the four query/query_range endpoints; label APIs are unrecognized paths and must not be rewritten. After a successful proxy result, parse Prometheus/Loki `{ status, data: string[] }` (or Loki's label API equivalent), apply regex, cap at 200.

**Annotations:** `client.listAnnotations(parsed)` → `GET /api/annotations`.

**Deeplink:** `buildGrafanaDeeplink(instance.url, parsed)` then optional IDE callback. Does not use `queryDatasource`.

**Alert filter:** existing dual fetch + correlate, then filter.

## 5. Error handling

| Case | Result |
|---|---|
| Unknown instance / background access off | Existing indistinguishable `VALIDATION_ERROR` |
| Bad `label`, invalid `regex`, empty `states`, explore+`openInIde` | `VALIDATION_ERROR` before network |
| Grafana 4xx/5xx | Existing `GrafanaApiError` → `toFailure` |
| Discovery response body over `maxResponseBytes` | Existing `{ truncated: true, reason: 'response-size' }` envelope |
| Discovery list longer than 200 after filter | `{ values, truncated: true }` (not the size envelope) |
| `openDashboardInIde` throws or is omitted | Tool still `ok: true`; `openedInIde: false`; optional `message` |

## 6. File map

| File | Responsibility |
|---|---|
| `src/grafana/typedDatasourceDiscovery.ts` | Pure builders + label regex + list cap helper |
| `src/grafana/grafanaDeeplink.ts` | Pure URL builder |
| `src/grafana/GrafanaAnnotationsApi.ts` | Annotations HTTP |
| `src/grafana/GrafanaApiClient.ts` | Facade `listAnnotations` |
| `src/mcp/bridgeSchemas.ts` | Zod + JSON Schema twins; alert `states` |
| `src/mcp/toolCatalog.ts` | 17 entries |
| `src/agent/GrafanaAgentToolService.ts` | Dispatch; `openDashboardInIde?` dep |
| `src/extension.ts` | Inject callback → `atGrafana.openDashboard` |
| `skills/at-grafana-mcp/references/tool-selection.md` | Discovery before query; deeplink defaults |
| `docs/decisions/ADR-007-discovery-annotations-deeplink.md` | This decision |
| `docs/decisions/ADR-004-*.md`, `docs/requirements.md` | Catalog / MGT / MON / DoD 17 |
| README + features/usage EN+zh-CN | 17-tool copy |

Do not change `GrafanaHttpClient` query typing, `DATASOURCE_PROXY_PATH_DENY_PATTERN`, or `QUERY_ENDPOINTS`.

`GrafanaApiClientLike` gains `listAnnotations` only. The IDE opener is a service dependency, not a client method, so unit tests stay vscode-free.

## 7. Testing

TDD per tool group. Minimum cases:

- Builders: exact paths; rejected labels (`..`, `job/name`, empty); `match[]` only as query, never path; `__name__` only on the metric-names builder.
- Schemas: required fields; `states` min 1; `openInIde`+explore rejected; `queryType` unchanged on existing tools.
- Agent service: discovery calls `proxyDatasourceRequest` with builder path; cap 200 sets `truncated`; annotations forwards `dashboardUID`; deeplink URL; `openInIde` invokes callback with search string; callback throw still returns URL; `states: ['firing']` drops pending/normal; omitted `states` returns all.
- Bridge integration: `tools.length === AT_GRAFANA_TOOL_CATALOG.length`; one metric-names invoke; one list_alert_rules with `states`.
- Disabled-instance loop includes the six new names.

## 8. Out of scope

- Write tools (`create_annotation`, dashboard write, silence)
- Official extras: metric metadata, Prom label *names*, annotation tags, Loki stats/patterns, Tempo/OnCall/Sift
- Opening Explore or alert detail in the IDE (`openInIde` is dashboard-only)
- Changing Hub / `at-series-mcp-hub`
- Uncapping Grafana `/api/search` / switching Agent dashboard list to `searchAll`

## 9. Implementation order

1. ADR-007 + requirements / ADR-004 catalog text  
2. Discovery builders + schemas + catalog + `queryDatasource` dispatch  
3. Annotations API + tool  
4. Deeplink builder + optional IDE callback  
5. Alert `states` filter  
6. Skill + user docs (17 tools)  
7. Full `typecheck` / `npm test` / grep for leftover “11 tools” in live docs  

Tasks 3 and 4 do not share production files with each other after task 2 lands; they may run in parallel. Task 5 touches `bridgeSchemas` / service / catalog descriptions already edited in 2–4, so it stays serial after those.

## 10. Spec self-review

- No TBD/TODO in behavioral rules; Explore URL shape and list cap (200) / annotation limit (100) are explicit.
- ADR-006’s “do not add discovery in the same change set” is P0-only; ADR-007 supersedes it for this branch.
- Catalog math: 11 + 4 discovery + 1 annotations + 1 deeplink = 17; alert filter is not a new tool.
- `folderUid` vs `folderUIDs` (P0) is mirrored by `dashboardUid` vs `dashboardUID` here — TypeScript uses camelCase `Uid`, Grafana query keys use Grafana’s spelling.
