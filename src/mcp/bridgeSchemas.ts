import { z } from 'zod';
import type { JsonSchemaObject } from '@at-series/mcp-hub';
import { DATASOURCE_PROXY_PATH_DENY_PATTERN } from '../grafana/GrafanaDatasourcesApi';
import { PROMETHEUS_LABEL_PATTERN } from '../grafana/typedDatasourceDiscovery';

/**
 * Server-side input validation for every AT Grafana MCP tool (Task 5.1,
 * docs/decisions/ADR-004-mcp-tool-catalog-and-permission-model.md). Every
 * tool except `grafana_list_instances` requires `instanceId`; the
 * "get a single thing" tools additionally require `uid`.
 *
 * `.strict()` rejects unknown properties outright rather than silently
 * dropping them, matching `additionalProperties: false` on the JSON Schema
 * twins below.
 */
export const grafanaListInstancesSchema = z.object({}).strict();

export const grafanaListDashboardsSchema = z
  .object({
    instanceId: z.string().min(1),
    query: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    folderUid: z.string().min(1).optional()
  })
  .strict();

/**
 * Optional projection for `grafana_get_dashboard` (OPTIMIZE-P1):
 * - `targets` (default): panel expr/datasource only (strip fieldConfig/options/gridPos); recurse rows
 * - `summary`: uid/title/time + panel id/title/type/datasource
 * - `full`: unchanged dashboard model (pass explicitly)
 * Optional `panelIds` / `titleContains` filter panels server-side before projection.
 */
export const grafanaGetDashboardSchema = z
  .object({
    instanceId: z.string().min(1),
    uid: z.string().min(1),
    fields: z.enum(['full', 'summary', 'targets']).optional(),
    panelIds: z.array(z.number()).optional(),
    titleContains: z.string().optional()
  })
  .strict();

export const grafanaListFoldersSchema = z.object({ instanceId: z.string().min(1) }).strict();

export const grafanaListAlertRulesSchema = z.object({ instanceId: z.string().min(1) }).strict();

export const grafanaGetAlertRuleSchema = z
  .object({ instanceId: z.string().min(1), uid: z.string().min(1) })
  .strict();

export const grafanaGetAlertHistorySchema = z
  .object({ instanceId: z.string().min(1), uid: z.string().min(1) })
  .strict();

export const grafanaListDatasourcesSchema = z.object({ instanceId: z.string().min(1) }).strict();

/**
 * `method: z.enum(['GET', 'POST'])` is the schema-validation-layer half of
 * ADR-004/MON4's method allowlist (requirements §5.1: "must be enforced at
 * the Bridge layer, not rely on agent self-discipline") -- this rejects any
 * other method with a `VALIDATION_ERROR`-class response (see
 * `BridgeServer.handleInvoke`) before the request ever reaches
 * `GrafanaAgentToolService`, let alone `GrafanaApiClient.proxyDatasourceRequest`'s
 * own runtime guard (defense in depth, not a replacement for it).
 *
 * `path` carries the same shape of risk as `method` and is validated the same
 * way: an Agent-supplied `..` walks straight out of the datasource proxy
 * subtree into Grafana's Admin API (see
 * `GrafanaDatasourcesApi.DATASOURCE_PROXY_PATH_DENY_PATTERN`). Rejecting it
 * here means the request never leaves the transport layer; the two checks
 * inside `proxyDatasourceRequest`/`buildDatasourceProxyPath` remain as the
 * layers that protect non-Bridge callers.
 *
 * `query` is a flat string-to-string map, matching
 * `GrafanaDatasourcesApi.proxyDatasourceRequest`'s existing
 * `query?: Record<string, string>` shape -- this is also exactly the shape
 * `QueryLimits.clampQueryTimeRange` expects for its `start`/`end` heuristic.
 */
const datasourceProxyPathSchema = z
  .string()
  .min(1)
  .refine((value) => !DATASOURCE_PROXY_PATH_DENY_PATTERN.test(value), {
    message:
      'must stay inside the datasource proxy subtree: "..", "\\", and percent-encoded separators (%2e/%2f/%5c) are rejected'
  });

export const grafanaQueryDatasourceSchema = z
  .object({
    instanceId: z.string().min(1),
    datasourceUid: z.string().min(1),
    method: z.enum(['GET', 'POST']),
    path: datasourceProxyPathSchema,
    query: z.record(z.string()).optional(),
    body: z.unknown().optional()
  })
  .strict();

export const grafanaQueryPrometheusSchema = z
  .object({
    instanceId: z.string().min(1),
    datasourceUid: z.string().min(1),
    expr: z.string().min(1),
    queryType: z.enum(['instant', 'range']).default('range'),
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional(),
    step: z.string().min(1).optional(),
    time: z.string().min(1).optional()
  })
  .strict();

