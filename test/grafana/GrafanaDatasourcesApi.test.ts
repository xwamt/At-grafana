import { afterEach, describe, expect, it } from 'vitest';
import { GrafanaApiError } from '../../src/grafana/GrafanaHttpClient';
import { GrafanaApiClient } from '../../src/grafana/GrafanaApiClient';
import { listen, readJsonBody, type TestHttpServer } from './testHttpServer';

let server: TestHttpServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

describe('GrafanaApiClient datasources', () => {
  it('listDatasources() parses a realistic /api/datasources response', async () => {
    server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify([{ uid: 'ds1', name: 'Prometheus', type: 'prometheus', url: 'http://prom:9090', isDefault: true }])
      );
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    await expect(client.listDatasources()).resolves.toEqual([
      { uid: 'ds1', name: 'Prometheus', type: 'prometheus', url: 'http://prom:9090', isDefault: true }
    ]);
  });

  it('listDatasources() classifies a 401 as auth', async () => {
    server = await listen((_req, res) => res.writeHead(401).end());
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const error = await client.listDatasources().catch((e: unknown) => e);
    expect((error as GrafanaApiError).kind).toBe('auth');
  });

  it('listDatasources() classifies connection refused as network', async () => {
    const client = new GrafanaApiClient({ baseUrl: 'http://127.0.0.1:1', token: 'tok' });

    const error = await client.listDatasources().catch((e: unknown) => e);
    expect((error as GrafanaApiError).kind).toBe('network');
  });

  it('proxyDatasourceRequest() forwards a GET through /api/datasources/proxy/uid/:uid/:path', async () => {
    server = await listen((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/api/datasources/proxy/uid/ds1/api/v1/query?query=up');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'success' }));
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    await expect(client.proxyDatasourceRequest('ds1', 'GET', 'api/v1/query', { query: 'up' })).resolves.toEqual({ status: 'success' });
  });

  it('proxyDatasourceRequest() forwards a POST body through the proxy', async () => {
    server = await listen(async (req, res) => {
      expect(req.method).toBe('POST');
      expect(await readJsonBody(req)).toEqual({ query: 'up' });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'success' }));
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    await expect(client.proxyDatasourceRequest('ds1', 'POST', 'api/v1/query_range', undefined, { query: 'up' })).resolves.toEqual({
      status: 'success'
    });
  });

  it('proxyDatasourceRequest() classifies a 401 as auth', async () => {
    server = await listen((_req, res) => res.writeHead(401).end());
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const error = await client.proxyDatasourceRequest('ds1', 'GET', 'api/v1/query').catch((e: unknown) => e);
    expect((error as GrafanaApiError).kind).toBe('auth');
  });

  it('proxyDatasourceRequest() rejects a non-GET/POST method WITHOUT making any network call', async () => {
    server = await listen((_req, res) => {
      res.writeHead(200).end('{}');
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });
    const invalidMethod = 'PUT' as unknown as 'GET' | 'POST';

    const error = await client.proxyDatasourceRequest('ds1', invalidMethod, 'api/v1/query').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('validation');
    expect(server.requestCount).toBe(0);
  });

  it('proxyDatasourceRequest() propagates a response-too-large error when maxResponseBytes is exceeded (Task 6.1)', async () => {
    server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ big: 'x'.repeat(1000) }));
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const error = await client.proxyDatasourceRequest('ds1', 'GET', 'api/v1/query', undefined, undefined, 10).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('response-too-large');
  });

  it('proxyDatasourceRequest() rejects DELETE and PATCH the same way, with zero requests reaching the server', async () => {
    server = await listen((_req, res) => {
      res.writeHead(200).end('{}');
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    for (const method of ['DELETE', 'PATCH']) {
      const error = await client.proxyDatasourceRequest('ds1', method as unknown as 'GET' | 'POST', 'api/v1/query').catch((e: unknown) => e);
      expect((error as GrafanaApiError).kind).toBe('validation');
    }
    expect(server.requestCount).toBe(0);
  });
});
