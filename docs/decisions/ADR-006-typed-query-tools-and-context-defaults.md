# ADR-006: Typed Prom/Loki query tools and context-window defaults

## Status
Accepted

## Date
2026-08-20

## Context

V1 (ADR-004, requirements D8) exposed a single generic datasource proxy so Agents could reach any Grafana datasource by constructing native HTTP `path`/`query`/`body`. That is flexible and is the load-bearing security boundary (GET/POST allowlist + path confinement).

grafana/mcp-grafana's production lessons for the same SRE workflows:

1. Defaulting dashboard reads to full JSON wastes context. Prefer a compact projection.
2. Dashboard *search* beats listing every dashboard.
3. Agents invent wrong Prometheus/Loki paths when the tool is a raw HTTP proxy. Typed tools (`query_prometheus`, `query_loki_logs`) with time range as first-class parameters succeed more often.
4. Shipping 40–50 tools into `tools/list` is itself a context problem (grafana/ai-marketplace warns about this). AT Series Hub progressive select is the right scale; we add two tools, not fifty.

Requirements §6 item 8 already excluded *non*-Prom/Loki typed wrappers. This ADR adds the Prom/Loki wrappers V1 left to the generic proxy.

## Decision

1. **`grafana_get_dashboard` default `fields` is `targets`.** Callers that need the complete model must pass `fields: "full"`. Projection still happens after `GET /api/dashboards/uid/:uid` (Grafana has no summary endpoint we use).
2. **`grafana_list_dashboards` accepts optional `query`, `tag`, `folderUid`.** These map to Grafana `/api/search` `query`, `tag`, `folderUIDs`. `type=dash-db` remains implied. The Agent path stays on unpaged `search()` (Grafana's default page size), not `searchAll()`.
3. **Add `grafana_query_prometheus` and `grafana_query_loki` (`risk: read`).** Each builds a confined proxy call (`api/v1/query` / `api/v1/query_range` or `loki/api/v1/query` / `loki/api/v1/query_range`) and then uses the existing `queryDatasource` pipeline (rate limit, `planQueryLimits`, size cap, path confinement). They never call Grafana except through that pipeline.
4. **Keep `grafana_query_datasource` unchanged** as the escape hatch for other datasources and unusual Prom/Loki endpoints (metadata, labels, custom paths).
5. **Do not** add metric/label discovery, annotations, deeplink, or write tools in the same change set.

## Consequences

- Breaking: Agents that called `grafana_get_dashboard` without `fields` previously received the full model. They now receive `targets`. Explicit `fields: "full"` restores the old shape.
- Catalog grows 9 → 11 tools, all still `risk: read` / autoApprove.
- D8 is narrowed: the *transport* remains a generic proxy; Prom/Loki *Agent-facing* tools are typed.
