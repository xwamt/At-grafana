import { afterEach, describe, expect, it } from 'vitest';
import { GrafanaApiError } from '../../src/grafana/GrafanaHttpClient';
import { GrafanaApiClient } from '../../src/grafana/GrafanaApiClient';
import { listen, type TestHttpServer } from './testHttpServer';

let server: TestHttpServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

describe('GrafanaApiClient alerts', () => {
  it('listAlertRules() parses a realistic provisioning API response', async () => {
    server = await listen((req, res) => {
      expect(req.url).toBe('/api/v1/provisioning/alert-rules');
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify([
          {
            uid: 'r1',
            title: 'High CPU',
            folderUID: 'f1',
            ruleGroup: 'infra',
            condition: 'B',
            for: '5m',
            noDataState: 'NoData',
            execErrState: 'Alerting',
            isPaused: false,
            labels: { severity: 'critical' },
            annotations: { summary: 'CPU is high' }
          }
        ])
      );
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    await expect(client.listAlertRules()).resolves.toEqual([
      {
        uid: 'r1',
        title: 'High CPU',
        folderUid: 'f1',
        ruleGroup: 'infra',
        condition: 'B',
        for: '5m',
        noDataState: 'NoData',
        execErrState: 'Alerting',
        isPaused: false,
        labels: { severity: 'critical' },
        annotations: { summary: 'CPU is high' }
      }
    ]);
  });

  it('listAlertRules() classifies a 401 as auth', async () => {
    server = await listen((_req, res) => res.writeHead(401).end());
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const error = await client.listAlertRules().catch((e: unknown) => e);
    expect((error as GrafanaApiError).kind).toBe('auth');
  });

  it('listAlertRules() classifies connection refused as network', async () => {
    const client = new GrafanaApiClient({ baseUrl: 'http://127.0.0.1:1', token: 'tok' });

    const error = await client.listAlertRules().catch((e: unknown) => e);
    expect((error as GrafanaApiError).kind).toBe('network');
  });

  it('listAlertRuleStates() parses a realistic ruler API response, correlating by uid', async () => {
    server = await listen((req, res) => {
      expect(req.url).toBe('/api/prometheus/grafana/api/v1/rules');
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          status: 'success',
          data: {
            groups: [
              {
                name: 'infra',
                file: 'default',
                folderUid: 'f1',
                rules: [
                  { uid: 'r1', name: 'High CPU', state: 'firing', health: 'ok', labels: { severity: 'critical' }, activeAt: '2026-07-29T00:00:00Z' },
                  { uid: 'r2', name: 'Disk Full', state: 'inactive', health: 'ok' }
                ]
              }
            ]
          }
        })
      );
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    await expect(client.listAlertRuleStates()).resolves.toEqual([
      {
        uid: 'r1',
        name: 'High CPU',
        state: 'firing',
        health: 'ok',
        folderUid: 'f1',
        group: 'infra',
        labels: { severity: 'critical' },
        activeAt: '2026-07-29T00:00:00Z'
      },
      {
        uid: 'r2',
        name: 'Disk Full',
        state: 'inactive',
        health: 'ok',
        folderUid: 'f1',
        group: 'infra',
        labels: undefined,
        activeAt: undefined
      }
    ]);
  });

  it('listAlertRuleStates() classifies a 403 as auth', async () => {
    server = await listen((_req, res) => res.writeHead(403).end());
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const error = await client.listAlertRuleStates().catch((e: unknown) => e);
    expect((error as GrafanaApiError).kind).toBe('auth');
  });

  it('listAlertRuleStates() throws invalid-response for an unexpected shape', async () => {
    server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ unexpected: true }));
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const error = await client.listAlertRuleStates().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('invalid-response');
  });

  it('getAlertRuleHistory() parses a DataFrameJSON-shaped response defensively', async () => {
    server = await listen((req, res) => {
      expect(req.url).toBe('/api/v1/rules/history?ruleUID=r1');
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          schema: { fields: [{ name: 'time' }, { name: 'current' }, { name: 'labels' }] },
          data: {
            values: [
              [1700000000000, 1700000060000],
              ['Alerting', 'Normal'],
              [{ severity: 'critical' }, { severity: 'critical' }]
            ]
          }
        })
      );
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    await expect(client.getAlertRuleHistory('r1')).resolves.toEqual([
      { time: 1700000000000, state: 'Alerting', labels: { severity: 'critical' } },
      { time: 1700000060000, state: 'Normal', labels: { severity: 'critical' } }
    ]);
  });

  it('getAlertRuleHistory() also accepts a { results: <frame> } envelope', async () => {
    server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          results: {
            schema: { fields: [{ name: 'Time' }] },
            data: { values: [[1700000000000]] }
          }
        })
      );
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    await expect(client.getAlertRuleHistory('r1')).resolves.toEqual([{ time: 1700000000000, state: undefined, labels: undefined }]);
  });

  it('getAlertRuleHistory() throws invalid-response for a completely unrecognized shape', async () => {
    server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ nothing: 'useful' }));
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const error = await client.getAlertRuleHistory('r1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('invalid-response');
  });

  it('getAlertRuleHistory() classifies a 401 as auth', async () => {
    server = await listen((_req, res) => res.writeHead(401).end());
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const error = await client.getAlertRuleHistory('r1').catch((e: unknown) => e);
    expect((error as GrafanaApiError).kind).toBe('auth');
  });
});
