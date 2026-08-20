import type { ToolCatalogEntry } from '@at-series/mcp-hub';
import {
  GRAFANA_GET_ALERT_HISTORY_INPUT_SCHEMA,
  GRAFANA_GET_ALERT_RULE_INPUT_SCHEMA,
  GRAFANA_GET_DASHBOARD_INPUT_SCHEMA,
  GRAFANA_LIST_ALERT_RULES_INPUT_SCHEMA,
  GRAFANA_LIST_ANNOTATIONS_INPUT_SCHEMA,
  GRAFANA_GENERATE_DEEPLINK_INPUT_SCHEMA,
  GRAFANA_LIST_DASHBOARDS_INPUT_SCHEMA,
  GRAFANA_LIST_DATASOURCES_INPUT_SCHEMA,
  GRAFANA_LIST_FOLDERS_INPUT_SCHEMA,
  GRAFANA_LIST_INSTANCES_INPUT_SCHEMA,
  GRAFANA_LIST_LOKI_LABEL_NAMES_INPUT_SCHEMA,
  GRAFANA_LIST_LOKI_LABEL_VALUES_INPUT_SCHEMA,
  GRAFANA_LIST_PROMETHEUS_LABEL_VALUES_INPUT_SCHEMA,
  GRAFANA_LIST_PROMETHEUS_METRIC_NAMES_INPUT_SCHEMA,
  GRAFANA_QUERY_DATASOURCE_INPUT_SCHEMA,
  GRAFANA_QUERY_LOKI_INPUT_SCHEMA,
  GRAFANA_QUERY_PROMETHEUS_INPUT_SCHEMA
} from './bridgeSchemas';

/**
 * Stable reverse-domain plugin id (AT Series Hub Protocol v1 §4.2).
 * See docs/decisions/ADR-005-at-series-hub-protocol-v1-adoption.md.
 */
export const AT_GRAFANA_PLUGIN_ID = 'at.grafana' as const;

/**
 * Appended to every management-family tool's description so an Agent
 * reading `/tools` understands this catalog is for a "Grafana management
 * agent" persona -- inspecting/reasoning about Grafana's own configuration
 * -- and knows to reach instead for the Phase 6 "monitoring data" tools
 * (`grafana_list_datasources`/`grafana_query_datasource`) when it actually
 * needs to analyze the metrics/logs behind a datasource.
 */
const MANAGEMENT_FAMILY_SUFFIX =
  ' This is a Grafana management/configuration tool for an agent inspecting Grafana\'s own setup, not for querying ' +
  'the metrics/logs behind a datasource -- see the monitoring data tools for that.';

/**
 * Appended to every monitoring-data-family tool's description -- the mirror
 * image of MANAGEMENT_FAMILY_SUFFIX above, so an Agent reading `/tools` can
 * tell the two families apart regardless of which one it lands on first.
 * This family serves a monitoring/alerting agent that needs the actual
 * Prometheus/Loki data behind a datasource, using Grafana purely as the
 * aggregation/auth boundary in front of it (ADR-004 "Monitoring data
 * family").
 */
const MONITORING_FAMILY_SUFFIX =
  ' This is a monitoring data tool for an agent analyzing the actual metrics/logs behind a Prometheus/Loki-style ' +
  'datasource, not for inspecting Grafana\'s own configuration -- see the Grafana management tools for that.';

/**
 * Populated in Task 5.1 (management tools) and Phase 6 (monitoring data
 * tools). See docs/decisions/ADR-004-mcp-tool-catalog-and-permission-model.md
 * for the full catalog design (all `risk: 'read'`, prefix `grafana_`) and
 * src/mcp/bridgeSchemas.ts for the Zod/JSON-Schema pair backing each
 * `inputSchema` below.
 */
