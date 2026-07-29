import { describe, expect, it } from 'vitest';
import { AT_GRAFANA_PLUGIN_ID, AT_GRAFANA_TOOL_CATALOG } from '../../src/mcp/toolCatalog';

const EXPECTED_TOOL_NAMES = [
  'grafana_list_instances',
  'grafana_list_dashboards',
  'grafana_get_dashboard',
  'grafana_list_folders',
  'grafana_list_alert_rules',
  'grafana_get_alert_rule',
  'grafana_get_alert_history'
];

const INSTANCE_ID_AND_UID_TOOLS = new Set(['grafana_get_dashboard', 'grafana_get_alert_rule', 'grafana_get_alert_history']);
const INSTANCE_ID_ONLY_TOOLS = new Set(['grafana_list_dashboards', 'grafana_list_folders', 'grafana_list_alert_rules']);

describe('toolCatalog', () => {
  it('uses a stable reverse-domain pluginId', () => {
    expect(AT_GRAFANA_PLUGIN_ID).toBe('at.grafana');
  });

  it('declares exactly the 7 management tools from Task 5.1, in any order', () => {
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

  it('management tool descriptions distinguish this family from the future monitoring-data family', () => {
    for (const name of EXPECTED_TOOL_NAMES.filter((toolName) => toolName !== 'grafana_list_instances')) {
      expect(findTool(name).description.toLowerCase()).toContain('management');
    }
  });
});

function findTool(name: string) {
  const tool = AT_GRAFANA_TOOL_CATALOG.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected catalog to contain tool: ${name}`);
  }
  return tool;
}
