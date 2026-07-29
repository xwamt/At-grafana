import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { GrafanaInstanceConfig } from '../../src/config/schema';
import { GrafanaCertTrustStore, type CertTrustMemento } from '../../src/grafana/GrafanaCertTrustStore';
import type { GrafanaCertVerifier } from '../../src/grafana/GrafanaHttpClient';
import {
  buildRecommendedCsp,
  buildTargetUrl,
  GrafanaEmbedProxy,
  parseInstancePath,
  rewriteAbsoluteReferences,
  type GrafanaEmbedProxyDependencies
} from '../../src/webview/GrafanaEmbedProxy';
import { listen, type TestHttpServer } from '../grafana/testHttpServer';

const TOKEN = 'glsa_super_secret_proxy_token_do_not_leak';

class MemoryMemento implements CertTrustMemento {
  private data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

class FakeConfigManager {
  private readonly instances = new Map<string, GrafanaInstanceConfig>();
  private readonly tokens = new Map<string, string>();

  addInstance(instance: GrafanaInstanceConfig, token: string | undefined): void {
    this.instances.set(instance.id, instance);
    if (token !== undefined) {
      this.tokens.set(instance.id, token);
    }
  }

  async getInstance(id: string): Promise<GrafanaInstanceConfig | undefined> {
    return this.instances.get(id);
  }

  async getToken(id: string): Promise<string | undefined> {
    return this.tokens.get(id);
  }
}

function makeInstance(id: string, url: string): GrafanaInstanceConfig {
  return {
    id,
    label: `Instance ${id}`,
    url,
    allowBackgroundAccess: false,
    createdAt: 0,
    updatedAt: 0
  };
}

interface RequestResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function requestProxy(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

let proxy: GrafanaEmbedProxy | undefined;
let upstream: TestHttpServer | undefined;
let rawServer: net.Server | undefined;

function createProxy(deps: Partial<GrafanaEmbedProxyDependencies> & { configManager: GrafanaEmbedProxyDependencies['configManager'] }): GrafanaEmbedProxy {
  proxy = new GrafanaEmbedProxy({
    certTrustStore: new GrafanaCertTrustStore(new MemoryMemento()),
    ...deps
  });
  return proxy;
}

function proxyPort(target: GrafanaEmbedProxy): number {
  const origin = target.origin;
  if (!origin) {
    throw new Error('proxy has no origin (not started?)');
  }
  return Number(new URL(origin).port);
}

afterEach(async () => {
  if (proxy) {
    await proxy.dispose();
    proxy = undefined;
  }
  if (upstream) {
    await upstream.close();
    upstream = undefined;
  }
  if (rawServer) {
    await new Promise<void>((resolve) => rawServer!.close(() => resolve()));
    rawServer = undefined;
  }
});

describe('GrafanaEmbedProxy header injection', () => {
  it('injects the instance Bearer token and strips any client-supplied Authorization header', async () => {
    upstream = await listen((req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-1', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), `/instances/${instance.id}/api/health`, {
      headers: { authorization: 'Bearer bogus-client-supplied-token' }
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe('ok');
    expect(upstream.requestCount).toBe(1);
  });
});

describe('GrafanaEmbedProxy unknown instance', () => {
  it('returns 404 for an unknown instanceId and never contacts any upstream', async () => {
    upstream = await listen(() => {
      throw new Error('upstream should never be called for an unknown instance');
    });
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), '/instances/does-not-exist/d/abc/dash');

    expect(result.status).toBe(404);
    expect(upstream.requestCount).toBe(0);
  });
});

describe('GrafanaEmbedProxy missing token', () => {
  it('returns a clear error response (not a crash) when no token is configured', async () => {
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-no-token', 'http://127.0.0.1:9');
    configManager.addInstance(instance, undefined);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), `/instances/${instance.id}/d/x/y`);

    expect(result.status).toBe(502);
    expect(result.body).toContain('Service Account Token');
  });
});

