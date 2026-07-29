import { afterEach, describe, expect, it } from 'vitest';
import { GrafanaApiClient } from '../../src/grafana/GrafanaApiClient';
import { GrafanaApiError } from '../../src/grafana/GrafanaHttpClient';
import { listen, type TestHttpServer } from './testHttpServer';

const SECRET_TOKEN = 'glsa_facade_secret_do_not_leak';

let server: TestHttpServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

describe('GrafanaApiClient.health', () => {
  it('resolves ok:true with database/version for a healthy 2xx response', async () => {
    server = await listen((req, res) => {
      expect(req.url).toBe('/api/health');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ database: 'ok', version: '10.4.1' }));
    });
    const client = new GrafanaApiClient({ baseUrl: server.url, token: SECRET_TOKEN });

    await expect(client.health()).resolves.toEqual({ ok: true, database: 'ok', version: '10.4.1' });
  });

  it('classifies a 401 as auth', async () => {
    server = await listen((_req, res) => res.writeHead(401).end());
    const client = new GrafanaApiClient({ baseUrl: server.url, token: SECRET_TOKEN });

    const error = await client.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('auth');
  });

  it('classifies connection refused as network', async () => {
    const client = new GrafanaApiClient({ baseUrl: 'http://127.0.0.1:1', token: SECRET_TOKEN });

    const error = await client.health().catch((e: unknown) => e);
    expect((error as GrafanaApiError).kind).toBe('network');
  });

  it('never leaks the raw token into a resulting error message, even across a full facade round trip', async () => {
    server = await listen((_req, res) => res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'boom' })));
    const client = new GrafanaApiClient({ baseUrl: server.url, token: SECRET_TOKEN });

    const error = await client.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).message).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(error)).not.toContain(SECRET_TOKEN);
  });
});
