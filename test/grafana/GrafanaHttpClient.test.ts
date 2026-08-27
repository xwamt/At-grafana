import { afterEach, describe, expect, it } from 'vitest';
import {
  GrafanaApiError,
  GrafanaHttpClient,
  getSharedGrafanaHttpsAgent,
  verifyCertFingerprint,
  type GrafanaCertVerifier
} from '../../src/grafana/GrafanaHttpClient';
import type { AtGrafanaLog } from '../../src/utils/logger';
import { listen, listenTls, type TestHttpServer, type TestTlsHttpServer } from './testHttpServer';

const SECRET_TOKEN = 'glsa_super_secret_token_do_not_leak';

/** The real schedule is 200ms/600ms; these tests assert the policy, not the wall clock. */
const FAST_BACKOFF = [1, 1];

/**
 * The PERF-01 hang manifested as the default 15s timeout; anything remotely
 * near that bound means the deferred write did not run on socket assignment.
 * 2s leaves generous CI headroom over the actual few-ms handshake+verify.
 */
const KEEP_ALIVE_FAST_MS = 2000;

let server: TestHttpServer | undefined;
let tlsServer: TestTlsHttpServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
  if (tlsServer) {
    await tlsServer.close();
    tlsServer = undefined;
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

  it('aborts and rejects with kind response-too-large when the response exceeds maxResponseBytes (Task 6.1 early-abort)', async () => {
    server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ big: 'x'.repeat(1000) }));
    });
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN });

    const error = await client.requestJson('GET', '/api/health', { maxResponseBytes: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('response-too-large');
  });

  it('does not abort a response at or under maxResponseBytes', async () => {
    const body = JSON.stringify({ ok: true });
    server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    });
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN });

    await expect(client.requestJson('GET', '/api/health', { maxResponseBytes: Buffer.byteLength(body) })).resolves.toEqual({
      ok: true
    });
  });

  it('is unaffected by maxResponseBytes when omitted, matching pre-Task-6.1 behavior', async () => {
    server = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ big: 'x'.repeat(10_000) }));
    });
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN });

    const result = await client.requestJson<{ big: string }>('GET', '/api/health');
    expect(result.big.length).toBe(10_000);
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

describe('GrafanaHttpClient retries', () => {
  it('retries a GET through a transient 502 and returns the recovered response', async () => {
    let attempts = 0;
    server = await listen((_req, res) => {
      attempts++;
      if (attempts === 1) {
        res.writeHead(502).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    });
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN, retryBackoffMs: FAST_BACKOFF });

    await expect(client.requestJson('GET', '/api/search')).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it('retries a GET whose connection dies mid-flight', async () => {
    let attempts = 0;
    server = await listen((req, res) => {
      attempts++;
      if (attempts === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    });
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN, retryBackoffMs: FAST_BACKOFF });

    await expect(client.requestJson('GET', '/api/search')).resolves.toEqual({ ok: true });
    expect(attempts).toBe(2);
  });

  it('gives up after the configured attempts and throws the last classified error', async () => {
    server = await listen((_req, res) => res.writeHead(503).end());
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN, retryBackoffMs: FAST_BACKOFF });

    const error = await client.requestJson('GET', '/api/search').catch((e: unknown) => e);

    expect((error as GrafanaApiError).kind).toBe('api-error');
    expect((error as GrafanaApiError).status).toBe(503);
    expect(server.requestCount).toBe(3);
  });

  it('does not retry a 404, because repeating it cannot change the answer', async () => {
    server = await listen((_req, res) => res.writeHead(404).end());
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN, retryBackoffMs: FAST_BACKOFF });

    await client.requestJson('GET', '/api/search').catch(() => undefined);

    expect(server.requestCount).toBe(1);
  });

  it('does not retry a 401, so an expired token fails once instead of three times', async () => {
    server = await listen((_req, res) => res.writeHead(401).end());
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN, retryBackoffMs: FAST_BACKOFF });

    await client.requestJson('GET', '/api/search').catch(() => undefined);

    expect(server.requestCount).toBe(1);
  });

  it('does not retry a malformed 2xx body, which is deterministic rather than transient', async () => {
    server = await listen((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('not json'));
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN, retryBackoffMs: FAST_BACKOFF });

    await client.requestJson('GET', '/api/search').catch(() => undefined);

    expect(server.requestCount).toBe(1);
  });

  it('does not retry a POST that fails with a 502, because it is not idempotent', async () => {
    server = await listen((_req, res) => res.writeHead(502).end());
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN, retryBackoffMs: FAST_BACKOFF });

    await client.requestJson('POST', '/api/anything', { body: { query: 'up' } }).catch(() => undefined);

    expect(server.requestCount).toBe(1);
  });

  it('does not retry a GET whose caller opted out', async () => {
    server = await listen((_req, res) => res.writeHead(502).end());
    const client = new GrafanaHttpClient({ baseUrl: server.url, token: SECRET_TOKEN, retryBackoffMs: FAST_BACKOFF });

    await client.requestJson('GET', '/api/search', { retry: false }).catch(() => undefined);

    expect(server.requestCount).toBe(1);
  });

  it('records each retry attempt without leaking the credential', async () => {
    const lines: string[] = [];
    const log: AtGrafanaLog = {
      error: (message) => lines.push(message),
      warn: (message) => lines.push(message),
      info: (message) => lines.push(message),
      debug: (message) => lines.push(message),
      trace: (message) => lines.push(message)
    };
    server = await listen((_req, res) => res.writeHead(502).end());
    const client = new GrafanaHttpClient({
      baseUrl: server.url,
      token: SECRET_TOKEN,
      retryBackoffMs: FAST_BACKOFF,
      log
    });

    await client.requestJson('GET', '/api/search').catch(() => undefined);

    expect(lines.filter((line) => line.includes('retrying'))).toHaveLength(2);
    expect(lines.join('\n')).not.toContain(SECRET_TOKEN);
  });
});

