import { describe, expect, it } from 'vitest';
import { AT_GRAFANA_PLUGIN_ID, AT_GRAFANA_TOOL_CATALOG } from '../../src/mcp/toolCatalog';

const MANAGEMENT_TOOL_NAMES = [
  'grafana_list_dashboards',
  'grafana_get_dashboard',
  'grafana_list_folders',
  'grafana_list_alert_rules',
  'grafana_get_alert_rule',
  'grafana_get_alert_history',
  'grafana_list_annotations',
  'grafana_generate_deeplink'
];
const MONITORING_TOOL_NAMES = [
  'grafana_list_datasources',
  'grafana_query_prometheus',
  'grafana_query_loki',
  'grafana_list_prometheus_metric_names',
  'grafana_list_prometheus_label_values',
  'grafana_list_loki_label_names',
  'grafana_list_loki_label_values',
  'grafana_query_datasource'
];
const EXPECTED_TOOL_NAMES = ['grafana_list_instances', ...MANAGEMENT_TOOL_NAMES, ...MONITORING_TOOL_NAMES];

const INSTANCE_ID_AND_UID_TOOLS = new Set(['grafana_get_alert_rule', 'grafana_get_alert_history']);
const INSTANCE_ID_ONLY_TOOLS = new Set(['grafana_list_folders', 'grafana_list_datasources']);