export const grafanaQueryLokiSchema = z
  .object({
    instanceId: z.string().min(1),
    datasourceUid: z.string().min(1),
    expr: z.string().min(1),
    queryType: z.enum(['instant', 'range']).default('range'),
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional(),
    time: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
    direction: z.enum(['forward', 'backward']).optional()
  })
  .strict();

const optionalRegexSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        new RegExp(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a valid JavaScript regular expression' }
  )
  .optional();

const prometheusLabelSchema = z.string().regex(PROMETHEUS_LABEL_PATTERN);

export const grafanaListPrometheusMetricNamesSchema = z
  .object({
    instanceId: z.string().min(1),
    datasourceUid: z.string().min(1),
    regex: optionalRegexSchema,
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional()
  })
  .strict();

export const grafanaListPrometheusLabelValuesSchema = z
  .object({
    instanceId: z.string().min(1),
    datasourceUid: z.string().min(1),
    label: prometheusLabelSchema,
    matcher: z.string().min(1).optional(),
    regex: optionalRegexSchema,
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional()
  })
  .strict();

export const grafanaListLokiLabelNamesSchema = z
  .object({
    instanceId: z.string().min(1),
    datasourceUid: z.string().min(1),
    regex: optionalRegexSchema,
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional()
  })
  .strict();

export const grafanaListLokiLabelValuesSchema = z
  .object({
    instanceId: z.string().min(1),
    datasourceUid: z.string().min(1),
    label: prometheusLabelSchema,
    regex: optionalRegexSchema,
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional()
  })
  .strict();

export type GrafanaListInstancesInput = z.infer<typeof grafanaListInstancesSchema>;
export type GrafanaListDashboardsInput = z.infer<typeof grafanaListDashboardsSchema>;
export type GrafanaGetDashboardInput = z.infer<typeof grafanaGetDashboardSchema>;
export type GrafanaListFoldersInput = z.infer<typeof grafanaListFoldersSchema>;
export type GrafanaListAlertRulesInput = z.infer<typeof grafanaListAlertRulesSchema>;
export type GrafanaGetAlertRuleInput = z.infer<typeof grafanaGetAlertRuleSchema>;
export type GrafanaGetAlertHistoryInput = z.infer<typeof grafanaGetAlertHistorySchema>;
export type GrafanaListDatasourcesInput = z.infer<typeof grafanaListDatasourcesSchema>;
export type GrafanaQueryDatasourceInput = z.infer<typeof grafanaQueryDatasourceSchema>;
export type GrafanaQueryPrometheusInput = z.infer<typeof grafanaQueryPrometheusSchema>;
export type GrafanaQueryLokiInput = z.infer<typeof grafanaQueryLokiSchema>;
export type GrafanaListPrometheusMetricNamesInput = z.infer<typeof grafanaListPrometheusMetricNamesSchema>;
export type GrafanaListPrometheusLabelValuesInput = z.infer<typeof grafanaListPrometheusLabelValuesSchema>;
export type GrafanaListLokiLabelNamesInput = z.infer<typeof grafanaListLokiLabelNamesSchema>;
export type GrafanaListLokiLabelValuesInput = z.infer<typeof grafanaListLokiLabelValuesSchema>;

/** The Grafana management family (Task 5.1) -- see AT_GRAFANA_MONITORING_TOOL_NAMES for the Phase 6 monitoring-data family. */
export const AT_GRAFANA_MANAGEMENT_TOOL_NAMES = [
  'grafana_list_instances',
  'grafana_list_dashboards',
  'grafana_get_dashboard',
  'grafana_list_folders',
  'grafana_list_alert_rules',
  'grafana_get_alert_rule',
  'grafana_get_alert_history'
] as const;

export type AtGrafanaManagementToolName = (typeof AT_GRAFANA_MANAGEMENT_TOOL_NAMES)[number];

/** The monitoring-data family (Task 6.1) -- serves an agent analyzing actual Prometheus/Loki data, not Grafana's own configuration. */
export const AT_GRAFANA_MONITORING_TOOL_NAMES = [
  'grafana_list_datasources',
  'grafana_query_prometheus',
  'grafana_query_loki',
  'grafana_list_prometheus_metric_names',
  'grafana_list_prometheus_label_values',
  'grafana_list_loki_label_names',
  'grafana_list_loki_label_values',
  'grafana_query_datasource'
] as const;

export type AtGrafanaMonitoringToolName = (typeof AT_GRAFANA_MONITORING_TOOL_NAMES)[number];

