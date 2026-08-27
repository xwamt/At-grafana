import { describe, expect, it, vi } from 'vitest';
import { AT_SERIES_TOKEN_HEADER } from '@at-series/mcp-hub';
import type { GrafanaAgentToolService, ToolInvokeResult } from '../../src/agent/GrafanaAgentToolService';
import { createBridgeRequestHandler, type BridgeHandlerDependencies } from '../../src/mcp/BridgeServer';
import { AT_GRAFANA_PLUGIN_ID, AT_GRAFANA_TOOL_CATALOG } from '../../src/mcp/toolCatalog';

const TOKEN = 'test-token';

function fakeToolService(invoke: (name: string, args: unknown) => Promise<ToolInvokeResult>): GrafanaAgentToolService {
  return { invoke } as unknown as GrafanaAgentToolService;
}

function handler(overrides: Partial<BridgeHandlerDependencies> = {}) {
  return createBridgeRequestHandler({
    bridgeId: 'bridge-1',
    token: TOKEN,
    hostApp: 'cursor',
    pluginVersion: '0.1.0',
    ...overrides
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

  it('reports health with the stable pluginId and the real tool count', async () => {
    const response = await handler()({
      method: 'GET',
      path: '/health',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN }
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, pluginId: AT_GRAFANA_PLUGIN_ID, toolCount: AT_GRAFANA_TOOL_CATALOG.length });
  });

  it('lists the full Task 5.1 management tool catalog', async () => {
    const response = await handler()({
      method: 'GET',
      path: '/tools',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN }
    });
    expect(response.status).toBe(200);
    expect((response.body as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name)).toEqual(
      AT_GRAFANA_TOOL_CATALOG.map((tool) => tool.name)
    );
  });

  it('returns 404 for an unknown tool name', async () => {
    const response = await handler()({
      method: 'POST',
      path: '/invoke',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({ name: 'grafana_does_not_exist', arguments: {} })
    });
    expect(response.status).toBe(404);
  });

  it('rejects malformed invoke envelopes (missing arguments) with BAD_REQUEST', async () => {
    const response = await handler()({
      method: 'POST',
      path: '/invoke',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({ name: 'x' })
    });
    expect(response.status).toBe(400);
    expect((response.body as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });

  it('rejects arguments that fail schema validation for a known tool with a validation-class error', async () => {
    const response = await handler()({
      method: 'POST',
      path: '/invoke',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({ name: 'grafana_get_dashboard', arguments: { instanceId: 'x' } }) // missing uid
    });
    expect(response.status).toBe(422);
    expect((response.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects grafana_query_datasource with an invalid method value as a validation-class error, with zero upstream calls made', async () => {
    const invoke = vi.fn(async (): Promise<ToolInvokeResult> => ({ ok: true, result: {} }));
    const response = await handler({ toolService: fakeToolService(invoke) })({
      method: 'POST',
      path: '/invoke',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({
        name: 'grafana_query_datasource',
        arguments: { instanceId: 'i1', datasourceUid: 'ds1', method: 'DELETE', path: 'api/v1/query' }
      })
    });

    expect(response.status).toBe(422);
    expect((response.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns 503 UNAVAILABLE for a known tool when no toolService is wired', async () => {
    const response = await handler()({
      method: 'POST',
      path: '/invoke',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({ name: 'grafana_list_instances', arguments: {} })
    });
    expect(response.status).toBe(503);
  });

  it('dispatches a valid call for a known tool to the toolService and returns { ok, name, result }', async () => {
    const invoke = vi.fn(async (): Promise<ToolInvokeResult> => ({ ok: true, result: [{ id: 'a', label: 'A', url: 'https://a' }] }));
    const response = await handler({ toolService: fakeToolService(invoke) })({
      method: 'POST',
      path: '/invoke',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({ name: 'grafana_list_instances', arguments: {} })
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, name: 'grafana_list_instances', result: [{ id: 'a', label: 'A', url: 'https://a' }] });
    expect(invoke).toHaveBeenCalledWith('grafana_list_instances', {});
  });

  it('passes the schema-parsed arguments (defaults applied) to toolService.invoke, not the raw body (PERF-07)', async () => {
    const invoke = vi.fn(async (): Promise<ToolInvokeResult> => ({ ok: true, result: [] }));
    const response = await handler({ toolService: fakeToolService(invoke) })({
      method: 'POST',
      path: '/invoke',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({ name: 'grafana_list_annotations', arguments: { instanceId: 'i1' } })
    });

    expect(response.status).toBe(200);
    // `limit: 100` only exists on the *parsed* data (a Zod .default()); raw
    // args would arrive without it and force the service's second parse to
    // re-derive what the Bridge already computed.
    expect(invoke).toHaveBeenCalledWith('grafana_list_annotations', { instanceId: 'i1', limit: 100 });
  });

  it('surfaces the toolService authorization failure as a validation-class error, without re-implementing the check itself', async () => {
    const invoke = vi.fn(async (): Promise<ToolInvokeResult> => ({
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Unknown Grafana instance, or this instance does not have Agent background access enabled.'
    }));
    const response = await handler({ toolService: fakeToolService(invoke) })({
      method: 'POST',
      path: '/invoke',
      headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN },
      body: JSON.stringify({ name: 'grafana_list_dashboards', arguments: { instanceId: 'disabled-instance' } })
    });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Unknown Grafana instance, or this instance does not have Agent background access enabled.'
      }
    });
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

/**
 * Protocol v1 §7.2 makes a constant-time comparison a MUST, and the Hub
 * exports `timingSafeEqualToken` so the three Bridges share one correct
 * implementation. The observable consequences of adopting it -- rather than
 * the timing property itself, which a test cannot honestly assert -- are
 * below.
 */
describe('BridgeServer token comparison', () => {
  async function health(dependencyToken: string, presented: string | string[] | undefined) {
    return handler({ token: dependencyToken })({
      method: 'GET',
      path: '/health',
      headers: presented === undefined ? {} : { [AT_SERIES_TOKEN_HEADER]: presented }
    });
  }

  it('never accepts an empty token, so a Bridge that failed to mint one is closed rather than open', async () => {
    expect((await health('', '')).status).toBe(401);
  });

  it('rejects a caller presenting nothing against an empty configured token', async () => {
    expect((await health('', undefined)).status).toBe(401);
  });

  it('rejects a wrong token of exactly the right length', async () => {
    expect((await health(TOKEN, 'tokentest-'.slice(0, TOKEN.length))).status).toBe(401);
    expect(TOKEN).toHaveLength('tokentest-'.slice(0, TOKEN.length).length);
  });

  it('rejects a correct prefix and a correct token with anything appended', async () => {
    expect((await health(TOKEN, TOKEN.slice(0, -1))).status).toBe(401);
    expect((await health(TOKEN, `${TOKEN}x`)).status).toBe(401);
  });

  it('still accepts the exact token, including as the first of a repeated header', async () => {
    expect((await health(TOKEN, TOKEN)).status).toBe(200);
    expect((await health(TOKEN, [TOKEN, 'ignored'])).status).toBe(200);
  });

  it('rejects a non-string header value instead of failing the comparison outright', async () => {
    // Node only ever produces string header values, but the handler accepts
    // hand-built requests too, and a value the comparison cannot encode must
    // come back as the 401 it is rather than as a 500.
    const response = await handler({ token: TOKEN })({
      method: 'GET',
      path: '/health',
      headers: { [AT_SERIES_TOKEN_HEADER]: 42 as unknown as string }
    });
    expect(response.status).toBe(401);
  });
});
