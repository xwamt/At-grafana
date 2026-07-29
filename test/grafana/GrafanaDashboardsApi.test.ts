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

describe('GrafanaApiClient dashboards', () => {
  it('search() parses a realistic /api/search response', async () => {
    server = await listen((req, res) => {
      expect(req.url).toMatch(/^\/api\/search/);
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify([
          { uid: 'd1', title: 'Node Overview', type: 'dash-db', tags: ['node'], folderUid: 'f1', folderTitle: 'Infra', url: '/d/d1' },
          { uid: 'f1', title: 'Infra', type: 'dash-folder' }
        ])
      );
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const results = await client.search({ query: 'node' });

    expect(results).toEqual([
      { uid: 'd1', title: 'Node Overview', type: 'dash-db', tags: ['node'], folderUid: 'f1', folderTitle: 'Infra', url: '/d/d1' },
      { uid: 'f1', title: 'Infra', type: 'dash-folder', tags: undefined, folderUid: undefined, folderTitle: undefined, url: undefined }
    ]);
  });

  it('search() classifies a 401 as auth', async () => {
    server = await listen((_req, res) => res.writeHead(401).end());
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const error = await client.search().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('auth');
  });

  it('search() classifies connection refused as network', async () => {
    const client = new GrafanaApiClient({ baseUrl: 'http://127.0.0.1:1', token: 'tok' });

    const error = await client.search().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('network');
  });

  it('getFolders() parses a realistic /api/folders response', async () => {
    server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ uid: 'f1', title: 'Infra' }]));
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    await expect(client.getFolders()).resolves.toEqual([{ uid: 'f1', title: 'Infra', parentUid: undefined }]);
  });

  it('getFolders() classifies a 403 as auth', async () => {
    server = await listen((_req, res) => res.writeHead(403).end());
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const error = await client.getFolders().catch((e: unknown) => e);
    expect((error as GrafanaApiError).kind).toBe('auth');
  });

  it('getDashboardByUid() parses a realistic /api/dashboards/uid/:uid response', async () => {
    server = await listen((req, res) => {
      expect(req.url).toBe('/api/dashboards/uid/d1');
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          dashboard: { uid: 'd1', title: 'Node Overview', version: 3, panels: [{ id: 1, targets: [{ expr: 'up' }] }] },
          meta: { folderUid: 'f1', folderTitle: 'Infra', url: '/d/d1' }
        })
      );
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const dashboard = await client.getDashboardByUid('d1');

    expect(dashboard.uid).toBe('d1');
    expect(dashboard.title).toBe('Node Overview');
    expect(dashboard.version).toBe(3);
    expect(dashboard.folderUid).toBe('f1');
    expect(dashboard.model.panels).toEqual([{ id: 1, targets: [{ expr: 'up' }] }]);
  });

  it('getDashboardByUid() classifies a 401 as auth', async () => {
    server = await listen((_req, res) => res.writeHead(401).end());
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const error = await client.getDashboardByUid('missing').catch((e: unknown) => e);
    expect((error as GrafanaApiError).kind).toBe('auth');
  });

  it('getDashboardByUid() throws invalid-response for a malformed body', async () => {
    server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ notADashboard: true }));
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const error = await client.getDashboardByUid('d1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('invalid-response');
  });
});