describe('GrafanaEmbedProxy TLS trust gate', () => {
  it('refuses to proxy when the certVerifier rejects trust, without attempting any upstream connection', async () => {
    let connectionAttempts = 0;
    rawServer = net.createServer((socket) => {
      connectionAttempts++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, '127.0.0.1', resolve));
    const address = rawServer.address() as AddressInfo;

    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-untrusted', `https://127.0.0.1:${address.port}`);
    configManager.addInstance(instance, TOKEN);
    const rejectingVerifier: GrafanaCertVerifier = { verify: async () => false };
    const embedProxy = createProxy({ configManager, certVerifier: rejectingVerifier });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), `/instances/${instance.id}/d/abc/dash`);

    expect(result.status).toBe(502);
    expect(result.body.toLowerCase()).toContain('certificate');
    expect(connectionAttempts).toBe(0);
  });

  it('passes the pre-flight gate (attempts a connection) once the certVerifier trusts the instance', async () => {
    // No real TLS server is spun up here (out of scope per the task's own
    // allowance — see the final task report); this only proves the
    // pre-flight gate itself does not block a trusted instance, by
    // observing that a real connection attempt reaches the target host
    // (the raw TCP listener sees a connection) rather than being refused
    // before any socket opens, as in the untrusted case above.
    let connectionAttempts = 0;
    rawServer = net.createServer((socket) => {
      connectionAttempts++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => rawServer!.listen(0, '127.0.0.1', resolve));
    const address = rawServer.address() as AddressInfo;

    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-trusted', `https://127.0.0.1:${address.port}`);
    configManager.addInstance(instance, TOKEN);
    const acceptingVerifier: GrafanaCertVerifier = { verify: async () => true };
    const embedProxy = createProxy({ configManager, certVerifier: acceptingVerifier });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), `/instances/${instance.id}/api/health`);

    expect(result.status).toBe(502);
    expect(connectionAttempts).toBeGreaterThan(0);
  });
});

describe('GrafanaEmbedProxy body rewriting', () => {
  it('rewrites absolute references to the real origin inside an HTML response body', async () => {
    upstream = await listen((_req, res) => {
      const realOrigin = upstream!.url;
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(
          `<html><head><script src="${realOrigin}/public/build/app.js"></script></head>` +
            `<body><a href="${realOrigin}/d/other-dash">link</a></body></html>`
        );
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-html', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), `/instances/${instance.id}/d/uid/slug`);

    expect(result.status).toBe(200);
    expect(result.body).not.toContain(upstream.url);
    expect(result.body).toContain(`${embedProxy.origin}/instances/${instance.id}/public/build/app.js`);
    expect(result.body).toContain(`${embedProxy.origin}/instances/${instance.id}/d/other-dash`);
  });

  it('rewrites an absolute Location redirect header pointing at the real origin', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(302, { location: `${upstream!.url}/d/moved-dash` }).end();
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-redirect', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), `/instances/${instance.id}/d/uid/slug`);

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(`${embedProxy.origin}/instances/${instance.id}/d/moved-dash`);
  });

  it('strips Set-Cookie headers from the proxied response', async () => {
    upstream = await listen((_req, res) => {
      res
        .writeHead(200, {
          'content-type': 'text/plain',
          'set-cookie': 'grafana_session=abc123; Path=/; HttpOnly'
        })
        .end('ok');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-cookie', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), `/instances/${instance.id}/d/uid/slug`);

    expect(result.headers['set-cookie']).toBeUndefined();
  });
});

describe('GrafanaEmbedProxy host allowlist (resolveTarget/buildTargetUrl)', () => {
  it('resolves a normal path under the configured instance origin', () => {
    const origin = new URL('https://grafana.example.com:3000');
    const target = buildTargetUrl(origin, '/d/abc/dash', '?from=proxy');

    expect(target.host).toBe('grafana.example.com:3000');
    expect(target.pathname).toBe('/d/abc/dash');
    expect(target.search).toBe('?from=proxy');
  });

  it('keeps a protocol-relative-looking path confined to the origin host instead of hijacking it', () => {
    const origin = new URL('https://grafana.example.com');
    const target = buildTargetUrl(origin, '//evil.example.com/steal', '');

    expect(target.host).toBe('grafana.example.com');
    expect(target.hostname).not.toBe('evil.example.com');
  });

  it('parseInstancePath rejects instanceIds containing path traversal', () => {
    expect(parseInstancePath('/instances/..%2f..%2fetc/d/x')).toBeUndefined();
  });

  it('parseInstancePath rejects instanceIds with userinfo-style/unsafe characters', () => {
    expect(parseInstancePath('/instances/abc@evil.com/d/x')).toBeUndefined();
    expect(parseInstancePath('/instances/abc:1234/d/x')).toBeUndefined();
  });

  it('parseInstancePath accepts a UUID-shaped instanceId and extracts the remaining path/search', () => {
    const result = parseInstancePath('/instances/3fa85f64-5717-4562-b3fc-2c963f66afa6/d/uid1/my-dash?x=1');
    expect(result).toEqual({
      instanceId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      remainingPath: '/d/uid1/my-dash',
      search: '?x=1'
    });
  });

  it('parseInstancePath returns undefined for paths outside the /instances/ prefix', () => {
    expect(parseInstancePath('/other/thing')).toBeUndefined();
  });
});

describe('rewriteAbsoluteReferences', () => {
  it('rewrites https, http, and protocol-relative forms of the real origin', () => {
    const realOrigin = new URL('https://grafana.example.com:3000');
    const text =
      'a=https://grafana.example.com:3000/x b=http://grafana.example.com:3000/y c=//grafana.example.com:3000/z';

    const result = rewriteAbsoluteReferences(text, realOrigin, 'http://127.0.0.1:9999/instances/abc');

    expect(result).toBe(
      'a=http://127.0.0.1:9999/instances/abc/x b=http://127.0.0.1:9999/instances/abc/y c=http://127.0.0.1:9999/instances/abc/z'
    );
  });
});

describe('buildRecommendedCsp', () => {
  it('restricts every directive to the proxy origin', () => {
    const csp = buildRecommendedCsp('http://127.0.0.1:54231');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('frame-src http://127.0.0.1:54231');
    expect(csp).not.toContain('grafana.example.com');
  });
});

describe('GrafanaEmbedProxy WebSocket upgrade handling', () => {
  it('destroys WebSocket upgrade requests instead of hanging', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const port = proxyPort(embedProxy);

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write(
          'GET /instances/x/api/live/ws HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            'Sec-WebSocket-Version: 13\r\n\r\n'
        );
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('timed out waiting for the proxy to close the upgrade socket'));
      }, 3000);
      socket.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });

  it('destroys TRACE requests rather than proxying them', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const port = proxyPort(embedProxy);

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('TRACE /instances/x/d/y HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('timed out waiting for the proxy to close the TRACE socket'));
      }, 3000);
      socket.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  });
});

