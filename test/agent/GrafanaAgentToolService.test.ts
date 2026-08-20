import { describe, expect, it, vi } from 'vitest';
import { GrafanaAgentToolService, type GrafanaApiClientLike, type RawQueryLimitsConfig } from '../../src/agent/GrafanaAgentToolService';
import { DEFAULT_MAX_RANGE_MS } from '../../src/grafana/QueryLimits';
import type { GrafanaInstanceConfig } from '../../src/config/schema';
import { GrafanaApiClient } from '../../src/grafana/GrafanaApiClient';
import { GrafanaCertTrustStore, type CertTrustMemento } from '../../src/grafana/GrafanaCertTrustStore';
import { GrafanaApiError, type GrafanaCertVerifier } from '../../src/grafana/GrafanaHttpClient';
import { QueryRateLimiter } from '../../src/grafana/QueryRateLimiter';
import { listen } from '../grafana/testHttpServer';

class MemoryMemento implements CertTrustMemento {
  private data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

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

interface ServiceOptions {
  instances?: GrafanaInstanceConfig[];
  tokens?: Record<string, string>;
  client?: GrafanaApiClientLike;
  trustedHost?: { host: string; port: number; fingerprint: string };
  queryLimitsConfig?: RawQueryLimitsConfig;
  queryRateLimiter?: QueryRateLimiter;
}

async function makeService(options: ServiceOptions = {}) {
  const instances = options.instances ?? [instance()];
  const tokens = options.tokens ?? { [instances[0]?.id ?? '']: 'test-token' };
  const configManager = {
    listInstances: async () => instances,
    getInstance: async (id: string) => instances.find((candidate) => candidate.id === id),
    getToken: async (id: string) => tokens[id]
  };
  const certTrustStore = new GrafanaCertTrustStore(new MemoryMemento());
  if (options.trustedHost) {
    await certTrustStore.trust(options.trustedHost.host, options.trustedHost.port, options.trustedHost.fingerprint);
  } else {
    // grafana.example.com resolves to https (port 443); trust it by default
    // so tests that don't care about TLS trust don't have to think about it.
    await certTrustStore.trust('grafana.example.com', 443, 'trusted-fingerprint');
  }
  const client = options.client ?? fakeClient();
  const createClient = vi.fn((_baseUrl: string, _token: string, _certVerifier: GrafanaCertVerifier) => client);
  const service = new GrafanaAgentToolService({
    configManager,
    certTrustStore,
    createClient,
    getQueryLimitsConfig: options.queryLimitsConfig ? () => options.queryLimitsConfig! : undefined,
    queryRateLimiter: options.queryRateLimiter
  });
  return { service, createClient, certTrustStore, configManager };
}

describe('GrafanaAgentToolService', () => {
  describe('grafana_list_instances', () => {
    it('returns only instances with allowBackgroundAccess=true, never a token field', async () => {
      const { service } = await makeService({
        instances: [
          instance({ id: 'on', label: 'Enabled', allowBackgroundAccess: true }),
          instance({ id: 'off', label: 'Disabled', allowBackgroundAccess: false })
        ]
      });

      const result = await service.invoke('grafana_list_instances', {});

      expect(result).toEqual({
        ok: true,
        result: [{ id: 'on', label: 'Enabled', url: 'https://grafana.example.com' }]
      });
      expect(JSON.stringify(result)).not.toContain('token');
    });

    it('rejects unknown extra arguments', async () => {
      const { service } = await makeService();
      const result = await service.invoke('grafana_list_instances', { instanceId: 'x' });
      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    });
  });

  describe('authorization', () => {
    it('rejects an unknown instanceId with the same error as a disabled instance', async () => {
      const { service } = await makeService({ instances: [instance({ id: 'known', allowBackgroundAccess: false })] });

      const unknown = await service.invoke('grafana_list_dashboards', { instanceId: 'does-not-exist' });
      const disabled = await service.invoke('grafana_list_dashboards', { instanceId: 'known' });

      expect(unknown).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
      expect(disabled).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
      expect((unknown as { message: string }).message).toBe((disabled as { message: string }).message);
    });

    it('rejects every management and monitoring-data tool for a disabled instance, not just grafana_list_dashboards', async () => {
      const { service } = await makeService({ instances: [instance({ id: 'known', allowBackgroundAccess: false })] });

      const toolCalls: Array<[string, Record<string, unknown>]> = [
        ['grafana_list_dashboards', { instanceId: 'known' }],
        ['grafana_get_dashboard', { instanceId: 'known', uid: 'd1' }],
        ['grafana_list_folders', { instanceId: 'known' }],
        ['grafana_list_alert_rules', { instanceId: 'known' }],
        ['grafana_get_alert_rule', { instanceId: 'known', uid: 'r1' }],
        ['grafana_get_alert_history', { instanceId: 'known', uid: 'r1' }],
        ['grafana_list_datasources', { instanceId: 'known' }],
        ['grafana_query_prometheus', { instanceId: 'known', datasourceUid: 'ds1', expr: 'up' }],
        ['grafana_query_loki', { instanceId: 'known', datasourceUid: 'ds1', expr: '{job="api"}' }],
        ['grafana_list_prometheus_metric_names', { instanceId: 'known', datasourceUid: 'ds1' }],
        ['grafana_list_prometheus_label_values', { instanceId: 'known', datasourceUid: 'ds1', label: 'job' }],
        ['grafana_list_loki_label_names', { instanceId: 'known', datasourceUid: 'ds1' }],
        ['grafana_list_loki_label_values', { instanceId: 'known', datasourceUid: 'ds1', label: 'job' }],
        ['grafana_query_datasource', { instanceId: 'known', datasourceUid: 'ds1', method: 'GET', path: 'api/v1/query' }]
      ];

      for (const [name, args] of toolCalls) {
        const result = await service.invoke(name, args);
        expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
      }
    });

    it('does not call createClient for an unauthorized instance', async () => {
      const { service, createClient } = await makeService({
        instances: [instance({ id: 'known', allowBackgroundAccess: false })]
      });

      await service.invoke('grafana_list_dashboards', { instanceId: 'known' });

      expect(createClient).not.toHaveBeenCalled();
    });
  });

  describe('management tools', () => {
    it('grafana_list_dashboards returns a flat list with folder titles resolved', async () => {
      const client = fakeClient({
        search: async () => [
          { uid: 'd1', title: 'CPU', type: 'dash-db', folderUid: 'f1', tags: ['infra'] },
          { uid: 'd2', title: 'No folder', type: 'dash-db' }
        ],
        getFolders: async () => [{ uid: 'f1', title: 'Infra' }]
      });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_list_dashboards', { instanceId: 'instance-1' });

      expect(result).toEqual({
        ok: true,
        result: [
          { uid: 'd1', title: 'CPU', tags: ['infra'], folderUid: 'f1', folderTitle: 'Infra' },
          { uid: 'd2', title: 'No folder', tags: [], folderUid: undefined, folderTitle: undefined }
        ]
      });
    });

    it('grafana_list_dashboards forwards query, tag, and folderUid to search and keeps type dash-db', async () => {
      const search = vi.fn(async () => [{ uid: 'd1', title: 'CPU', type: 'dash-db', folderUid: 'f1', tags: ['infra'] }]);
      const client = fakeClient({
        search,
        getFolders: async () => [{ uid: 'f1', title: 'Infra' }]
      });
      const { service } = await makeService({ client });

      await service.invoke('grafana_list_dashboards', {
        instanceId: 'instance-1',
        query: 'cpu',
        tag: 'infra',
        folderUid: 'f1'
      });

      expect(search).toHaveBeenCalledWith({ type: 'dash-db', query: 'cpu', tag: 'infra', folderUid: 'f1' });
    });

    it('grafana_get_dashboard defaults to fields=targets', async () => {
      const dashboard = {
        uid: 'd1',
        title: 'CPU',
        model: {
          uid: 'd1',
          title: 'CPU',
          panels: [
            {
              id: 1,
              title: 'Up',
              type: 'timeseries',
              datasource: { uid: 'prom' },
              targets: [{ refId: 'A', expr: 'up', datasource: { uid: 'prom' } }],
              fieldConfig: { defaults: {} },
              gridPos: { h: 8, w: 12, x: 0, y: 0 }
            }
          ]
        }
      };
      const client = fakeClient({ getDashboardByUid: async () => dashboard as never });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_get_dashboard', { instanceId: 'instance-1', uid: 'd1' });

      expect(result).toMatchObject({
        ok: true,
        result: {
          uid: 'd1',
          title: 'CPU',
          model: {
            uid: 'd1',
            title: 'CPU',
            panels: [
              {
                id: 1,
                title: 'Up',
                type: 'timeseries',
                datasource: { uid: 'prom' },
                targets: [{ refId: 'A', expr: 'up', datasource: { uid: 'prom' } }]
              }
            ]
          }
        }
      });
      const panels = (result as { ok: true; result: { model: { panels: Array<Record<string, unknown>> } } }).result.model
        .panels;
      expect(panels[0].fieldConfig).toBeUndefined();
      expect(panels[0].gridPos).toBeUndefined();
    });

    it('grafana_get_dashboard returns the full dashboard model when fields is full', async () => {
      const dashboard = { uid: 'd1', title: 'CPU', model: { panels: [{ targets: [{ expr: 'up' }] }] } };
      const client = fakeClient({
        getDashboardByUid: async (uid: string) => (uid === 'd1' ? (dashboard as never) : (undefined as never))
      });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_get_dashboard', {
        instanceId: 'instance-1',
        uid: 'd1',
        fields: 'full'
      });

      expect(result).toEqual({ ok: true, result: dashboard });
    });

    it('grafana_get_dashboard projects fields=targets before returning', async () => {
      const dashboard = {
        uid: 'd1',
        title: 'CPU',
        model: {
          uid: 'd1',
          title: 'CPU',
          time: { from: 'now-1h', to: 'now' },
          panels: [
            {
              id: 1,
              title: 'Up',
              type: 'timeseries',
              datasource: { uid: 'prom' },
              targets: [{ refId: 'A', expr: 'up', datasource: { uid: 'prom' } }],
              fieldConfig: { defaults: {} },
              gridPos: { h: 8, w: 12, x: 0, y: 0 }
            }
          ]
        }
      };
      const client = fakeClient({ getDashboardByUid: async () => dashboard as never });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_get_dashboard', {
        instanceId: 'instance-1',
        uid: 'd1',
        fields: 'targets'
      });

      expect(result).toEqual({
        ok: true,
        result: {
          uid: 'd1',
          title: 'CPU',
          model: {
            uid: 'd1',
            title: 'CPU',
            time: { from: 'now-1h', to: 'now' },
            panels: [
              {
                id: 1,
                title: 'Up',
                type: 'timeseries',
                datasource: { uid: 'prom' },
                targets: [{ refId: 'A', expr: 'up', datasource: { uid: 'prom' } }]
              }
            ]
          }
        }
      });
    });