describe('GrafanaHttpClient HTTPS with a certVerifier (PERF-01 keep-alive TOFU regression)', () => {
  const okBody = JSON.stringify({ ok: true });

  it('completes two sequential requests on one client quickly, over a single reused TLS socket', async () => {
    tlsServer = await listenTls((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(okBody);
    });
    const certVerifier: GrafanaCertVerifier = { verify: async () => true };
    const client = new GrafanaHttpClient({ baseUrl: tlsServer.url, token: SECRET_TOKEN, certVerifier, retryBackoffMs: [] });

    const startedFirst = Date.now();
    await expect(client.requestJson('GET', '/api/health')).resolves.toEqual({ ok: true });
    const firstMs = Date.now() - startedFirst;

    const startedSecond = Date.now();
    await expect(client.requestJson('GET', '/api/health')).resolves.toEqual({ ok: true });
    const secondMs = Date.now() - startedSecond;

    // Pre-fix behavior: request 1 fast, request 2 hung until the 15s timeout
    // because a reused keep-alive socket never fires 'secureConnect' again,
    // so the deferred body write never happened.
    expect(firstMs).toBeLessThan(KEEP_ALIVE_FAST_MS);
    expect(secondMs).toBeLessThan(KEEP_ALIVE_FAST_MS);
    expect(tlsServer.requestCount).toBe(2);
    // One handshake for two requests proves the second request actually
    // traveled the reused-socket path this regression test exists for.
    expect(tlsServer.tlsConnectionCount).toBe(1);
  });

  it('fails closed with kind tls and the TOFU recovery hint when the verifier rejects the fingerprint', async () => {
    tlsServer = await listenTls((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(okBody);
    });
    const certVerifier: GrafanaCertVerifier = { verify: async () => false };
    const client = new GrafanaHttpClient({ baseUrl: tlsServer.url, token: SECRET_TOKEN, certVerifier, retryBackoffMs: [] });

    const error = await client.requestJson('GET', '/api/health').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('tls');
    expect((error as GrafanaApiError).message).toContain(
      'The user must open this instance once in the AT Grafana sidebar to confirm its TLS fingerprint (Trust-On-First-Use).'
    );
    // Rejection happens before the deferred write, so the request never
    // reaches the server.
    expect(tlsServer.requestCount).toBe(0);
  });

  it('fails closed on a reused keep-alive socket when the verifier stops trusting the fingerprint', async () => {
    tlsServer = await listenTls((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(okBody);
    });
    let trusted = true;
    const certVerifier: GrafanaCertVerifier = { verify: async () => trusted };
    const client = new GrafanaHttpClient({ baseUrl: tlsServer.url, token: SECRET_TOKEN, certVerifier, retryBackoffMs: [] });

    await expect(client.requestJson('GET', '/api/health')).resolves.toEqual({ ok: true });
    trusted = false;

    const started = Date.now();
    const error = await client.requestJson('GET', '/api/health').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GrafanaApiError);
    expect((error as GrafanaApiError).kind).toBe('tls');
    // The reused-socket path must reject promptly, not stall to timeout.
    expect(Date.now() - started).toBeLessThan(KEEP_ALIVE_FAST_MS);
    // Still a single handshake: the rejection ran on the reused socket, the
    // exact surface where a changed fingerprint must fail closed.
    expect(tlsServer.tlsConnectionCount).toBe(1);
    expect(tlsServer.requestCount).toBe(1);
  });

  it('getSharedGrafanaHttpsAgent exposes one module-level keep-alive agent for the embed proxy to share', () => {
    const agent = getSharedGrafanaHttpsAgent();
    expect(getSharedGrafanaHttpsAgent()).toBe(agent);
    expect(agent.options.keepAlive).toBe(true);
    expect(agent.maxSockets).toBe(8);
  });
});

describe('verifyCertFingerprint', () => {
  it('resolves undefined (trusted) when the verifier approves the fingerprint', async () => {
    const verifier: GrafanaCertVerifier = { verify: async () => true };
    await expect(verifyCertFingerprint(verifier, 'grafana.example.com', 443, 'SHA256:abc')).resolves.toBeUndefined();
  });

  it('resolves a tls GrafanaApiError with the TOFU recovery hint when the verifier rejects the fingerprint', async () => {
    const verifier: GrafanaCertVerifier = { verify: async () => false };
    const result = await verifyCertFingerprint(verifier, 'grafana.example.com', 443, 'SHA256:abc');
    expect(result).toBeInstanceOf(GrafanaApiError);
    expect(result?.kind).toBe('tls');
    // UX-08: the rejection reaches the Agent through MCP tool errors, so the
    // message itself must carry the human recovery path.
    expect(result?.message).toContain(
      'The user must open this instance once in the AT Grafana sidebar to confirm its TLS fingerprint (Trust-On-First-Use).'
    );
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
