import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isTlsConnectionError, testGrafanaConnection } from '../../src/grafana/testGrafanaConnection';

let server: http.Server | undefined;

async function listen(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe('testGrafanaConnection', () => {
  it('resolves ok for a healthy 2xx response', async () => {
    const url = await listen((req, res) => {
      expect(req.url).toBe('/api/health');
      expect(req.headers['user-agent']).toBe('AT-Grafana/1.0');
      res.writeHead(200).end('{"database":"ok"}');
    });

    await expect(testGrafanaConnection(url, 'token')).resolves.toEqual({ ok: true });
  });

  it('classifies 401/403 responses as an auth failure', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(401).end();
    });

    const result = await testGrafanaConnection(url, 'bad-token');
    expect(result).toMatchObject({ ok: false, reason: 'auth' });
  });

  it('classifies other non-2xx responses as a generic error', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(500).end();
    });

    const result = await testGrafanaConnection(url, undefined);
    expect(result).toMatchObject({ ok: false, reason: 'error' });
  });

  it('classifies connection refused as a network failure', async () => {
    const result = await testGrafanaConnection('http://127.0.0.1:1', undefined);
    expect(result).toMatchObject({ ok: false, reason: 'network' });
  });

  it('rejects a malformed url without making a request', async () => {
    const result = await testGrafanaConnection('not a url', undefined);
    expect(result).toMatchObject({ ok: false, reason: 'error', message: 'Invalid Grafana URL.' });
  });
});

describe('isTlsConnectionError', () => {
  it('recognizes common self-signed/untrusted certificate error codes', () => {
    expect(isTlsConnectionError({ name: 'Error', message: 'x', code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })).toBe(true);
    expect(isTlsConnectionError({ name: 'Error', message: 'x', code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })).toBe(true);
  });

  it('does not misclassify unrelated network errors', () => {
    expect(isTlsConnectionError({ name: 'Error', message: 'x', code: 'ECONNREFUSED' })).toBe(false);
    expect(isTlsConnectionError({ name: 'Error', message: 'x' })).toBe(false);
  });
});
