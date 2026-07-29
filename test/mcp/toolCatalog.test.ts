import { describe, expect, it } from 'vitest';
import { AT_GRAFANA_PLUGIN_ID, AT_GRAFANA_TOOL_CATALOG } from '../../src/mcp/toolCatalog';

describe('toolCatalog', () => {
  it('uses a stable reverse-domain pluginId', () => {
    expect(AT_GRAFANA_PLUGIN_ID).toBe('at.grafana');
  });

  it('is empty until Phase 5/6 populate management and monitoring tools', () => {
    expect(AT_GRAFANA_TOOL_CATALOG).toEqual([]);
  });
});
