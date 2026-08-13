import { afterEach, describe, expect, it } from 'vitest';
import { GrafanaApiError } from '../../src/grafana/GrafanaHttpClient';
import { GrafanaApiClient } from '../../src/grafana/GrafanaApiClient';
import type { AtGrafanaLog } from '../../src/utils/logger';
import { listen, type TestHttpServer } from './testHttpServer';

let server: TestHttpServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

interface RecordedLog extends AtGrafanaLog {
  lines: string[];
  warnings: string[];
}

function recordingLog(): RecordedLog {
  const lines: string[] = [];
  const warnings: string[] = [];
  return {
    lines,
    warnings,
    error: (message) => lines.push(message),
    warn: (message) => {
      lines.push(message);
      warnings.push(message);
    },
    info: (message) => lines.push(message),
    debug: (message) => lines.push(message),
    trace: (message) => lines.push(message)
  };
}

/** The `page`/`limit` pair each request carried, in arrival order. */
function pagingParams(url: string | undefined): { page: string | null; limit: string | null } {
  const parsed = new URL(url ?? '/', 'http://grafana.invalid');
  return { page: parsed.searchParams.get('page'), limit: parsed.searchParams.get('limit') };
}

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

describe('GrafanaApiClient paginated listings', () => {
  it('searchAll() keeps paging until a short page ends the walk', async () => {
    const seen: { page: string | null; limit: string | null }[] = [];
    server = await listen((req, res) => {
      const paging = pagingParams(req.url);
      seen.push(paging);
      const page = Number(paging.page);
      // Two full pages then a short one: 5 dashboards behind a page size of 2.
      const uids = page === 1 ? ['d1', 'd2'] : page === 2 ? ['d3', 'd4'] : ['d5'];
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(uids.map((uid) => ({ uid, title: uid.toUpperCase(), type: 'dash-db' }))));
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const results = await client.searchAll({ type: 'dash-db' }, { pageSize: 2 });

    expect(results.map((entry) => entry.uid)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
    expect(seen).toEqual([
      { page: '1', limit: '2' },
      { page: '2', limit: '2' },
      { page: '3', limit: '2' }
    ]);
  });

  it('searchAll() stops at the total guardrail instead of paging forever', async () => {
    let issued = 0;
    server = await listen((_req, res) => {
      // A pager that always claims another full page: without a total
      // guardrail this walk never terminates.
      const base = issued * 2;
      issued++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify([
          { uid: `d${base + 1}`, title: 'A', type: 'dash-db' },
          { uid: `d${base + 2}`, title: 'B', type: 'dash-db' }
        ])
      );
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const results = await client.searchAll({}, { pageSize: 2, maxResults: 5 });

    expect(results).toHaveLength(5);
    expect(issued).toBe(3);
  });

  it('searchAll() stops when a pager that ignores `page` repeats rows it already returned', async () => {
    let issued = 0;
    server = await listen((_req, res) => {
      issued++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify([
          { uid: 'd1', title: 'A', type: 'dash-db' },
          { uid: 'd2', title: 'B', type: 'dash-db' }
        ])
      );
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const results = await client.searchAll({}, { pageSize: 2, maxResults: 100 });

    expect(results.map((entry) => entry.uid)).toEqual(['d1', 'd2']);
    expect(issued).toBe(2);
  });

  it('searchAll() records how many pages and rows it actually fetched', async () => {
    server = await listen((req, res) => {
      const page = Number(pagingParams(req.url).page);
      const uids = page === 1 ? ['d1', 'd2'] : ['d3'];
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(uids.map((uid) => ({ uid, title: uid, type: 'dash-db' }))));
    });
    const log = recordingLog();
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok', log });

    await client.searchAll({}, { pageSize: 2 });

    expect(log.lines.some((line) => line.includes('/api/search') && line.includes('3') && line.includes('2 page'))).toBe(
      true
    );
  });

  it('searchAll() warns when the guardrail truncated the listing', async () => {
    let issued = 0;
    server = await listen((_req, res) => {
      const base = issued * 2;
      issued++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify([
          { uid: `d${base + 1}`, title: 'A', type: 'dash-db' },
          { uid: `d${base + 2}`, title: 'B', type: 'dash-db' }
        ])
      );
    });
    const log = recordingLog();
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok', log });

    await client.searchAll({}, { pageSize: 2, maxResults: 4 });

    expect(log.warnings).toHaveLength(1);
    expect(log.warnings[0]).toContain('/api/search');
    expect(log.warnings[0]).toContain('4');
  });

  it('getAllFolders() keeps paging until a short page ends the walk', async () => {
    const seen: { page: string | null; limit: string | null }[] = [];
    server = await listen((req, res) => {
      const paging = pagingParams(req.url);
      seen.push(paging);
      const uids = Number(paging.page) === 1 ? ['f1', 'f2'] : ['f3'];
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(uids.map((uid) => ({ uid, title: uid.toUpperCase() }))));
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    const folders = await client.getAllFolders({ pageSize: 2 });

    expect(folders.map((folder) => folder.uid)).toEqual(['f1', 'f2', 'f3']);
    expect(seen).toEqual([
      { page: '1', limit: '2' },
      { page: '2', limit: '2' }
    ]);
  });

  it('leaves the Agent-facing search() as a single unpaged request', async () => {
    let seen: { page: string | null; limit: string | null } | undefined;
    server = await listen((req, res) => {
      seen = pagingParams(req.url);
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify([{ uid: 'd1', title: 'A', type: 'dash-db' }]));
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    await client.search({ type: 'dash-db' });

    expect(server.requestCount).toBe(1);
    expect(seen).toEqual({ page: null, limit: null });
  });

  it('leaves the Agent-facing getFolders() as a single unpaged request', async () => {
    let seen: { page: string | null; limit: string | null } | undefined;
    server = await listen((req, res) => {
      seen = pagingParams(req.url);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ uid: 'f1', title: 'A' }]));
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

    await client.getFolders();

    expect(server.requestCount).toBe(1);
    expect(seen).toEqual({ page: null, limit: null });
  });
});
