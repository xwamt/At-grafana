import { z } from 'zod';
import type { JsonSchemaObject } from '@at-series/mcp-hub';

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

export const grafanaListDashboardsSchema = z.object({ instanceId: z.string().min(1) }).strict();

export const grafanaGetDashboardSchema = z
  .object({ instanceId: z.string().min(1), uid: z.string().min(1) })
  .strict();

export const grafanaListFoldersSchema = z.object({ instanceId: z.string().min(1) }).strict();

export const grafanaListAlertRulesSchema = z.object({ instanceId: z.string().min(1) }).strict();

export const grafanaGetAlertRuleSchema = z
  .object({ instanceId: z.string().min(1), uid: z.string().min(1) })
  .strict();

export const grafanaGetAlertHistorySchema = z
  .object({ instanceId: z.string().min(1), uid: z.string().min(1) })
  .strict();

export type GrafanaListInstancesInput = z.infer<typeof grafanaListInstancesSchema>;
export type GrafanaListDashboardsInput = z.infer<typeof grafanaListDashboardsSchema>;
export type GrafanaGetDashboardInput = z.infer<typeof grafanaGetDashboardSchema>;
export type GrafanaListFoldersInput = z.infer<typeof grafanaListFoldersSchema>;
export type GrafanaListAlertRulesInput = z.infer<typeof grafanaListAlertRulesSchema>;
export type GrafanaGetAlertRuleInput = z.infer<typeof grafanaGetAlertRuleSchema>;
export type GrafanaGetAlertHistoryInput = z.infer<typeof grafanaGetAlertHistorySchema>;

/** Every AT Grafana management tool name (Task 5.1); Phase 6 will extend this with the monitoring-data family. */
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

/**
 * Looked up by tool name at the Bridge transport layer (`BridgeServer.ts`)
 * to validate `arguments` before ever reaching `GrafanaAgentToolService`,
 * and reused inside `GrafanaAgentToolService` itself as a defense-in-depth
 * second check so the service is safe to call directly (e.g. from tests)
 * without relying on the Bridge having validated first.
 */
export const BRIDGE_SCHEMAS_BY_TOOL_NAME: Record<AtGrafanaManagementToolName, z.ZodTypeAny> = {
  grafana_list_instances: grafanaListInstancesSchema,
  grafana_list_dashboards: grafanaListDashboardsSchema,
  grafana_get_dashboard: grafanaGetDashboardSchema,
  grafana_list_folders: grafanaListFoldersSchema,
  grafana_list_alert_rules: grafanaListAlertRulesSchema,
  grafana_get_alert_rule: grafanaGetAlertRuleSchema,
  grafana_get_alert_history: grafanaGetAlertHistorySchema
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
export const GRAFANA_LIST_DASHBOARDS_INPUT_SCHEMA: JsonSchemaObject = instanceIdOnlyInputSchema();
export const GRAFANA_GET_DASHBOARD_INPUT_SCHEMA: JsonSchemaObject = instanceIdAndUidInputSchema();
export const GRAFANA_LIST_FOLDERS_INPUT_SCHEMA: JsonSchemaObject = instanceIdOnlyInputSchema();
export const GRAFANA_LIST_ALERT_RULES_INPUT_SCHEMA: JsonSchemaObject = instanceIdOnlyInputSchema();
export const GRAFANA_GET_ALERT_RULE_INPUT_SCHEMA: JsonSchemaObject = instanceIdAndUidInputSchema();
export const GRAFANA_GET_ALERT_HISTORY_INPUT_SCHEMA: JsonSchemaObject = instanceIdAndUidInputSchema();