export const AT_GRAFANA_TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    name: 'grafana_list_instances',
    title: 'List Grafana instances',
    description:
      'List configured Grafana instances that have "Allow Agent background access" enabled, as {id, label, url} ' +
      '(never the auth token, never a toggled-off instance). Call this first to discover which instanceId values ' +
      'the other grafana_* management tools will accept.',
    risk: 'read',
    inputSchema: GRAFANA_LIST_INSTANCES_INPUT_SCHEMA
  },
  {
    name: 'grafana_list_dashboards',
    title: 'List Grafana dashboards',
    description:
      'List dashboards on a Grafana instance (uid, title, tags, folder). Optional query, tag, and folderUid ' +
      'narrow Grafana /api/search -- prefer a query over listing everything on a large instance.' +
      MANAGEMENT_FAMILY_SUFFIX,
    risk: 'read',
    inputSchema: GRAFANA_LIST_DASHBOARDS_INPUT_SCHEMA
  },
  {
    name: 'grafana_get_dashboard',
    title: 'Get Grafana dashboard',
    description:
      `Get a dashboard by uid. Default fields is "targets" (panel expr + datasource only); ` +
      `"summary" for panel inventory; pass "full" only when the complete JSON model is required. Optional panelIds / ` +
      `titleContains filter panels server-side.${MANAGEMENT_FAMILY_SUFFIX}`,
    risk: 'read',
    inputSchema: GRAFANA_GET_DASHBOARD_INPUT_SCHEMA
  },
  {
    name: 'grafana_list_folders',
    title: 'List Grafana folders',
    description: `List the dashboard folder structure on a Grafana instance.${MANAGEMENT_FAMILY_SUFFIX}`,
    risk: 'read',
    inputSchema: GRAFANA_LIST_FOLDERS_INPUT_SCHEMA
  },
  {
    name: 'grafana_list_alert_rules',
    title: 'List Grafana alert rules',
    description:
      `List Unified Alerting rules on a Grafana instance with current state (firing/pending/normal/unknown). ` +
      `Optional states filters to those values; omit to list all.${MANAGEMENT_FAMILY_SUFFIX}`,
    risk: 'read',
    inputSchema: GRAFANA_LIST_ALERT_RULES_INPUT_SCHEMA
  },
  {
    name: 'grafana_get_alert_rule',
    title: 'Get Grafana alert rule',
    description:
      `Get the full definition of one alert rule by uid (condition, for, labels, annotations, notification policy ` +
      `references).${MANAGEMENT_FAMILY_SUFFIX}`,
    risk: 'read',
    inputSchema: GRAFANA_GET_ALERT_RULE_INPUT_SCHEMA
  },
  {
    name: 'grafana_get_alert_history',
    title: 'Get Grafana alert rule history',
    description: `Get the state-change/event history for one alert rule by uid.${MANAGEMENT_FAMILY_SUFFIX}`,
    risk: 'read',
    inputSchema: GRAFANA_GET_ALERT_HISTORY_INPUT_SCHEMA
  },
  {
    name: 'grafana_list_annotations',
    title: 'List Grafana annotations',
    description:
      'List Grafana annotations (deploy markers and other event comments) in an optional time window. Read-only GET ' +
      '/api/annotations — optional from/to (epoch ms), dashboardUid, tag, and limit (default 100, max 100). Use to ' +
      'correlate incidents with a deploy window.' +
      MANAGEMENT_FAMILY_SUFFIX,
    risk: 'read',
    inputSchema: GRAFANA_LIST_ANNOTATIONS_INPUT_SCHEMA
  },
  {
    name: 'grafana_generate_deeplink',
    title: 'Generate Grafana deeplink',
    description:
      'Build a Grafana dashboard or Explore URL from the instance base URL. Always returns grafanaUrl. Optional ' +
      'openInIde (default false) opens the AT Grafana Webview for dashboards only; Explore is URL-only.' +
      MANAGEMENT_FAMILY_SUFFIX,
    risk: 'read',
    inputSchema: GRAFANA_GENERATE_DEEPLINK_INPUT_SCHEMA
  },
  {
    name: 'grafana_list_datasources',
    title: 'List Grafana datasources',
    description:
      'List the datasources configured on a Grafana instance as {uid, name, type, url} (never credentials). Call this ' +
      `to discover which datasourceUid values grafana_query_prometheus, grafana_query_loki, and grafana_query_datasource will accept.${MONITORING_FAMILY_SUFFIX}`,
    risk: 'read',
    inputSchema: GRAFANA_LIST_DATASOURCES_INPUT_SCHEMA
  },
  {
    name: 'grafana_query_prometheus',
    title: 'Query Prometheus via Grafana',
    description:
      'Run a PromQL instant or range query through Grafana\'s datasource proxy. Pass expr plus optional start/end/step ' +
      '(range, default) or time (instant). Prefer this over grafana_query_datasource for Prometheus. ' +
      MONITORING_FAMILY_SUFFIX,
    risk: 'read',
    inputSchema: GRAFANA_QUERY_PROMETHEUS_INPUT_SCHEMA
  },
  {
    name: 'grafana_query_loki',
    title: 'Query Loki via Grafana',
    description:
      'Run a LogQL query through Grafana\'s datasource proxy. Pass expr plus optional start/end/limit/direction ' +
      '(range, default) or time (instant). Prefer this over grafana_query_datasource for Loki. Prefer limit 50–100. ' +
      MONITORING_FAMILY_SUFFIX,
    risk: 'read',
    inputSchema: GRAFANA_QUERY_LOKI_INPUT_SCHEMA
  },
  {
    name: 'grafana_list_prometheus_metric_names',
    title: 'List Prometheus metric names',
    description:
      'Discover Prometheus metric names (PromQL discovery) through Grafana\'s datasource proxy. Optional regex filters ' +
      'names before they reach the model. Results are capped at 200; over-cap lists include truncated: true so you can ' +
      'tighten the regex rather than dump an unbounded catalog. ' +
      MONITORING_FAMILY_SUFFIX,
    risk: 'read',
    inputSchema: GRAFANA_LIST_PROMETHEUS_METRIC_NAMES_INPUT_SCHEMA
  },
  {
    name: 'grafana_list_prometheus_label_values',
    title: 'List Prometheus label values',
    description:
      'Discover Prometheus label values (PromQL discovery) for one label through Grafana\'s datasource proxy. Optional ' +
      'matcher is forwarded as match[]; optional regex filters values. Results are capped at 200 with truncated: true ' +
      'when the cap is hit. ' +
      MONITORING_FAMILY_SUFFIX,
    risk: 'read',
    inputSchema: GRAFANA_LIST_PROMETHEUS_LABEL_VALUES_INPUT_SCHEMA
  },
  {
    name: 'grafana_list_loki_label_names',
    title: 'List Loki label names',
    description:
      'Discover Loki label names (LogQL discovery) through Grafana\'s datasource proxy. Optional regex filters names ' +
      'before they reach the model. Results are capped at 200; over-cap lists include truncated: true. ' +
      MONITORING_FAMILY_SUFFIX,
    risk: 'read',
    inputSchema: GRAFANA_LIST_LOKI_LABEL_NAMES_INPUT_SCHEMA
  },
  {
    name: 'grafana_list_loki_label_values',
    title: 'List Loki label values',
    description:
      'Discover Loki label values (LogQL discovery) for one label through Grafana\'s datasource proxy. Optional regex ' +
      'filters values. Results are capped at 200 with truncated: true when the cap is hit. ' +
      MONITORING_FAMILY_SUFFIX,
    risk: 'read',
    inputSchema: GRAFANA_LIST_LOKI_LABEL_VALUES_INPUT_SCHEMA
  },
  {
    name: 'grafana_query_datasource',
    title: 'Query Grafana datasource',
    description:
      'Use grafana_query_prometheus / grafana_query_loki for Prom/Loki; this tool is the escape hatch for other ' +
      'datasource types and unusual paths. Pass-through to a datasource\'s own query API via Grafana\'s datasource ' +
      'proxy (e.g. Prometheus `/api/v1/query_range`, Loki `/loki/api/v1/query_range`). You construct the path/query/body ' +
      'yourself, including whatever time-range params the target datasource API expects. `path` is resolved strictly ' +
      'under `/api/datasources/proxy/uid/<datasourceUid>/` -- it may not contain `..`, `\\`, or percent-encoded ' +
      'separators, so this tool cannot reach Grafana\'s own APIs. Only GET/POST are allowed -- any other method is ' +
      'rejected before reaching Grafana. Time range and response size are capped by plugin settings; an over-cap ' +
      'request is truncated with `truncated: true` in the result (with an explanatory message) rather than failing ' +
      `outright, so you can narrow your query and retry.${MONITORING_FAMILY_SUFFIX}`,
    risk: 'read',
    inputSchema: GRAFANA_QUERY_DATASOURCE_INPUT_SCHEMA
  }
];