describe('toolCatalog', () => {
  it('uses a stable reverse-domain pluginId', () => {
    expect(AT_GRAFANA_PLUGIN_ID).toBe('at.grafana');
  });

  it('declares the current catalog names, in any order', () => {
    expect(AT_GRAFANA_TOOL_CATALOG).toHaveLength(17);
    expect(AT_GRAFANA_TOOL_CATALOG.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it('marks every tool risk: read (ADR-004: no write/exec tool in this catalog)', () => {
    for (const tool of AT_GRAFANA_TOOL_CATALOG) {
      expect(tool.risk).toBe('read');
    }
  });

  it('gives every tool a non-empty title and description', () => {
    for (const tool of AT_GRAFANA_TOOL_CATALOG) {
      expect(tool.title.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('grafana_list_instances has an empty, closed input schema', () => {
    const tool = findTool('grafana_list_instances');
    expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(tool.inputSchema.required ?? []).toEqual([]);
  });

  it('instanceId-only tools require exactly instanceId', () => {
    for (const name of INSTANCE_ID_ONLY_TOOLS) {
      const tool = findTool(name);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.required).toEqual(['instanceId']);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).toMatchObject({ instanceId: { type: 'string' } });
    }
  });

  it('instanceId+uid tools require exactly instanceId and uid', () => {
    for (const name of INSTANCE_ID_AND_UID_TOOLS) {
      const tool = findTool(name);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.required).toEqual(['instanceId', 'uid']);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.inputSchema.properties).toMatchObject({
        instanceId: { type: 'string' },
        uid: { type: 'string' }
      });
    }
  });

  it('grafana_list_dashboards requires instanceId and documents optional query/tag/folderUid', () => {
    const tool = findTool('grafana_list_dashboards');
    expect(tool.inputSchema.required).toEqual(['instanceId']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties).toMatchObject({
      instanceId: { type: 'string' },
      query: { type: 'string', minLength: 1 },
      tag: { type: 'string', minLength: 1 },
      folderUid: { type: 'string', minLength: 1 }
    });
    expect(tool.description.toLowerCase()).toContain('query');
    expect(tool.description.toLowerCase()).toMatch(/\btag\b/);
    expect(tool.description.toLowerCase()).toContain('folderuid');
  });

  it('grafana_get_dashboard requires instanceId/uid and documents optional fields projection', () => {
    const tool = findTool('grafana_get_dashboard');
    expect(tool.inputSchema.required).toEqual(['instanceId', 'uid']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties).toMatchObject({
      instanceId: { type: 'string' },
      uid: { type: 'string' },
      fields: { type: 'string', enum: ['full', 'summary', 'targets'] },
      panelIds: { type: 'array', items: { type: 'number' } },
      titleContains: { type: 'string' }
    });
    expect(tool.description.toLowerCase()).toContain('targets');
  });

  it('management tool descriptions distinguish this family from the monitoring-data family', () => {
    for (const name of MANAGEMENT_TOOL_NAMES) {
      expect(findTool(name).description.toLowerCase()).toContain('management');
    }
  });

  it('monitoring-data tool descriptions distinguish this family from the management family', () => {
    for (const name of MONITORING_TOOL_NAMES) {
      expect(findTool(name).description.toLowerCase()).toContain('monitoring');
    }
  });

  it('grafana_list_alert_rules requires instanceId and documents optional states', () => {
    const tool = findTool('grafana_list_alert_rules');
    expect(tool.inputSchema.required).toEqual(['instanceId']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties).toMatchObject({
      instanceId: { type: 'string' },
      states: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', enum: ['firing', 'pending', 'normal', 'unknown'] }
      }
    });
    expect(tool.description.toLowerCase()).toContain('states');
    expect(tool.description.toLowerCase()).toMatch(/omit/);
  });

  it('grafana_list_datasources requires exactly instanceId (instanceId-only shape)', () => {
    const tool = findTool('grafana_list_datasources');
    expect(tool.inputSchema.required).toEqual(['instanceId']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  });

  it('grafana_list_annotations is a read-only management tool with optional from/to/dashboardUid/tag/limit', () => {
    const tool = findTool('grafana_list_annotations');
    expect(tool.risk).toBe('read');
    expect(tool.description.toLowerCase()).toContain('annotation');
    expect(tool.description.toLowerCase()).toMatch(/read-only|readonly/);
    expect(tool.inputSchema.required).toEqual(['instanceId']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties).toMatchObject({
      instanceId: { type: 'string' },
      from: { type: 'integer', minimum: 0 },
      to: { type: 'integer', minimum: 0 },
      dashboardUid: { type: 'string' },
      tag: { type: 'string' },
      limit: { type: 'integer' }
    });
    expect(tool.inputSchema.required).not.toContain('limit');
  });

  it('grafana_generate_deeplink is a read-only management tool that returns grafanaUrl and defaults openInIde to false', () => {
    const tool = findTool('grafana_generate_deeplink');
    expect(tool.risk).toBe('read');
    expect(tool.description).toMatch(/grafanaUrl/);
    expect(tool.description.toLowerCase()).toMatch(/openinide/);
    expect(tool.description.toLowerCase()).toMatch(/default(?:s)? false|false by default/);
    expect(tool.inputSchema.required).toEqual(['instanceId', 'kind']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties).toMatchObject({
      instanceId: { type: 'string' },
      kind: { type: 'string', enum: ['dashboard', 'explore', 'alertRule'] },
      uid: { type: 'string' },
      datasourceUid: { type: 'string' },
      expr: { type: 'string' },
      panelId: { type: 'integer', exclusiveMinimum: 0 },
      openInIde: { type: 'boolean' }
    });
    expect(tool.description).toMatch(/alertRule/);
    expect(tool.description.toLowerCase()).toContain('expr');
  });

  it('grafana_get_alert_rule promises the query definitions and notification settings it now returns', () => {
    const tool = findTool('grafana_get_alert_rule');
    expect(tool.description.toLowerCase()).toContain('data');
    expect(tool.description.toLowerCase()).toContain('query definitions');
    expect(tool.description).toMatch(/notificationSettings/);
    expect(tool.description.toLowerCase()).toContain('ispaused');
  });

  it('grafana_list_alert_rules documents isPaused on the light projection', () => {
    const tool = findTool('grafana_list_alert_rules');
    expect(tool.description).toMatch(/isPaused/);
  });

  it('grafana_get_alert_history documents the from/to/limit window and the Loki state-history prerequisite', () => {
    const tool = findTool('grafana_get_alert_history');
    expect(tool.inputSchema.required).toEqual(['instanceId', 'uid']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties).toMatchObject({
      instanceId: { type: 'string' },
      uid: { type: 'string' },
      from: { type: 'integer', minimum: 0 },
      to: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 1000 }
    });
    expect(tool.description).toMatch(/Loki-backed/);
    expect(tool.description.toLowerCase()).toContain('limit');
  });

  it('grafana_list_instances documents the { instances, hint? } envelope', () => {
    const tool = findTool('grafana_list_instances');
    expect(tool.description).toMatch(/instances/);
    expect(tool.description.toLowerCase()).toContain('hint');
  });

  it('grafana_query_datasource requires instanceId/datasourceUid/method/path, with method restricted to GET/POST', () => {
    const tool = findTool('grafana_query_datasource');
    expect(tool.inputSchema.required).toEqual(['instanceId', 'datasourceUid', 'method', 'path']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties).toMatchObject({
      instanceId: { type: 'string' },
      datasourceUid: { type: 'string' },
      method: { type: 'string', enum: ['GET', 'POST'] },
      path: { type: 'string' }
    });
    expect(tool.description.toLowerCase()).toContain('escape hatch');
    expect(tool.description).toMatch(/grafana_query_prometheus/);
    expect(tool.description).toMatch(/grafana_query_loki/);
  });

  it('grafana_query_prometheus requires instanceId, datasourceUid, expr', () => {
    const tool = findTool('grafana_query_prometheus');
    expect(tool.risk).toBe('read');
    expect(tool.inputSchema.required).toEqual(['instanceId', 'datasourceUid', 'expr']);
    expect(tool.description.toLowerCase()).toContain('promql');
  });

  it('grafana_query_loki requires instanceId, datasourceUid, expr', () => {
    const tool = findTool('grafana_query_loki');
    expect(tool.risk).toBe('read');
    expect(tool.inputSchema.required).toEqual(['instanceId', 'datasourceUid', 'expr']);
    expect(tool.description.toLowerCase()).toContain('logql');
  });

  it('grafana_list_prometheus_metric_names requires instanceId and datasourceUid', () => {
    const tool = findTool('grafana_list_prometheus_metric_names');
    expect(tool.risk).toBe('read');
    expect(tool.inputSchema.required).toEqual(['instanceId', 'datasourceUid']);
  });

  it('label-values tools require label in inputSchema.required', () => {
    expect(findTool('grafana_list_prometheus_label_values').inputSchema.required).toEqual([
      'instanceId',
      'datasourceUid',
      'label'
    ]);
    expect(findTool('grafana_list_loki_label_values').inputSchema.required).toEqual([
      'instanceId',
      'datasourceUid',
      'label'
    ]);
  });
});

function findTool(name: string) {
  const tool = AT_GRAFANA_TOOL_CATALOG.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected catalog to contain tool: ${name}`);
  }
  return tool;
}
