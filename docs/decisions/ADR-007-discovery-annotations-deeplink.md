# ADR-007: Metric/label discovery, annotations, deeplink, and alert-state filters

## Status
Proposed

## Date
2026-08-20

## Context

ADR-006 shipped typed Prom/Loki *query* tools and context-window defaults, and deferred metric/label discovery, annotations, and deeplink so the P0 catalog stayed at 11 tools.

Those deferred items are the remaining P1 gaps versus grafana/mcp-grafana for SRE workflows that have no dashboard (blind PromQL/LogQL), that need deploy markers on a time window, that must not dump every alert rule into context, and that should not invent Grafana URLs.

Official mcp-grafana also ships metric metadata, Prometheus label-*name* listing, annotation tags, and annotation *write* tools. Shipping all of those would repeat the 40–50 tool context problem ADR-006 already rejected.

Full behavioral spec: [docs/specs/2026-08-20-mcp-p1-official-alignment-design.md](../specs/2026-08-20-mcp-p1-official-alignment-design.md).

## Decision

1. **Four typed discovery tools** (`risk: read`), each building a confined datasource-proxy `GET` and then using the existing `queryDatasource` pipeline:
   - `grafana_list_prometheus_metric_names` → `api/v1/label/__name__/values`
   - `grafana_list_prometheus_label_values` → `api/v1/label/<label>/values` (`label` allowlisted `^[a-zA-Z_][a-zA-Z0-9_]*$`)
   - `grafana_list_loki_label_names` → `loki/api/v1/labels`
   - `grafana_list_loki_label_values` → `loki/api/v1/label/<label>/values`
   Results are `{ values: string[], truncated?: true }`, optional post-fetch `regex`, hard cap 200. Do not add metric metadata or Prometheus label-*names* tools.

2. **`grafana_list_annotations` (`risk: read`)** — `GET /api/annotations` with optional `from`/`to` (epoch ms), `dashboardUid` → `dashboardUID`, single `tag` → `tags`, `limit` ≤ 100. No create/update.

3. **`grafana_generate_deeplink` (`risk: read`)** — local URL construction from the instance base URL (`dashboard` or `explore`). Always returns `grafanaUrl`. Optional `openInIde` (default false) invokes the existing `atGrafana.openDashboard` command via an injected callback; Explore cannot open in the IDE. A failed or missing callback still returns the URL with `openedInIde: false`.

4. **`grafana_list_alert_rules` gains optional `states`** — non-empty array of `firing | pending | normal | unknown`, applied after the existing `normalizeAlertState` correlation. Omitted `states` keeps today’s full list.

5. **Keep `grafana_query_datasource` as the escape hatch** for metadata and other label APIs. Do not add write tools.

ADR-006 item 5 (“do not add metric/label discovery, annotations, deeplink in the same change set”) applied to the P0 commit set only. This ADR is the P1 change set.

## Consequences

- Catalog grows 11 → 17 tools, all still `risk: read` / autoApprove.
- Discovery traffic is metered like queries (rate limit + response size). Label APIs are not range-clamped.
- `openInIde` is an IDE side effect, not a Grafana mutation; default off so generating a link does not steal focus.
- Agents that listed every alert rule without `states` still get the full list (non-breaking).
