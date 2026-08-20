import { describe, expect, it } from 'vitest';
import { AT_SERIES_TOKEN_HEADER } from '@at-series/mcp-hub';
import { GrafanaAgentToolService, type GrafanaApiClientLike } from '../../src/agent/GrafanaAgentToolService';
import type { GrafanaInstanceConfig } from '../../src/config/schema';
import { GrafanaCertTrustStore, type CertTrustMemento } from '../../src/grafana/GrafanaCertTrustStore';
import { createBridgeRequestHandler } from '../../src/mcp/BridgeServer';
import { AT_GRAFANA_TOOL_CATALOG } from '../../src/mcp/toolCatalog';

/**
 * Black-box test of the whole Bridge surface as a unified system: a real
 * `createBridgeRequestHandler` wired to a *real* `GrafanaAgentToolService`
 * (only the underlying `GrafanaApiClientLike` HTTP calls are faked), driven
 * purely through the `BridgeRequest`/`BridgeResponse` wire shape (JSON
 * strings in, JSON strings out) exactly as a real Hub-mediated MCP client
 * would see it.
 *
 * This complements (does not replace) the per-module unit tests:
 * - `BridgeServer.test.ts` unit-tests `createBridgeRequestHandler` against a
 *   *fake* `toolService`, isolating transport/validation/catalog-lookup.
 * - `GrafanaAgentToolService.test.ts` unit-tests authorization + dispatch
 *   directly (no HTTP/Bridge envelope at all).
 *
 * Here, both layers are real and composed together, proving schema
 * validation -> ADR-004 authorization -> real tool dispatch actually chains
 * correctly end-to-end for one tool from each of the three families
 * (discovery / management / monitoring), per Task 7.1's plan brief.
 */

class MemoryMemento implements CertTrustMemento {
  private data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

const TOKEN = 'integration-test-token';

function instance(overrides: Partial<GrafanaInstanceConfig> = {}): GrafanaInstanceConfig {
  return {
    id: 'instance-1',
    label: 'Production',
    url: 'https://grafana.example.com',
    allowBackgroundAccess: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function fakeClient(overrides: Partial<GrafanaApiClientLike> = {}): GrafanaApiClientLike {
  return {
    search: async () => [],
    getFolders: async () => [],
    getDashboardByUid: async () => {
      throw new Error('not stubbed');
    },
    listAlertRules: async () => [],
    listAlertRuleStates: async () => [],
    getAlertRuleHistory: async () => [],
    listDatasources: async () => [],
    proxyDatasourceRequest: async () => ({}),
    ...overrides
  };
}

async function makeHandler(options: { instances?: GrafanaInstanceConfig[]; client?: GrafanaApiClientLike } = {}) {
  const instances = options.instances ?? [instance()];
  const configManager = {
    listInstances: async () => instances,
    getInstance: async (id: string) => instances.find((candidate) => candidate.id === id),
    getToken: async () => 'grafana-service-account-token'
  };
  const certTrustStore = new GrafanaCertTrustStore(new MemoryMemento());
  await certTrustStore.trust('grafana.example.com', 443, 'trusted-fingerprint');

  const client = options.client ?? fakeClient();
  const toolService = new GrafanaAgentToolService({
    configManager,
    certTrustStore,
    createClient: () => client
  });

  return createBridgeRequestHandler({
    bridgeId: 'integration-bridge',
    token: TOKEN,
    hostApp: 'cursor',
    pluginVersion: '0.1.0',
    toolService
  });
}

function invokeRequest(name: string, args: Record<string, unknown>) {
  return {
    method: 'POST',
    path: '/invoke',
    headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN },
    body: JSON.stringify({ name, arguments: args })
  } as const;
}

describe('Bridge integration (real GrafanaAgentToolService, no fake toolService)', () => {
  it('GET /health reports ok with the real catalog tool count', async () => {
    const handler = await makeHandler();

    const response = await handler({ method: 'GET', path: '/health', headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN } });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, toolCount: AT_GRAFANA_TOOL_CATALOG.length });
  });

  it('GET /tools round-trips the full catalog, all risk: read, prefixed grafana_', async () => {
    const handler = await makeHandler();

    const response = await handler({ method: 'GET', path: '/tools', headers: { [AT_SERIES_TOKEN_HEADER]: TOKEN } });

    expect(response.status).toBe(200);
    const tools = (response.body as { tools: Array<{ name: string; risk: string }> }).tools;
    expect(tools).toHaveLength(AT_GRAFANA_TOOL_CATALOG.length);
    for (const tool of tools) {
      expect(tool.name.startsWith('grafana_')).toBe(true);
      expect(tool.risk).toBe('read');
    }
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
  });