describe('GrafanaEmbedProxy start/dispose lifecycle', () => {
  it('dispose() stops the server so subsequent requests fail', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const port = proxyPort(embedProxy);

    await embedProxy.dispose();
    proxy = undefined;

    await expect(requestProxy(port, '/instances/x/d/y')).rejects.toThrow();
  });

  it('dispose() is idempotent and safe even if start() was never called', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = new GrafanaEmbedProxy({ configManager, certTrustStore: new GrafanaCertTrustStore(new MemoryMemento()) });

    await expect(embedProxy.dispose()).resolves.toBeUndefined();
    await expect(embedProxy.dispose()).resolves.toBeUndefined();
  });

  it('dispose() is idempotent when called twice after start()', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    await embedProxy.dispose();
    await expect(embedProxy.dispose()).resolves.toBeUndefined();
    proxy = undefined;
  });

  it('start() is idempotent (calling twice keeps the same origin)', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const firstOrigin = embedProxy.origin;
    await embedProxy.start();

    expect(embedProxy.origin).toBe(firstOrigin);
  });

  it('exposes no origin before start()', () => {
    const configManager = new FakeConfigManager();
    const embedProxy = new GrafanaEmbedProxy({ configManager, certTrustStore: new GrafanaCertTrustStore(new MemoryMemento()) });
    expect(embedProxy.origin).toBeUndefined();
  });
});

describe('GrafanaEmbedProxy URL builders', () => {
  it('buildDashboardUrl follows the documented /instances/:instanceId/d/:uid/:slug scheme', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    expect(embedProxy.buildDashboardUrl('inst-1', 'dash-uid', 'my-dashboard')).toBe(
      `${embedProxy.origin}/instances/inst-1/d/dash-uid/my-dashboard`
    );
    expect(embedProxy.buildDashboardUrl('inst-1', 'dash-uid')).toBe(`${embedProxy.origin}/instances/inst-1/d/dash-uid`);
  });

  it('buildAlertRuleUrl follows the documented /instances/:instanceId/alerting/grafana/:uid/view scheme', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    expect(embedProxy.buildAlertRuleUrl('inst-1', 'rule-uid')).toBe(
      `${embedProxy.origin}/instances/inst-1/alerting/grafana/rule-uid/view`
    );
  });

  it('URL builders throw before start() since there is no origin yet', () => {
    const configManager = new FakeConfigManager();
    const embedProxy = new GrafanaEmbedProxy({ configManager, certTrustStore: new GrafanaCertTrustStore(new MemoryMemento()) });
    expect(() => embedProxy.buildDashboardUrl('inst-1', 'dash-uid')).toThrow();
  });
});