export type AtGrafanaToolName = AtGrafanaManagementToolName | AtGrafanaMonitoringToolName;

/**
 * Looked up by tool name at the Bridge transport layer (`BridgeServer.ts`)
 * to validate `arguments` before ever reaching `GrafanaAgentToolService`,
 * and reused inside `GrafanaAgentToolService` itself as a defense-in-depth
 * second check so the service is safe to call directly (e.g. from tests)
 * without relying on the Bridge having validated first.
 */
export const BRIDGE_SCHEMAS_BY_TOOL_NAME: Record<AtGrafanaToolName, z.ZodTypeAny> = {
  grafana_list_instances: grafanaListInstancesSchema,
  grafana_list_dashboards: grafanaListDashboardsSchema,
  grafana_get_dashboard: grafanaGetDashboardSchema,
  grafana_list_folders: grafanaListFoldersSchema,
  grafana_list_alert_rules: grafanaListAlertRulesSchema,
  grafana_get_alert_rule: grafanaGetAlertRuleSchema,
  grafana_get_alert_history: grafanaGetAlertHistorySchema,
  grafana_list_datasources: grafanaListDatasourcesSchema,
  grafana_query_prometheus: grafanaQueryPrometheusSchema,
  grafana_query_loki: grafanaQueryLokiSchema,
  grafana_list_prometheus_metric_names: grafanaListPrometheusMetricNamesSchema,
  grafana_list_prometheus_label_values: grafanaListPrometheusLabelValuesSchema,
  grafana_list_loki_label_names: grafanaListLokiLabelNamesSchema,
  grafana_list_loki_label_values: grafanaListLokiLabelValuesSchema,
  grafana_query_datasource: grafanaQueryDatasourceSchema
};

/** Renders a Zod validation failure as a compact, single-line, non-leaking message safe to return in a Bridge error body. */
export function describeZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * `@at-series/mcp-hub`'s `ToolCatalogEntry.inputSchema` is a plain JSON
 * Schema object (client-visible tool contract, e.g. what an MCP client shows
 * an end user or feeds to a model). This repo has no zod-to-json-schema
 * dependency (deliberately, per Task 5.1's brief) so these are hand-written
 * to mirror the Zod schemas above field-for-field. If you change one of the
 * Zod schemas above, update its JSON Schema twin here in the same commit --
 * there is no automated check that keeps them in sync.
 */
function instanceIdOnlyInputSchema(): JsonSchemaObject {
  return {
    type: 'object',
    properties: { instanceId: { type: 'string', minLength: 1 } },
    required: ['instanceId'],
    additionalProperties: false
  };
}

function instanceIdAndUidInputSchema(): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      instanceId: { type: 'string', minLength: 1 },
      uid: { type: 'string', minLength: 1 }
    },
    required: ['instanceId', 'uid'],
    additionalProperties: false
  };
}

export const GRAFANA_LIST_INSTANCES_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {},
  additionalProperties: false
};
export const GRAFANA_LIST_DASHBOARDS_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', minLength: 1 },
    query: { type: 'string', minLength: 1, description: 'Grafana /api/search query string (title/metadata).' },
    tag: { type: 'string', minLength: 1, description: 'Single Grafana dashboard tag to filter on.' },
    folderUid: { type: 'string', minLength: 1, description: 'Restrict results to this folder UID (Grafana folderUIDs).' }
  },
  required: ['instanceId'],
  additionalProperties: false
};
export const GRAFANA_GET_DASHBOARD_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', minLength: 1 },
    uid: { type: 'string', minLength: 1 },
    fields: { type: 'string', enum: ['full', 'summary', 'targets'] },
    panelIds: { type: 'array', items: { type: 'number' } },
    titleContains: { type: 'string' }
  },
  required: ['instanceId', 'uid'],
  additionalProperties: false
};
export const GRAFANA_LIST_FOLDERS_INPUT_SCHEMA: JsonSchemaObject = instanceIdOnlyInputSchema();
export const GRAFANA_LIST_ALERT_RULES_INPUT_SCHEMA: JsonSchemaObject = instanceIdOnlyInputSchema();
export const GRAFANA_GET_ALERT_RULE_INPUT_SCHEMA: JsonSchemaObject = instanceIdAndUidInputSchema();
export const GRAFANA_GET_ALERT_HISTORY_INPUT_SCHEMA: JsonSchemaObject = instanceIdAndUidInputSchema();
export const GRAFANA_LIST_DATASOURCES_INPUT_SCHEMA: JsonSchemaObject = instanceIdOnlyInputSchema();

