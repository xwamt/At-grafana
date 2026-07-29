import { describe, expect, it } from 'vitest';
import { AT_SERIES_TOKEN_HEADER } from '@at-series/mcp-hub';
import { createBridgeRequestHandler } from '../../src/mcp/BridgeServer';
import { AT_GRAFANA_PLUGIN_ID } from '../../src/mcp/toolCatalog';

const TOKEN = 'test-token';

function handler() {
  return createBridgeRequestHandler({
    bridgeId: 'bridge-1',
    token: TOKEN,
    hostApp: 'cursor',
    pluginVersion: '0.1.0'
  });
}

describe('BridgeServer request handler', () => {
  it('rejects requests without a valid token', async () => {
    const response = await handler()({
      method: 'GET',
      path: '/health',
      headers: {}
    });
    expect(response.status).toBe(401);
  });

  it('reports health with the stable pluginId', async () => {
    const response = await handler()({
      method: 'GET',
      path: '/health',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN }
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, pluginId: AT_GRAFANA_PLUGIN_ID, toolCount: 0 });
  });

  it('lists an empty tool catalog until Phase 5/6 populate it', async () => {
    const response = await handler()({
      method: 'GET',
      path: '/tools',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN }
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ tools: [] });
  });

  it('returns 404 for any invoke call, since no tools are registered yet', async () => {
    const response = await handler()({
      method: 'POST',
      path: '/invoke',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({ name: 'grafana_list_dashboards', arguments: {} })
    });
    expect(response.status).toBe(404);
  });

  it('rejects malformed invoke bodies', async () => {
    const response = await handler()({
      method: 'POST',
      path: '/invoke',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({ name: 'x' })
    });
    expect(response.status).toBe(400);
  });

  it('returns 404 for unknown endpoints', async () => {
    const response = await handler()({
      method: 'GET',
      path: '/unknown',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN }
    });
    expect(response.status).toBe(404);
  });
});