    it('grafana_list_folders passes through the client folder list', async () => {
      const folders = [{ uid: 'f1', title: 'Infra' }];
      const client = fakeClient({ getFolders: async () => folders });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_list_folders', { instanceId: 'instance-1' });

      expect(result).toEqual({ ok: true, result: folders });
    });

    it('grafana_list_alert_rules correlates rules with live state, treating an unmatched rule as unknown', async () => {
      const client = fakeClient({
        listAlertRules: async () => [
          { uid: 'r1', title: 'CPU high', folderUid: 'f1', ruleGroup: 'g1', condition: 'B', for: '5m' },
          { uid: 'r2', title: 'No state', folderUid: 'f1', ruleGroup: 'g1', condition: 'B', for: '5m' }
        ],
        listAlertRuleStates: async () => [{ uid: 'r1', name: 'CPU high', state: 'firing', group: 'g1' }]
      });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_list_alert_rules', { instanceId: 'instance-1' });

      expect(result).toEqual({
        ok: true,
        result: [
          { uid: 'r1', title: 'CPU high', folderUid: 'f1', ruleGroup: 'g1', state: 'firing', rawState: 'firing', activeAt: undefined },
          { uid: 'r2', title: 'No state', folderUid: 'f1', ruleGroup: 'g1', state: 'unknown', rawState: undefined, activeAt: undefined }
        ]
      });
    });

