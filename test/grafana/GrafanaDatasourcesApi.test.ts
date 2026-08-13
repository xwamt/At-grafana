import { afterEach, describe, expect, it } from 'vitest';
import { GrafanaApiError } from '../../src/grafana/GrafanaHttpClient';
import { buildDatasourceProxyPath } from '../../src/grafana/GrafanaDatasourcesApi';
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

/**
 * The `path` argument reaches this class straight from an Agent-supplied
 * `grafana_query_datasource` argument. Because `GrafanaHttpClient.buildUrl`
 * runs the joined string through `new URL(...)`, which normalizes `..`, an
 * unconstrained `path` turns a "read a datasource" tool into a generic
 * Grafana Admin API client (`POST /api/auth/keys` mints a long-lived API
 * key, `POST /api/dashboards/db` overwrites dashboards). Each test below
 * records the URL the upstream actually saw, so a regression reports the
 * escaped Grafana endpoint rather than just "expected 0, got 1".
 */
describe('GrafanaApiClient datasource proxy path confinement', () => {
  async function listenRecordingPaths(): Promise<{ paths: string[]; url: string }> {
    const paths: string[] = [];
    server = await listen((req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    return { paths, url: server.url };
  }

  const traversalPaths: Array<{ label: string; path: string }> = [
    { label: 'relative dot-dot escape into the admin API', path: '../../../../../api/auth/keys' },
    { label: 'leading-slash dot-dot escape into the dashboards API', path: '/../../../../../api/dashboards/db' },
    { label: 'dot-dot buried mid-path', path: 'api/v1/../../../../api/auth/keys' },
    { label: 'percent-encoded dot-dot Grafana would decode downstream', path: '%2e%2e/%2e%2e/api/auth/keys' },
    { label: 'percent-encoded separator', path: 'api%2f..%2f..%2fapi/auth/keys' },
    { label: 'backslash separator', path: '..\\..\\..\\api\\auth\\keys' }
  ];

  for (const { label, path } of traversalPaths) {
    it(`rejects ${label} without making any network call`, async () => {
      const { paths, url } = await listenRecordingPaths();
      const client = new GrafanaApiClient({ baseUrl: url, token: 'tok' });

      const error = await client.proxyDatasourceRequest('ds1', 'GET', path).catch((e: unknown) => e);

      expect(paths).toEqual([]);
      expect(error).toBeInstanceOf(GrafanaApiError);
      expect((error as GrafanaApiError).kind).toBe('validation');
    });
  }

  it('rejects a POST traversal, which is the variant that can mint an API key', async () => {
    const { paths, url } = await listenRecordingPaths();
    const client = new GrafanaApiClient({ baseUrl: url, token: 'tok' });

    const error = await client
      .proxyDatasourceRequest('ds1', 'POST', '../../../../../api/auth/keys', undefined, { name: 'pwned', role: 'Admin' })
      .catch((e: unknown) => e);

    expect(paths).toEqual([]);
    expect((error as GrafanaApiError).kind).toBe('validation');
  });

  it('still forwards a legitimate nested datasource path unchanged', async () => {
    const { paths, url } = await listenRecordingPaths();
    const client = new GrafanaApiClient({ baseUrl: url, token: 'tok' });

    await client.proxyDatasourceRequest('ds1', 'GET', 'loki/api/v1/query_range', { query: '{app="a"}' });

    expect(paths).toEqual(['/api/datasources/proxy/uid/ds1/loki/api/v1/query_range?query=%7Bapp%3D%22a%22%7D']);
  });
});

/**
 * `QueryRateLimiter` spends one token per logical `grafana_query_datasource`
 * call. These pin the other half of that accounting: one token must buy at
 * most one upstream request, so the retry the rest of the client gets is
 * deliberately switched off on this path.
 */
describe('datasource proxy retry budget', () => {
  it('does not retry a 502 from the datasource proxy, so one admitted query is one upstream request', async () => {
    server = await listen((_req, res) => res.writeHead(502).end());
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok', retryBackoffMs: [1, 1] });

    await client.proxyDatasourceRequest('ds1', 'GET', 'api/v1/query').catch(() => undefined);

    expect(server.requestCount).toBe(1);
  });

  it('still retries the unmetered management reads on the same client', async () => {
    let attempts = 0;
    server = await listen((_req, res) => {
      attempts++;
      if (attempts === 1) {
        res.writeHead(502).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([]));
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok', retryBackoffMs: [1, 1] });

    await expect(client.listDatasources()).resolves.toEqual([]);
    expect(attempts).toBe(2);
  });
});

/**
 * Belt-and-braces second layer, mirroring `buildTargetUrl`'s post-resolution
 * host assertion in GrafanaEmbedProxy: the join itself refuses to hand back a
 * path that no longer sits under this datasource's proxy prefix, so a future
 * caller that reaches it without the input-rejection layer above still cannot
 * escape.
 */
describe('buildDatasourceProxyPath', () => {
  it('joins the uid and path under the datasource proxy prefix', () => {
    expect(buildDatasourceProxyPath('ds1', 'api/v1/query')).toBe('/api/datasources/proxy/uid/ds1/api/v1/query');
  });

  it('percent-encodes a uid so it can never open a new path segment', () => {
    expect(buildDatasourceProxyPath('a/b', 'api/v1/query')).toBe('/api/datasources/proxy/uid/a%2Fb/api/v1/query');
  });

  it('throws a validation error when the joined path normalizes outside the datasource proxy prefix', () => {
    expect(() => buildDatasourceProxyPath('ds1', '../../../../../api/auth/keys')).toThrow(GrafanaApiError);
    expect(() => buildDatasourceProxyPath('ds1', '../../../../../api/auth/keys')).toThrow(/datasource proxy/i);
  });

  it('throws rather than silently clamping a traversal that stops just short of the root', () => {
    expect(() => buildDatasourceProxyPath('ds1', '../../other-uid/api/v1/query')).toThrow(GrafanaApiError);
  });
});