  it('discovery family: POST /invoke grafana_list_instances validates, authorizes, and dispatches for real', async () => {
    const handler = await makeHandler({
      instances: [
        instance({ id: 'on', label: 'Enabled', allowBackgroundAccess: true }),
        instance({ id: 'off', label: 'Disabled', allowBackgroundAccess: false })
      ]
    });

    const response = await handler(invokeRequest('grafana_list_instances', {}));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      name: 'grafana_list_instances',
      result: [{ id: 'on', label: 'Enabled', url: 'https://grafana.example.com' }]
    });
    expect(JSON.stringify(response.body)).not.toContain('token');
  });

  it('management family: POST /invoke grafana_get_dashboard validates, authorizes, and returns the real dashboard model', async () => {
    const dashboard = { uid: 'd1', title: 'CPU', model: { panels: [{ targets: [{ expr: 'up' }] }] } };
    const client = fakeClient({
      getDashboardByUid: async (uid: string) => (uid === 'd1' ? (dashboard as never) : (undefined as never))
    });
    const handler = await makeHandler({ client });

    const response = await handler(
      invokeRequest('grafana_get_dashboard', { instanceId: 'instance-1', uid: 'd1', fields: 'full' })
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, name: 'grafana_get_dashboard', result: dashboard });
  });

  it('monitoring family: POST /invoke grafana_query_datasource validates, authorizes, and forwards the proxied query', async () => {
    const upstreamResult = { status: 'success', data: { result: [] } };
    const client = fakeClient({ proxyDatasourceRequest: async () => upstreamResult });
    const handler = await makeHandler({ client });

    const response = await handler(
      invokeRequest('grafana_query_datasource', {
        instanceId: 'instance-1',
        datasourceUid: 'ds1',
        method: 'GET',
        path: 'api/v1/query',
        query: { query: 'up' }
      })
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, name: 'grafana_query_datasource', result: upstreamResult });
  });

  it('monitoring family: POST /invoke grafana_query_prometheus validates, authorizes, and forwards the proxied query', async () => {
    const upstreamResult = { status: 'success', data: { resultType: 'matrix', result: [] } };
    const client = fakeClient({ proxyDatasourceRequest: async () => upstreamResult });
    const handler = await makeHandler({ client });

    const response = await handler(
      invokeRequest('grafana_query_prometheus', {
        instanceId: 'instance-1',
        datasourceUid: 'prom',
        expr: 'up',
        start: '1700000000',
        end: '1700003600',
        step: '15s'
      })
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, name: 'grafana_query_prometheus', result: upstreamResult });
  });

  it('rejects a disabled instance for a management tool with a validation-class error produced by the real authorization check', async () => {
    const handler = await makeHandler({ instances: [instance({ id: 'instance-1', allowBackgroundAccess: false })] });

    const response = await handler(invokeRequest('grafana_list_dashboards', { instanceId: 'instance-1' }));

    expect(response.status).toBe(422);
    expect((response.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects grafana_query_datasource with a disallowed method at the schema layer before any authorization/dispatch happens', async () => {
    const proxyCalls: unknown[] = [];
    const client = fakeClient({
      proxyDatasourceRequest: async (...args: unknown[]) => {
        proxyCalls.push(args);
        return {};
      }
    });
    const handler = await makeHandler({ client });

    const response = await handler(
      invokeRequest('grafana_query_datasource', {
        instanceId: 'instance-1',
        datasourceUid: 'ds1',
        method: 'DELETE',
        path: 'api/v1/query'
      })
    );

    expect(response.status).toBe(422);
    expect((response.body as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR');
    expect(proxyCalls).toHaveLength(0);
  });

  it('rejects every request without the x-at-series-token header regardless of endpoint', async () => {
    const handler = await makeHandler();

    const health = await handler({ method: 'GET', path: '/health', headers: {} });
    const tools = await handler({ method: 'GET', path: '/tools', headers: {} });
    const invoke = await handler({
      method: 'POST',
      path: '/invoke',
      headers: {},
      body: JSON.stringify({ name: 'grafana_list_instances', arguments: {} })
    });

    expect(health.status).toBe(401);
    expect(tools.status).toBe(401);
    expect(invoke.status).toBe(401);
  });
});
