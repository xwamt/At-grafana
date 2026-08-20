import { describe, expect, it } from 'vitest';
import { AT_GRAFANA_PLUGIN_ID, AT_GRAFANA_TOOL_CATALOG } from '../../src/mcp/toolCatalog';

const MANAGEMENT_TOOL_NAMES = [
  'grafana_list_dashboards',
  'grafana_get_dashboard',
  'grafana_list_folders',
  'grafana_list_alert_rules',
  'grafana_get_alert_rule',
  'grafana_get_alert_history'
];
const MONITORING_TOOL_NAMES = [
  'grafana_list_datasources',
  'grafana_query_prometheus',
  'grafana_query_loki',
  'grafana_query_datasource'
];
const EXPECTED_TOOL_NAMES = ['grafana_list_instances', ...MANAGEMENT_TOOL_NAMES, ...MONITORING_TOOL_NAMES];

const INSTANCE_ID_AND_UID_TOOLS = new Set(['grafana_get_alert_rule', 'grafana_get_alert_history']);
const INSTANCE_ID_ONLY_TOOLS = new Set([
  'grafana_list_folders',
  'grafana_list_alert_rules',
  'grafana_list_datasources'
]);

describe('toolCatalog', () => {
  it('uses a stable reverse-domain pluginId', () => {
    expect(AT_GRAFANA_PLUGIN_ID).toBe('at.grafana');
  });

  it('declares exactly the 11 tools from Task 5.1 (management) + Task 6.1 (monitoring data), in any order', () => {
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

  it('grafana_list_datasources requires exactly instanceId (instanceId-only shape)', () => {
    const tool = findTool('grafana_list_datasources');
    expect(tool.inputSchema.required).toEqual(['instanceId']);
    expect(tool.inputSchema.additionalProperties).toBe(false);
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
});

function findTool(name: string) {
  const tool = AT_GRAFANA_TOOL_CATALOG.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected catalog to contain tool: ${name}`);
  }
  return tool;
}