    it('grafana_get_alert_rule finds the matching rule by uid', async () => {
      const rule = { uid: 'r1', title: 'CPU high', folderUid: 'f1', ruleGroup: 'g1', condition: 'B', for: '5m' };
      const client = fakeClient({ listAlertRules: async () => [rule] });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_get_alert_rule', { instanceId: 'instance-1', uid: 'r1' });

      expect(result).toEqual({ ok: true, result: rule });
    });

    it('grafana_get_alert_rule returns a NOT_FOUND-class failure for an unknown uid', async () => {
      const client = fakeClient({ listAlertRules: async () => [] });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_get_alert_rule', { instanceId: 'instance-1', uid: 'missing' });

      expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    });

    it('grafana_get_alert_history passes through the client history entries unmodified', async () => {
      const history = [{ time: 1700000000000, state: 'Alerting' }];
      const client = fakeClient({ getAlertRuleHistory: async () => history });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_get_alert_history', { instanceId: 'instance-1', uid: 'r1' });

      expect(result).toEqual({ ok: true, result: history });
    });
  });

  describe('monitoring data tools', () => {
    it('grafana_list_datasources returns only uid/name/type/url, never a credential-shaped field', async () => {
      const client = fakeClient({
        listDatasources: async () => [
          { uid: 'ds1', name: 'Prometheus', type: 'prometheus', url: 'http://prom:9090', isDefault: true } as never
        ]
      });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_list_datasources', { instanceId: 'instance-1' });

      expect(result).toEqual({
        ok: true,
        result: [{ uid: 'ds1', name: 'Prometheus', type: 'prometheus', url: 'http://prom:9090' }]
      });
      expect(JSON.stringify(result)).not.toContain('isDefault');
    });

    it('grafana_query_datasource happy path forwards to proxyDatasourceRequest and returns the result unwrapped', async () => {
      const proxyDatasourceRequest = vi.fn(async () => ({ status: 'success', data: { result: [] } }));
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_query_datasource', {
        instanceId: 'instance-1',
        datasourceUid: 'ds1',
        method: 'GET',
        path: 'api/v1/query',
        query: { query: 'up' }
      });

      expect(result).toEqual({ ok: true, result: { status: 'success', data: { result: [] } } });
      // `timeout` is added by the cost planner: an instant query has no range
      // to clamp, so a server-side deadline is the only bound available.
      expect(proxyDatasourceRequest).toHaveBeenCalledWith(
        'ds1',
        'GET',
        'api/v1/query',
        { query: 'up', timeout: '10s' },
        undefined,
        expect.any(Number)
      );
    });

    it('grafana_query_prometheus range forwards GET api/v1/query_range through queryDatasource metering', async () => {
      const proxyDatasourceRequest = vi.fn(async () => ({ status: 'success', data: { resultType: 'matrix', result: [] } }));
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_query_prometheus', {
        instanceId: 'instance-1',
        datasourceUid: 'prom',
        expr: 'up',
        start: '1700000000',
        end: '1700003600',
        step: '15s'
      });

      expect(result).toMatchObject({ ok: true });
      expect(proxyDatasourceRequest).toHaveBeenCalledWith(
        'prom',
        'GET',
        'api/v1/query_range',
        expect.objectContaining({ query: 'up', start: '1700000000', end: '1700003600', step: '15s' }),
        undefined,
        expect.any(Number)
      );
    });

    it('grafana_query_prometheus instant forwards GET api/v1/query and ignores start/end', async () => {
      const proxyDatasourceRequest = vi.fn(async () => ({ status: 'success', data: { resultType: 'vector', result: [] } }));
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client });

      await service.invoke('grafana_query_prometheus', {
        instanceId: 'instance-1',
        datasourceUid: 'prom',
        expr: 'up',
        queryType: 'instant',
        start: '1700000000',
        end: '1700003600',
        time: '1700001800'
      });

      expect(proxyDatasourceRequest).toHaveBeenCalledWith(
        'prom',
        'GET',
        'api/v1/query',
        expect.objectContaining({ query: 'up', time: '1700001800' }),
        undefined,
        expect.any(Number)
      );
      const [, , , forwardedQuery] = proxyDatasourceRequest.mock.calls[0] as unknown as [
        string,
        string,
        string,
        Record<string, string>
      ];
      expect(forwardedQuery.start).toBeUndefined();
      expect(forwardedQuery.end).toBeUndefined();
    });

    it('grafana_query_loki range forwards GET loki/api/v1/query_range', async () => {
      const proxyDatasourceRequest = vi.fn(async () => ({ status: 'success' }));
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_query_loki', {
        instanceId: 'instance-1',
        datasourceUid: 'loki',
        expr: '{job="api"}',
        limit: 50
      });

      expect(proxyDatasourceRequest).toHaveBeenCalledWith(
        'loki',
        'GET',
        'loki/api/v1/query_range',
        expect.objectContaining({ query: '{job="api"}', limit: '50' }),
        undefined,
        expect.any(Number)
      );
      const [, , , forwardedQuery] = proxyDatasourceRequest.mock.calls[0] as unknown as [
        string,
        string,
        string,
        Record<string, string>
      ];
      const start = Date.parse(forwardedQuery.start);
      const end = Date.parse(forwardedQuery.end);
      expect(Number.isNaN(start)).toBe(false);
      expect(Number.isNaN(end)).toBe(false);
      expect(end - start).toBe(DEFAULT_MAX_RANGE_MS);
      expect(result).not.toMatchObject({ result: { truncated: true, reason: 'time-range' } });
    });

    it('grafana_list_prometheus_metric_names forwards GET api/v1/label/__name__/values and projects values', async () => {
      const proxyDatasourceRequest = vi.fn(async () => ({ status: 'success', data: ['up', 'go_goroutines'] }));
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_list_prometheus_metric_names', {
        instanceId: 'instance-1',
        datasourceUid: 'prom',
        regex: '^go_'
      });

      expect(result).toEqual({ ok: true, result: { values: ['go_goroutines'] } });
      expect(proxyDatasourceRequest).toHaveBeenCalledWith(
        'prom',
        'GET',
        'api/v1/label/__name__/values',
        expect.any(Object),
        undefined,
        expect.any(Number)
      );
    });

    it('grafana_list_prometheus_label_values forwards GET api/v1/label/<label>/values with match[]', async () => {
      const proxyDatasourceRequest = vi.fn(async () => ({ status: 'success', data: ['api', 'web'] }));
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_list_prometheus_label_values', {
        instanceId: 'instance-1',
        datasourceUid: 'prom',
        label: 'job',
        matcher: '{__name__="up"}'
      });

      expect(result).toEqual({ ok: true, result: { values: ['api', 'web'] } });
      expect(proxyDatasourceRequest).toHaveBeenCalledWith(
        'prom',
        'GET',
        'api/v1/label/job/values',
        expect.objectContaining({ 'match[]': '{__name__="up"}' }),
        undefined,
        expect.any(Number)
      );
    });

    it('grafana_list_loki_label_names forwards GET loki/api/v1/labels and projects values', async () => {
      const proxyDatasourceRequest = vi.fn(async () => ({ status: 'success', data: ['job', 'level'] }));
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_list_loki_label_names', {
        instanceId: 'instance-1',
        datasourceUid: 'loki',
        regex: '^j'
      });

      expect(result).toEqual({ ok: true, result: { values: ['job'] } });
      expect(proxyDatasourceRequest).toHaveBeenCalledWith(
        'loki',
        'GET',
        'loki/api/v1/labels',
        expect.any(Object),
        undefined,
        expect.any(Number)
      );
    });

    it('grafana_list_loki_label_values forwards GET loki/api/v1/label/<label>/values and projects values', async () => {
      const proxyDatasourceRequest = vi.fn(async () => ({ status: 'success', data: ['api', 'web'] }));
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_list_loki_label_values', {
        instanceId: 'instance-1',
        datasourceUid: 'loki',
        label: 'job'
      });

      expect(result).toEqual({ ok: true, result: { values: ['api', 'web'] } });
      expect(proxyDatasourceRequest).toHaveBeenCalledWith(
        'loki',
        'GET',
        'loki/api/v1/label/job/values',
        expect.any(Object),
        undefined,
        expect.any(Number)
      );
    });

    it('returns a truncated proxy payload as-is without re-projecting discovery values', async () => {
      const proxyDatasourceRequest = vi.fn(async () => {
        throw new GrafanaApiError('response-too-large', 'Grafana response exceeded the configured maximum of 100 bytes.');
      });
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client, queryLimitsConfig: { maxResponseBytes: 100 } });

      const result = await service.invoke('grafana_list_prometheus_metric_names', {
        instanceId: 'instance-1',
        datasourceUid: 'prom'
      });

      expect(result).toMatchObject({ ok: true, result: { truncated: true, reason: 'response-size', maxBytes: 100 } });
      expect((result as { ok: true; result: { values?: unknown } }).result.values).toBeUndefined();
    });

    it('grafana_query_datasource clamps an over-max-range query and marks the result truncated: true, reason: time-range', async () => {
      const upstreamResult = { status: 'success', data: { result: [] } };
      const proxyDatasourceRequest = vi.fn(async () => upstreamResult);
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client, queryLimitsConfig: { maxRangeMs: 3_600_000 } }); // 1h cap

      const end = 1700010000;
      const start = end - 4 * 60 * 60; // 4h requested, over the 1h cap
      const result = await service.invoke('grafana_query_datasource', {
        instanceId: 'instance-1',
        datasourceUid: 'ds1',
        method: 'GET',
        path: 'api/v1/query_range',
        query: { start: String(start), end: String(end) }
      });

      expect(result).toMatchObject({
        ok: true,
        result: { truncated: true, reason: 'time-range', maxRangeMs: 3_600_000, result: upstreamResult }
      });
      const [, , , forwardedQuery] = proxyDatasourceRequest.mock.calls[0] as unknown as [string, string, string, Record<string, string>];
      expect(forwardedQuery.start).toBe(String(end - 3_600));
      expect(forwardedQuery.end).toBe(String(end));
    });

    it('grafana_query_datasource does not clamp a range the agent already narrowed below the cap', async () => {
      const proxyDatasourceRequest = vi.fn(async () => ({ ok: true }));
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client, queryLimitsConfig: { maxRangeMs: 3_600_000 } });

      const query = { start: '1700000000', end: '1700001800' }; // 30 min, under the 1h cap
      const result = await service.invoke('grafana_query_datasource', {
        instanceId: 'instance-1',
        datasourceUid: 'ds1',
        method: 'GET',
        path: 'api/v1/query_range',
        query
      });

      // Unwrapped, i.e. no truncation envelope: the range itself was left alone.
      expect(result).toEqual({ ok: true, result: { ok: true } });
      const [, , , forwardedQuery] = proxyDatasourceRequest.mock.calls[0] as unknown as [
        string,
        string,
        string,
        Record<string, string>
      ];
      expect(forwardedQuery).toMatchObject(query);
    });

    it('grafana_query_datasource marks an oversized response truncated: true, reason: response-size, without crashing or returning malformed data', async () => {
      const proxyDatasourceRequest = vi.fn(async () => {
        throw new GrafanaApiError('response-too-large', 'Grafana response exceeded the configured maximum of 100 bytes.');
      });
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client, queryLimitsConfig: { maxResponseBytes: 100 } });

      const result = await service.invoke('grafana_query_datasource', {
        instanceId: 'instance-1',
        datasourceUid: 'ds1',
        method: 'GET',
        path: 'api/v1/query'
      });

      expect(result).toMatchObject({ ok: true, result: { truncated: true, reason: 'response-size', maxBytes: 100 } });
      expect(() => JSON.stringify(result)).not.toThrow();
      expect((result as { result: { result?: unknown } }).result.result).toBeUndefined();
    });

    it('grafana_query_datasource rejects a non-GET/POST method at the schema-validation layer, with zero calls reaching the client', async () => {
      const proxyDatasourceRequest = vi.fn(async () => ({}));
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client });

      const result = await service.invoke('grafana_query_datasource', {
        instanceId: 'instance-1',
        datasourceUid: 'ds1',
        method: 'DELETE',
        path: 'api/v1/query'
      });

      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
      expect(proxyDatasourceRequest).not.toHaveBeenCalled();
    });

    it('grafana_query_datasource forwards the step floor and query timeout it injected', async () => {
      const proxyDatasourceRequest = vi.fn(async () => ({ ok: true }));
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client });

      const end = 1_770_000_000;
      await service.invoke('grafana_query_datasource', {
        instanceId: 'instance-1',
        datasourceUid: 'ds1',
        method: 'GET',
        path: 'api/v1/query_range',
        query: { query: 'up', start: String(end - 3600), end: String(end), step: '1s' }
      });

      const [, , , forwardedQuery] = proxyDatasourceRequest.mock.calls[0] as unknown as [
        string,
        string,
        string,
        Record<string, string>
      ];
      expect(forwardedQuery.step).toBe('4s'); // 3600s / 1000 points
      expect(forwardedQuery.timeout).toBe('10s');
    });

    it('grafana_query_datasource clamps a range smuggled through the POST body', async () => {
      const proxyDatasourceRequest = vi.fn(async () => ({ ok: true }));
      const client = fakeClient({ proxyDatasourceRequest });
      const { service } = await makeService({ client, queryLimitsConfig: { maxRangeMs: 3_600_000 } });

      const end = 1_770_000_000;
      await service.invoke('grafana_query_datasource', {
        instanceId: 'instance-1',
        datasourceUid: 'ds1',
        method: 'POST',
        path: 'api/v1/query_range',
        body: { query: 'up', start: String(end - 4 * 3600), end: String(end) }
      });

      const [, , , , forwardedBody] = proxyDatasourceRequest.mock.calls[0] as unknown as [
        string,
        string,
        string,
        unknown,
        Record<string, string>
      ];
      expect(forwardedBody.start).toBe(String(end - 3600));
    });

    it('grafana_query_datasource rejects an unknown/unauthorized instance the same way management tools do', async () => {
      const { service } = await makeService({ instances: [instance({ id: 'known', allowBackgroundAccess: false })] });

      const result = await service.invoke('grafana_query_datasource', {
        instanceId: 'known',
        datasourceUid: 'ds1',
        method: 'GET',
        path: 'api/v1/query'
      });

      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    });
  });

  /**
   * These guard INV-5 as much as they guard the instance: throttling here is
   * resource protection, so it must stay transient, must depend only on
   * recent request volume, and must never harden into "this caller may not
   * use this tool." A test that only proved requests get rejected would be
   * equally satisfied by an ACL, so each one below also pins down the
   * property that distinguishes the two.
   */
  describe('grafana_query_datasource resource metering', () => {
    function limiterAt(clock: { now: () => number }, maxRequestsPerWindow = 2, maxConcurrent = 4): QueryRateLimiter {
      return new QueryRateLimiter({ maxRequestsPerWindow, windowMs: 60_000, maxConcurrent, now: clock.now });
    }

    function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
      let current = start;
      return { now: () => current, advance: (ms: number) => void (current += ms) };
    }

    const queryArgs = {
      instanceId: 'instance-1',
      datasourceUid: 'ds1',
      method: 'GET' as const,
      path: 'api/v1/query',
      query: { query: 'up' }
    };

    it('sheds a query burst with a retryable UNAVAILABLE rather than an authorization failure', async () => {
      const clock = fakeClock();
      const proxyDatasourceRequest = vi.fn(async () => ({ ok: true }));
      const { service } = await makeService({
        client: fakeClient({ proxyDatasourceRequest }),
        queryRateLimiter: limiterAt(clock)
      });

      await service.invoke('grafana_query_datasource', queryArgs);
      await service.invoke('grafana_query_datasource', queryArgs);
      const shed = await service.invoke('grafana_query_datasource', queryArgs);

      expect(shed).toMatchObject({ ok: false, code: 'UNAVAILABLE' });
      expect((shed as { message: string }).message).toMatch(/retry/i);
      expect(proxyDatasourceRequest).toHaveBeenCalledTimes(2);
    });

    it('admits the identical call once the budget refills, proving the limit is not an access decision', async () => {
      const clock = fakeClock();
      const { service } = await makeService({ queryRateLimiter: limiterAt(clock) });

      await service.invoke('grafana_query_datasource', queryArgs);
      await service.invoke('grafana_query_datasource', queryArgs);
      expect(await service.invoke('grafana_query_datasource', queryArgs)).toMatchObject({ ok: false });

      clock.advance(60_000);

      expect(await service.invoke('grafana_query_datasource', queryArgs)).toMatchObject({ ok: true });
    });

    it('meters each instance separately, so a busy instance cannot lock out a quiet one', async () => {
      const clock = fakeClock();
      const { service } = await makeService({
        instances: [instance({ id: 'busy' }), instance({ id: 'quiet' })],
        tokens: { busy: 'token-busy', quiet: 'token-quiet' },
        queryRateLimiter: limiterAt(clock)
      });

      await service.invoke('grafana_query_datasource', { ...queryArgs, instanceId: 'busy' });
      await service.invoke('grafana_query_datasource', { ...queryArgs, instanceId: 'busy' });
      expect(await service.invoke('grafana_query_datasource', { ...queryArgs, instanceId: 'busy' })).toMatchObject({
        ok: false
      });

      expect(await service.invoke('grafana_query_datasource', { ...queryArgs, instanceId: 'quiet' })).toMatchObject({
        ok: true
      });
    });

    it('releases the concurrency slot even when the query throws', async () => {
      const clock = fakeClock();
      const proxyDatasourceRequest = vi.fn(async () => {
        throw new GrafanaApiError('network', 'upstream exploded');
      });
      const { service } = await makeService({
        client: fakeClient({ proxyDatasourceRequest }),
        queryRateLimiter: limiterAt(clock, 100, 1)
      });

      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await service.invoke('grafana_query_datasource', queryArgs);
        // A leaked slot would turn the second attempt into UNAVAILABLE.
        expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' });
      }
      expect(proxyDatasourceRequest).toHaveBeenCalledTimes(3);
    });

    it('lets a token buy exactly one request against a real failing Grafana, not one per retry', async () => {
      const clock = fakeClock();
      const upstream = await listen((_req, res) => res.writeHead(502).end());
      try {
        const { service } = await makeService({
          client: new GrafanaApiClient({ baseUrl: upstream.url, token: 'tok', retryBackoffMs: [1, 1] }),
          queryRateLimiter: limiterAt(clock)
        });

        await service.invoke('grafana_query_datasource', queryArgs);
        await service.invoke('grafana_query_datasource', queryArgs);

        // Two tokens, two requests. With the transport's default retry left on
        // this path it would be six, and the instance's configured budget
        // would mean a third of what it says.
        expect(upstream.requestCount).toBe(2);
      } finally {
        await upstream.close();
      }
    });

    it('spends exactly one token per logical query even when the query fails, leaving the retry to the agent', async () => {
      const clock = fakeClock();
      const proxyDatasourceRequest = vi.fn(async () => {
        throw new GrafanaApiError('api-error', 'Grafana returned HTTP 502.', 502);
      });
      const { service } = await makeService({
        client: fakeClient({ proxyDatasourceRequest }),
        queryRateLimiter: limiterAt(clock)
      });

      // A budget of 2 buys exactly two failed calls, not two-thirds of a call:
      // the transport does not retry this path, so nothing is spent invisibly.
      await service.invoke('grafana_query_datasource', queryArgs);
      await service.invoke('grafana_query_datasource', queryArgs);

      expect(await service.invoke('grafana_query_datasource', queryArgs)).toMatchObject({
        ok: false,
        code: 'UNAVAILABLE'
      });
      expect(proxyDatasourceRequest).toHaveBeenCalledTimes(2);
    });

    it('does not meter the management tools, which cost Grafana almost nothing', async () => {
      const clock = fakeClock();
      const { service } = await makeService({ queryRateLimiter: limiterAt(clock, 1, 1) });

      for (let attempt = 0; attempt < 5; attempt++) {
        expect(await service.invoke('grafana_list_dashboards', { instanceId: 'instance-1' })).toMatchObject({ ok: true });
        expect(await service.invoke('grafana_list_datasources', { instanceId: 'instance-1' })).toMatchObject({ ok: true });
      }
    });
  });

  describe('error handling', () => {
    it('turns a GrafanaApiError into a clean failure without leaking the token used to build the client', async () => {
      const secretToken = 'glsa_super_secret_value';
      const client = fakeClient({
        getFolders: async () => {
          throw new GrafanaApiError('auth', 'Grafana rejected the request (HTTP 401).');
        }
      });
      const { service } = await makeService({ client, tokens: { 'instance-1': secretToken } });

      const result = await service.invoke('grafana_list_folders', { instanceId: 'instance-1' });

      expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' });
      expect(JSON.stringify(result)).not.toContain(secretToken);
    });

    it('never throws out of invoke() for an unexpected error', async () => {
      const client = fakeClient({
        getFolders: async () => {
          throw new Error('boom');
        }
      });
      const { service } = await makeService({ client });

      await expect(service.invoke('grafana_list_folders', { instanceId: 'instance-1' })).resolves.toMatchObject({
        ok: false,
        code: 'INTERNAL_ERROR'
      });
    });

    it('rejects a call for an unknown tool name', async () => {
      const { service } = await makeService();
      const result = await service.invoke('grafana_delete_everything', { instanceId: 'instance-1' });
      expect(result).toMatchObject({ ok: false });
    });

    it('rejects malformed arguments (missing uid) with a validation-class failure', async () => {
      const { service } = await makeService();
      const result = await service.invoke('grafana_get_dashboard', { instanceId: 'instance-1' });
      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    });
  });

  describe('TLS trust', () => {
    it('builds a non-interactive certVerifier that only trusts already-recorded fingerprints', async () => {
      const { service, createClient } = await makeService();

      await service.invoke('grafana_list_folders', { instanceId: 'instance-1' });

      expect(createClient).toHaveBeenCalledWith('https://grafana.example.com', 'test-token', expect.any(Object));
      const [, , certVerifier] = createClient.mock.calls[0] as [string, string, { verify: (h: string, p: number, f: string) => Promise<boolean> }];
      await expect(certVerifier.verify('grafana.example.com', 443, 'trusted-fingerprint')).resolves.toBe(true);
      await expect(certVerifier.verify('grafana.example.com', 443, 'some-other-fingerprint')).resolves.toBe(false);
      await expect(certVerifier.verify('never-seen.example.com', 443, 'anything')).resolves.toBe(false);
    });
  });
});
