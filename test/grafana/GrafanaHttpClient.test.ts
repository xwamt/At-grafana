import { afterEach, describe, expect, it } from 'vitest';
import { GrafanaApiError, GrafanaHttpClient, verifyCertFingerprint, type GrafanaCertVerifier } from '../../src/grafana/GrafanaHttpClient';
import { listen, type TestHttpServer } from './testHttpServer';

const SECRET_TOKEN = 'glsa_super_secret_token_do_not_leak';

let server: TestHttpServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

describe('GrafanaHttpClient.requestJson', () => {
  it('parses a realistic 2xx JSON response', async () => {
    server = await listen((req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${SECRET_TOKEN}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ database: 'ok', version: '10.4.1' }));
    });
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN });

    await expect(client.requestJson('GET', '/api/health')).resolves.toEqual({ database: 'ok', version: '10.4.1' });
  });

  it('classifies a 401 response as a GrafanaApiError with kind auth', async () => {
    server = await listen((_req, res) => {
      res.writeHead(401).end();
    });
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN });

    const error = await client.requestJson('GET', '/api/health').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('auth');
    expect((error as GrafanaApiError).status).toBe(401);
  });

  it('classifies a 403 response as a GrafanaApiError with kind auth', async () => {
    server = await listen((_req, res) => {
      res.writeHead(403).end();
    });
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN });

    const error = await client.requestJson('GET', '/api/health').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('auth');
  });

  it('classifies a non-2xx, non-auth response as kind api-error', async () => {
    server = await listen((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'internal boom' }));
    });
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN });

    const error = await client.requestJson('GET', '/api/health').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('api-error');
    expect((error as GrafanaApiError).status).toBe(500);
    expect((error as GrafanaApiError).message).toContain('internal boom');
  });

  it('classifies connection refused as kind network', async () => {
    const client = new GrafanaHttpClient({ baseUrl: 'http://127.0.0.1:1', token: SECRET_TOKEN });

    const error = await client.requestJson('GET', '/api/health').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('network');
  });

  it('classifies a 2xx non-JSON body as kind invalid-response', async () => {
    server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('not json');
    });
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN });

    const error = await client.requestJson('GET', '/api/health').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('invalid-response');
  });

  it('never includes the raw token in a GrafanaApiError message', async () => {
    server = await listen((_req, res) => {
      res.writeHead(401).end();
    });
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN });

    const error = await client.requestJson('GET', '/api/health').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).message).not.toContain(SECRET_TOKEN);
  });

  it('sends the request body as JSON for POST requests', async () => {
    server = await listen(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual({ query: 'up' });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: 'ok' }));
    });
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN });

    await expect(client.requestJson('POST', '/api/anything', { body: { query: 'up' } })).resolves.toEqual({ result: 'ok' });
  });
});

describe('verifyCertFingerprint', () => {
  it('resolves undefined (trusted) when the verifier approves the fingerprint', async () => {
    const verifier: GrafanaCertVerifier = { verify: async () => true };
    await expect(verifyCertFingerprint(verifier, 'grafana.example.com', 443, 'SHA256:abc')).resolves.toBeUndefined();
  });

  it('resolves a tls GrafanaApiError when the verifier rejects the fingerprint', async () => {
    const verifier: GrafanaCertVerifier = { verify: async () => false };
    const result = await verifyCertFingerprint(verifier, 'grafana.example.com', 443, 'SHA256:abc');
    expect(result).toBeInstanceOf(GrafanaApiError);
    expect(result?.kind).toBe('tls');
  });

  it('resolves a tls GrafanaApiError when no fingerprint was presented', async () => {
    const verifier: GrafanaCertVerifier = { verify: async () => true };
    const result = await verifyCertFingerprint(verifier, 'grafana.example.com', 443, undefined);
    expect(result).toBeInstanceOf(GrafanaApiError);
    expect(result?.kind).toBe('tls');
  });

  it('propagates a rejecting verifier as a promise rejection', async () => {
    const verifier: GrafanaCertVerifier = {
      verify: async () => {
        throw new Error('store unavailable');
      }
    };
    await expect(verifyCertFingerprint(verifier, 'grafana.example.com', 443, 'SHA256:abc')).rejects.toThrow('store unavailable');
  });
});
