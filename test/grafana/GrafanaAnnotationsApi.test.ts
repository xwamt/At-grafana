import { afterEach, describe, expect, it } from 'vitest';
import { GrafanaApiClient } from '../../src/grafana/GrafanaApiClient';
import { listen, type TestHttpServer } from './testHttpServer';

let server: TestHttpServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

describe('GrafanaApiClient annotations', () => {
  it('listAnnotations() forwards from, to, dashboardUID, tags, and limit to GET /api/annotations', async () => {
    let seen: string | undefined;
    server = await listen((req, res) => {
      seen = req.url;
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify([{ id: 1, time: 1700000000000, text: 'deploy', tags: ['release'] }])
      );
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const rows = await client.listAnnotations({
      from: 1700000000000,
      to: 1700003600000,
      dashboardUid: 'dash-1',
      tag: 'release',
      limit: 50
    });

    const parsed = new URL(seen ?? '/', 'http://grafana.invalid');
    expect(parsed.pathname).toBe('/api/annotations');
    expect(parsed.searchParams.get('from')).toBe('1700000000000');
    expect(parsed.searchParams.get('to')).toBe('1700003600000');
    expect(parsed.searchParams.get('dashboardUID')).toBe('dash-1');
    expect(parsed.searchParams.get('tags')).toBe('release');
    expect(parsed.searchParams.get('limit')).toBe('50');
    expect(rows).toEqual([{ id: 1, time: 1700000000000, text: 'deploy', tags: ['release'] }]);
  });

  it('listAnnotations() sends limit=100 when limit is omitted', async () => {
    let seen: string | undefined;
    server = await listen((req, res) => {
      seen = req.url;
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]');
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    await client.listAnnotations({ from: 1700000000000, to: 1700003600000 });

    const parsed = new URL(seen ?? '/', 'http://grafana.invalid');
    expect(parsed.pathname).toBe('/api/annotations');
    expect(parsed.searchParams.get('limit')).toBe('100');
    expect(parsed.searchParams.get('from')).toBe('1700000000000');
    expect(parsed.searchParams.get('to')).toBe('1700003600000');
  });
});
