import type { ToolCatalogEntry } from '@at-series/mcp-hub';
import {
  GRAFANA_GET_ALERT_HISTORY_INPUT_SCHEMA,
  GRAFANA_GET_ALERT_RULE_INPUT_SCHEMA,
  GRAFANA_GET_DASHBOARD_INPUT_SCHEMA,
  GRAFANA_LIST_ALERT_RULES_INPUT_SCHEMA,
  GRAFANA_LIST_DASHBOARDS_INPUT_SCHEMA,
  GRAFANA_LIST_DATASOURCES_INPUT_SCHEMA,
  GRAFANA_LIST_FOLDERS_INPUT_SCHEMA,
  GRAFANA_LIST_INSTANCES_INPUT_SCHEMA,
  GRAFANA_QUERY_DATASOURCE_INPUT_SCHEMA
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
    description: `List dashboards on a Grafana instance, grouped by folder (uid, title, tags, folder).${MANAGEMENT_FAMILY_SUFFIX}`,
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
      `List every Unified Alerting rule on a Grafana instance with its current state (firing/pending/normal/` +
      `unknown).${MANAGEMENT_FAMILY_SUFFIX}`,
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
    name: 'grafana_list_datasources',
    title: 'List Grafana datasources',
    description:
      'List the datasources configured on a Grafana instance as {uid, name, type, url} (never credentials). Call this ' +
      `to discover which datasourceUid values grafana_query_datasource will accept.${MONITORING_FAMILY_SUFFIX}`,
    risk: 'read',
    inputSchema: GRAFANA_LIST_DATASOURCES_INPUT_SCHEMA
  },
  {
    name: 'grafana_query_datasource',
    title: 'Query Grafana datasource',
    description:
      'Pass-through to a datasource\'s own query API via Grafana\'s datasource proxy (e.g. Prometheus ' +
      '`/api/v1/query_range`, Loki `/loki/api/v1/query_range`). You construct the path/query/body yourself, ' +
      'including whatever time-range params the target datasource API expects. `path` is resolved strictly under ' +
      '`/api/datasources/proxy/uid/<datasourceUid>/` -- it may not contain `..`, `\\`, or percent-encoded ' +
      'separators, so this tool cannot reach Grafana\'s own APIs. Only GET/POST are allowed -- any other method is ' +
      'rejected before reaching Grafana. Time range and response size are capped by plugin settings; an over-cap ' +
      'request is truncated with `truncated: true` in the result (with an explanatory message) rather than failing ' +
      `outright, so you can narrow your query and retry.${MONITORING_FAMILY_SUFFIX}`,
    risk: 'read',
    inputSchema: GRAFANA_QUERY_DATASOURCE_INPUT_SCHEMA
  }
];