/** Negative-lookahead twin of DATASOURCE_PROXY_PATH_DENY_PATTERN; derived from its source so the two cannot drift. */
const DATASOURCE_PROXY_PATH_JSON_SCHEMA_PATTERN = `^(?!.*(?:${DATASOURCE_PROXY_PATH_DENY_PATTERN.source})).+$`;

export const GRAFANA_QUERY_DATASOURCE_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', minLength: 1 },
    datasourceUid: { type: 'string', minLength: 1 },
    method: { type: 'string', enum: ['GET', 'POST'] },
    path: {
      type: 'string',
      minLength: 1,
      pattern: DATASOURCE_PROXY_PATH_JSON_SCHEMA_PATTERN,
      description:
        'Path relative to the datasource proxy root, e.g. "api/v1/query_range". Must stay inside the datasource ' +
        'subtree: "..", "\\", and percent-encoded separators (%2e/%2f/%5c) are rejected.'
    },
    query: { type: 'object', additionalProperties: { type: 'string' } },
    body: {}
  },
  required: ['instanceId', 'datasourceUid', 'method', 'path'],
  additionalProperties: false
};

export const GRAFANA_QUERY_PROMETHEUS_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', minLength: 1 },
    datasourceUid: { type: 'string', minLength: 1 },
    expr: { type: 'string', minLength: 1, description: 'PromQL expression.' },
    queryType: { type: 'string', enum: ['instant', 'range'], description: 'Defaults to range.' },
    start: { type: 'string', minLength: 1 },
    end: { type: 'string', minLength: 1 },
    step: { type: 'string', minLength: 1 },
    time: { type: 'string', minLength: 1, description: 'Evaluation time for instant queries.' }
  },
  required: ['instanceId', 'datasourceUid', 'expr'],
  additionalProperties: false
};

export const GRAFANA_QUERY_LOKI_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', minLength: 1 },
    datasourceUid: { type: 'string', minLength: 1 },
    expr: { type: 'string', minLength: 1, description: 'LogQL expression.' },
    queryType: { type: 'string', enum: ['instant', 'range'], description: 'Defaults to range.' },
    start: { type: 'string', minLength: 1 },
    end: { type: 'string', minLength: 1 },
    time: { type: 'string', minLength: 1 },
    limit: { type: 'integer', exclusiveMinimum: 0 },
    direction: { type: 'string', enum: ['forward', 'backward'] }
  },
  required: ['instanceId', 'datasourceUid', 'expr'],
  additionalProperties: false
};

const PROMETHEUS_LABEL_JSON_SCHEMA_PATTERN = '^[a-zA-Z_][a-zA-Z0-9_]*$';

const discoveryTimeAndRegexProperties = {
  regex: { type: 'string' as const, minLength: 1, description: 'Optional JavaScript regular expression used to filter returned values.' },
  start: { type: 'string' as const, minLength: 1 },
  end: { type: 'string' as const, minLength: 1 }
};

export const GRAFANA_LIST_PROMETHEUS_METRIC_NAMES_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', minLength: 1 },
    datasourceUid: { type: 'string', minLength: 1 },
    ...discoveryTimeAndRegexProperties
  },
  required: ['instanceId', 'datasourceUid'],
  additionalProperties: false
};

export const GRAFANA_LIST_PROMETHEUS_LABEL_VALUES_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', minLength: 1 },
    datasourceUid: { type: 'string', minLength: 1 },
    label: {
      type: 'string',
      pattern: PROMETHEUS_LABEL_JSON_SCHEMA_PATTERN,
      description: 'Prometheus label name whose values to list.'
    },
    matcher: { type: 'string', minLength: 1, description: 'Optional PromQL series selector forwarded as match[].' },
    ...discoveryTimeAndRegexProperties
  },
  required: ['instanceId', 'datasourceUid', 'label'],
  additionalProperties: false
};

export const GRAFANA_LIST_LOKI_LABEL_NAMES_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', minLength: 1 },
    datasourceUid: { type: 'string', minLength: 1 },
    ...discoveryTimeAndRegexProperties
  },
  required: ['instanceId', 'datasourceUid'],
  additionalProperties: false
};

export const GRAFANA_LIST_LOKI_LABEL_VALUES_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', minLength: 1 },
    datasourceUid: { type: 'string', minLength: 1 },
    label: {
      type: 'string',
      pattern: PROMETHEUS_LABEL_JSON_SCHEMA_PATTERN,
      description: 'Loki label name whose values to list.'
    },
    ...discoveryTimeAndRegexProperties
  },
  required: ['instanceId', 'datasourceUid', 'label'],
  additionalProperties: false
};
