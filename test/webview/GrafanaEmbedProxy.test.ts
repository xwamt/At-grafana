import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GrafanaInstanceConfig } from '../../src/config/schema';
import { GrafanaCertTrustStore, type CertTrustMemento } from '../../src/grafana/GrafanaCertTrustStore';
import type { GrafanaCertVerifier } from '../../src/grafana/GrafanaHttpClient';
import {
  buildRecommendedCsp,
  buildTargetUrl,
  GrafanaEmbedProxy,
  injectGrafanaEmbedShim,
  injectProxyBaseTag,
  isGrafanaNativePath,
  isLikelyRewritableRequest,
  parseEmbedReferrer,
  parseInstancePath,
  parseProxyRoute,
  rewriteAbsoluteReferences,
  rewriteGrafanaAppSubUrl,
  type GrafanaEmbedProxyDependencies
} from '../../src/webview/GrafanaEmbedProxy';
import { renderEmbedWebviewHtml } from '../../src/webview/html';
import {
  EMBED_PROXY_IDLE_DISPOSE_DELAY_MS,
  disposeOpenPanels,
  setEmbedProxyIdleDisposeTarget,
  trackOpenPanel
} from '../../src/webview/openPanels';
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
  /** Call counters so the PERF-02 tests can prove the proxy caches instead of re-reading per sub-resource. */
  getInstanceCalls = 0;
  getTokenCalls = 0;

  addInstance(instance: GrafanaInstanceConfig, token: string | undefined): void {
    this.instances.set(instance.id, instance);
    if (token !== undefined) {
      this.tokens.set(instance.id, token);
    }
  }

  async getInstance(id: string): Promise<GrafanaInstanceConfig | undefined> {
    this.getInstanceCalls++;
    return this.instances.get(id);
  }

  async getToken(id: string): Promise<string | undefined> {
    this.getTokenCalls++;
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

/** What an upstream actually received, so a test can assert *which* instance's credential arrived where. */
interface UpstreamHit {
  url: string;
  authorization: string | undefined;
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

/** `IncomingHttpHeaders` types every header as `string | string[]`; CSP only ever arrives as one value. */
function cspHeader(headers: http.IncomingHttpHeaders): string {
  const value = headers['content-security-policy'];
  return Array.isArray(value) ? value.join('; ') : value ?? '';
}

let proxy: GrafanaEmbedProxy | undefined;
let upstream: TestHttpServer | undefined;
/** Second upstream, for the multi-instance tests that a single upstream cannot express. */
let secondUpstream: TestHttpServer | undefined;
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

/**
 * Reads the per-start embed token back out of a real URL builder rather than
 * a test-only accessor, so these tests exercise the same path the Webview
 * does: `/e/<token>/instances/<id>/...`.
 */
function embedToken(target: GrafanaEmbedProxy): string {
  const segments = new URL(target.buildDashboardUrl('probe-instance', 'probe-uid')).pathname.split('/');
  const token = segments[2];
  if (!token || segments[1] !== 'e') {
    throw new Error(`proxy URL builder did not produce an /e/<token>/ prefix: ${segments.join('/')}`);
  }
  return token;
}

/** Prefixes an instance-scoped path with the proxy's embed token. */
function embedPath(target: GrafanaEmbedProxy, path: string): string {
  return `/e/${embedToken(target)}${path}`;
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
  if (secondUpstream) {
    await secondUpstream.close();
    secondUpstream = undefined;
  }
  if (rawServer) {
    await new Promise<void>((resolve) => rawServer!.close(() => resolve()));
    rawServer = undefined;
  }
});

/**
 * The proxy injects the instance's Service Account Token into every forwarded
 * request, so anything that can reach it holds an authenticated read/write
 * channel to Grafana. Reachability used to require only the instanceId, which
 * lives in plaintext in VS Code's globalState (`state.vscdb`) and is readable
 * by any process running as the same user -- a malicious npm postinstall or a
 * second extension could scan 127.0.0.1 and drive Grafana through it.
 */
describe('GrafanaEmbedProxy request authorization', () => {
  it('404s a request with no embed token and never contacts the upstream', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('reached-upstream');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-noauth', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    // Deliberately the pre-token URL shape: everything an attacker who read
    // the instanceId out of state.vscdb and scanned loopback would have.
    const result = await requestProxy(proxyPort(embedProxy), `/instances/${instance.id}/api/health`);

    expect(result.status).toBe(404);
    expect(upstream.requestCount).toBe(0);
  });

  it('404s a request carrying a wrong embed token of the same length', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('reached-upstream');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-wrongtoken', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const wrongToken = 'x'.repeat(embedToken(embedProxy).length);

    const result = await requestProxy(proxyPort(embedProxy), `/e/${wrongToken}/instances/${instance.id}/api/health`);

    expect(result.status).toBe(404);
    expect(upstream.requestCount).toBe(0);
  });

  it('serves a request carrying the embed token minted by start()', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-auth', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/api/health`));

    expect(result.status).toBe(200);
    expect(result.body).toBe('ok');
  });

  it('does not name itself in the unauthorized response, so a port scan learns nothing', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), '/instances/anything/api/health');

    expect(result.status).toBe(404);
    expect(result.body.toLowerCase()).not.toContain('grafana');
  });

  it('mints an unguessable token that differs between proxy instances', async () => {
    const configManager = new FakeConfigManager();
    const first = createProxy({ configManager });
    await first.start();
    const firstToken = embedToken(first);
    await first.dispose();
    proxy = undefined;

    const second = createProxy({ configManager });
    await second.start();
    const secondToken = embedToken(second);

    // 32 CSPRNG bytes, base64url-encoded (43 chars, no padding).
    expect(firstToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secondToken).not.toBe(firstToken);
  });

  it('404s a request whose Host header is not the loopback origin, closing DNS rebinding', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('reached-upstream');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-rebind', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/api/health`), {
      headers: { host: 'attacker.example.com' }
    });

    expect(result.status).toBe(404);
    expect(upstream.requestCount).toBe(0);
  });

  it('404s a token-bearing request that carries a foreign Origin', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('reached-upstream');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-origin', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/api/health`), {
      headers: { origin: 'https://attacker.example.com' }
    });

    expect(result.status).toBe(404);
    expect(upstream.requestCount).toBe(0);
  });

  it("accepts a request whose Origin is the proxy's own origin", async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-same-origin', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/api/health`), {
      headers: { origin: embedProxy.origin ?? '' }
    });

    expect(result.status).toBe(200);
  });

  it('carries the token in both URL builders, so the Webview iframe never hits an unauthorized route', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const token = embedToken(embedProxy);

    expect(embedProxy.buildDashboardUrl('inst-1', 'dash-uid', 'my-dashboard')).toBe(
      `${embedProxy.origin}/e/${token}/instances/inst-1/d/dash-uid/my-dashboard`
    );
    expect(embedProxy.buildAlertRuleUrl('inst-1', 'rule-uid')).toBe(
      `${embedProxy.origin}/e/${token}/instances/inst-1/alerting/grafana/rule-uid/view`
    );
  });

  /**
   * DashboardPanel/AlertDetailPanel are unit-tested against a fake proxy, so
   * nothing there would notice the URL scheme changing underneath them. This
   * closes that gap end to end: real proxy -> real URL builder -> real Webview
   * shell -> parse the `src` back out of the rendered HTML -> fetch it. A
   * builder that forgot the token prefix shows up here as the 404 the panel
   * would render as a blank iframe.
   */
  it('serves the exact iframe src that the Webview shell renders', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><head></head><body>dash</body></html>');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-e2e', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const origin = embedProxy.origin ?? '';

    const html = renderEmbedWebviewHtml({
      title: 'My Dashboard',
      proxyOrigin: origin,
      iframeSrc: embedProxy.buildDashboardUrl(instance.id, 'dash-uid', 'my-dashboard')
    });
    const iframeSrc = /<iframe src="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
    if (!iframeSrc) {
      throw new Error(`no iframe src in rendered shell: ${html}`);
    }

    const target = new URL(iframeSrc);
    const result = await requestProxy(Number(target.port), `${target.pathname}${target.search}`);

    expect(target.origin).toBe(origin);
    expect(result.status).toBe(200);
    expect(result.body).toContain('dash');
    // The shell's own CSP has to keep permitting the (now longer) iframe URL.
    expect(html).toContain(`frame-src ${origin}`);
  });

  it('rewrites proxied HTML against the token-scoped base so Grafana sub-resources stay authorized', async () => {
    upstream = await listen((_req, res) => {
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<html><head></head><body></body></html>');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-shim', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const token = embedToken(embedProxy);

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`));

    expect(result.body).toContain(`<base href="${embedProxy.origin}/e/${token}/instances/${instance.id}/">`);
    expect(result.body).toContain(`"/e/${token}/instances/${instance.id}"`);
  });
});

/**
 * Every one of these needs *two* live instances: the failure mode is that a
 * sub-resource request issued by instance A's dashboard gets routed to
 * instance B and authenticated with **B's** Service Account Token. A
 * single-instance test cannot observe that at all, because there is no second
 * credential for the request to be mis-signed with.
 *
 * The setup below is what a browser genuinely does. `Path=/` cookies are a
 * single slot per proxy origin, so opening B's dashboard after A's overwrites
 * the routing hint for *both* iframes; A's page then keeps issuing bare
 * `/api/...` requests (the ones that escape the appSubUrl rewrite) carrying
 * the cookie that now says "B".
 */
describe('GrafanaEmbedProxy multi-instance isolation', () => {
  const TOKEN_A = 'glsa_token_for_instance_a';
  const TOKEN_B = 'glsa_token_for_instance_b';

  interface TwoInstanceFixture {
    embedProxy: GrafanaEmbedProxy;
    token: string;
    hitsA: UpstreamHit[];
    hitsB: UpstreamHit[];
  }

  async function startTwoInstances(): Promise<TwoInstanceFixture> {
    const hitsA: UpstreamHit[] = [];
    const hitsB: UpstreamHit[] = [];
    upstream = await listen((req, res) => {
      hitsA.push({ url: req.url ?? '', authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><head></head><body>A</body></html>');
    });
    secondUpstream = await listen((req, res) => {
      hitsB.push({ url: req.url ?? '', authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><head></head><body>B</body></html>');
    });

    const configManager = new FakeConfigManager();
    configManager.addInstance(makeInstance('inst-a', upstream.url), TOKEN_A);
    configManager.addInstance(makeInstance('inst-b', secondUpstream.url), TOKEN_B);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    return { embedProxy, token: embedToken(embedProxy), hitsA, hitsB };
  }

  it('does not send instance A\'s sub-resource request to instance B under B\'s token', async () => {
    const { embedProxy, token, hitsA, hitsB } = await startTwoInstances();
    const port = proxyPort(embedProxy);
    const origin = embedProxy.origin ?? '';

    // Both dashboards open, B opened last -- so a Path=/ cookie jar now says "B".
    await requestProxy(port, `/e/${token}/instances/inst-a/d/uid-a/dash-a`);
    await requestProxy(port, `/e/${token}/instances/inst-b/d/uid-b/dash-b`);

    // A's iframe issues a bare API call: the browser attaches the (now "B")
    // cookie, and a Referer naming the document that actually made the call.
    await requestProxy(port, '/api/dashboards/home', {
      headers: {
        cookie: `atGrafanaEmbedInstance=inst-b; atGrafanaEmbedToken=${token}`,
        referer: `${origin}/e/${token}/instances/inst-a/d/uid-a/dash-a`
      }
    });

    expect(hitsB.filter((hit) => hit.url === '/api/dashboards/home')).toEqual([]);
    expect(hitsA.filter((hit) => hit.url === '/api/dashboards/home')).toEqual([
      { url: '/api/dashboards/home', authorization: `Bearer ${TOKEN_A}` }
    ]);
  });

  it('mints no ambient Path=/ cookie that a second instance could overwrite', async () => {
    const { embedProxy, token } = await startTwoInstances();

    const result = await requestProxy(proxyPort(embedProxy), `/e/${token}/instances/inst-a/d/uid-a/dash-a`);

    expect(result.headers['set-cookie']).toBeUndefined();
  });

  it('refuses an unattributable bare request rather than guessing an instance', async () => {
    const { embedProxy, token, hitsA, hitsB } = await startTwoInstances();

    const result = await requestProxy(proxyPort(embedProxy), '/api/dashboards/home', {
      headers: { cookie: `atGrafanaEmbedInstance=inst-b; atGrafanaEmbedToken=${token}` }
    });

    expect(result.status).toBe(404);
    expect(hitsA).toEqual([]);
    expect(hitsB).toEqual([]);
  });

  it('attributes each instance\'s bare requests independently when both are active', async () => {
    const { embedProxy, token, hitsA, hitsB } = await startTwoInstances();
    const port = proxyPort(embedProxy);
    const origin = embedProxy.origin ?? '';

    await requestProxy(port, '/api/search', {
      headers: { referer: `${origin}/e/${token}/instances/inst-a/d/uid-a/dash-a` }
    });
    await requestProxy(port, '/api/search', {
      headers: { referer: `${origin}/e/${token}/instances/inst-b/d/uid-b/dash-b` }
    });

    expect(hitsA).toEqual([{ url: '/api/search', authorization: `Bearer ${TOKEN_A}` }]);
    expect(hitsB).toEqual([{ url: '/api/search', authorization: `Bearer ${TOKEN_B}` }]);
  });

  it('rejects a bare request whose Referer carries a wrong embed token', async () => {
    const { embedProxy, token, hitsA, hitsB } = await startTwoInstances();
    const origin = embedProxy.origin ?? '';
    const wrongToken = 'x'.repeat(token.length);

    const result = await requestProxy(proxyPort(embedProxy), '/api/search', {
      headers: { referer: `${origin}/e/${wrongToken}/instances/inst-a/d/uid-a/dash-a` }
    });

    expect(result.status).toBe(404);
    expect(hitsA).toEqual([]);
    expect(hitsB).toEqual([]);
  });

  it('ignores a Referer pointing at some other origin entirely', async () => {
    const { embedProxy, token, hitsA, hitsB } = await startTwoInstances();

    const result = await requestProxy(proxyPort(embedProxy), '/api/search', {
      headers: { referer: `https://attacker.example.com/e/${token}/instances/inst-a/d/uid-a/dash-a` }
    });

    expect(result.status).toBe(404);
    expect(hitsA).toEqual([]);
    expect(hitsB).toEqual([]);
  });
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

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/api/health`), {
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

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, '/instances/does-not-exist/d/abc/dash'));

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

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/d/x/y`));

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

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/d/abc/dash`));

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

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/api/health`));

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

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`));

    expect(result.status).toBe(200);
    expect(result.body).not.toContain(upstream.url);
    expect(result.body).toContain(`${embedProxy.origin}${embedPath(embedProxy, `/instances/${instance.id}`)}/public/build/app.js`);
    expect(result.body).toContain(`${embedProxy.origin}${embedPath(embedProxy, `/instances/${instance.id}`)}/d/other-dash`);
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

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`));

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(`${embedProxy.origin}${embedPath(embedProxy, `/instances/${instance.id}`)}/d/moved-dash`);
  });

  it('strips Set-Cookie headers from the proxied response and sets none of its own', async () => {
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

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`));

    expect(result.headers['set-cookie']).toBeUndefined();
  });

  it('sends a same-origin Referrer-Policy so root-relative sub-resources stay attributable', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><head></head><body>ok</body></html>');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-referrer-policy', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`));

    expect(result.headers['referrer-policy']).toBe('same-origin');
  });

  it("strips X-Frame-Options and replaces the upstream CSP with the proxy's own", async () => {
    upstream = await listen((_req, res) => {
      res
        .writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'x-frame-options': 'SAMEORIGIN',
          'content-security-policy': "frame-ancestors 'self'"
        })
        .end('<html><head></head><body>ok</body></html>');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-frame', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`));

    expect(result.status).toBe(200);
    expect(result.headers['x-frame-options']).toBeUndefined();
    expect(cspHeader(result.headers)).toContain("connect-src 'self'");
    expect(result.body).toContain('<base href=');
    expect(result.body).toContain('d.settings.appSubUrl=p');
  });

  it('injects a base tag so root-relative Grafana assets resolve under the instance proxy prefix', async () => {
    upstream = await listen((_req, res) => {
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end('<html><head><script src="/public/build/app.js"></script></head><body></body></html>');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-base', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`));
    const proxyBase = `${embedProxy.origin}${embedPath(embedProxy, `/instances/${instance.id}`)}`;

    expect(result.body).toContain(`<base href="${proxyBase}/">`);
  });
});

/**
 * `buildRecommendedCsp` protects the *parent* Webview document, and CSP is
 * per-document: its `frame-src` only governs which iframe may be loaded, never
 * what the document inside that iframe may do. The document inside the iframe
 * is the Grafana page this proxy returns, and the proxy strips Grafana's own
 * CSP so the page can be framed at all. Without a replacement, that document
 * runs with no CSP whatsoever -- and Grafana's Text panel supports raw HTML,
 * which makes an imported third-party dashboard JSON a realistic delivery
 * vehicle for a script that exfiltrates whatever the panel can read.
 */
describe('GrafanaEmbedProxy proxied-document CSP', () => {
  async function fetchProxiedHtmlHeaders(upstreamCsp?: string): Promise<http.IncomingHttpHeaders> {
    upstream = await listen((_req, res) => {
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
      if (upstreamCsp !== undefined) {
        headers['content-security-policy'] = upstreamCsp;
      }
      res.writeHead(200, headers).end('<html><head></head><body>ok</body></html>');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-csp', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`));
    return result.headers;
  }

  it('sends its own CSP on a proxied document even when the upstream sent none', async () => {
    const headers = await fetchProxiedHtmlHeaders();

    const csp = cspHeader(headers);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("does not pass the upstream's CSP through in place of its own", async () => {
    const headers = await fetchProxiedHtmlHeaders("default-src 'none'; connect-src https://telemetry.example.com");

    const csp = cspHeader(headers);
    expect(csp).not.toContain('telemetry.example.com');
    expect(csp).toContain("connect-src 'self'");
  });

  it('keeps data: URIs allowed for images and fonts so Grafana icons still render', async () => {
    const headers = await fetchProxiedHtmlHeaders();

    const csp = cspHeader(headers);
    expect(/img-src[^;]*\bdata:/.test(csp)).toBe(true);
    expect(/font-src[^;]*\bdata:/.test(csp)).toBe(true);
  });

  it('lets the VS Code Webview frame the proxied document', async () => {
    const headers = await fetchProxiedHtmlHeaders();

    const csp = cspHeader(headers);
    expect(csp).toContain('frame-ancestors');
    expect(csp).toContain('vscode-webview:');
  });

  it('still lets Grafana boot: its inline boot script and the injected appSubUrl patch must be allowed', async () => {
    const headers = await fetchProxiedHtmlHeaders();

    const csp = cspHeader(headers);
    expect(/script-src[^;]*'unsafe-inline'/.test(csp)).toBe(true);
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

describe('injectProxyBaseTag', () => {
  it('inserts a base tag immediately after head and replaces any existing base tag', () => {
    const html = '<html><head><base href="/"><title>x</title></head><body></body></html>';
    const result = injectProxyBaseTag(html, 'http://127.0.0.1:4321/instances/abc');

    expect(result).toContain('<base href="http://127.0.0.1:4321/instances/abc/">');
    expect(result.match(/<base\b/gi)?.length).toBe(1);
  });
});

describe('injectGrafanaEmbedShim', () => {
  it('rewrites appSubUrl and does not strip the instance prefix via history.replaceState', () => {
    const html =
      '<html><head></head><body><script>window.grafanaBootData={"settings":{"appSubUrl":"","appUrl":"https://g.example/"}};</script></body></html>';
    const result = injectGrafanaEmbedShim(html, 'http://127.0.0.1:4321/instances/abc', '/instances/abc');

    expect(result).toContain('"appSubUrl":"/instances/abc"');
    expect(result).not.toContain('history.replaceState');
    expect(result).toContain('d.settings.appSubUrl=p');
  });
});

describe('rewriteGrafanaAppSubUrl', () => {
  it('replaces empty and non-empty appSubUrl values in boot JSON', () => {
    expect(rewriteGrafanaAppSubUrl('{"appSubUrl":""}', '/instances/x')).toBe('{"appSubUrl":"/instances/x"}');
    expect(rewriteGrafanaAppSubUrl('{"appSubUrl":"/grafana"}', '/instances/x')).toBe(
      '{"appSubUrl":"/instances/x"}'
    );
  });
});

describe('parseProxyRoute', () => {
  it('routes native Grafana paths through the referrer-derived instance id', () => {
    const route = parseProxyRoute('/d/uid/slug?orgId=1', 'inst-abc');

    expect(route).toEqual({
      instanceId: 'inst-abc',
      remainingPath: '/d/uid/slug',
      search: '?orgId=1'
    });
  });

  it('rejects native paths with no attributable instance', () => {
    expect(parseProxyRoute('/d/uid/slug', undefined)).toBeUndefined();
    expect(parseProxyRoute('/d/uid/slug', '../bad')).toBeUndefined();
  });
});

describe('parseEmbedReferrer', () => {
  const ORIGIN = 'http://127.0.0.1:4321';

  it('extracts the token and instance id from a document URL this proxy served', () => {
    expect(parseEmbedReferrer(`${ORIGIN}/e/tok123/instances/inst-a/d/uid/slug?orgId=1`, ORIGIN)).toEqual({
      token: 'tok123',
      instanceId: 'inst-a'
    });
  });

  it('ignores a referrer from any other origin, however well-formed its path', () => {
    expect(parseEmbedReferrer(`https://attacker.example.com/e/tok123/instances/inst-a/d/uid/slug`, ORIGIN)).toBeUndefined();
  });

  it('ignores a referrer that names no instance', () => {
    expect(parseEmbedReferrer(`${ORIGIN}/e/tok123/api/health`, ORIGIN)).toBeUndefined();
  });

  it('ignores a referrer with an unsafe instance id', () => {
    expect(parseEmbedReferrer(`${ORIGIN}/e/tok123/instances/..%2f..%2fetc/d/uid`, ORIGIN)).toBeUndefined();
  });

  it('returns undefined when there is no referrer or no proxy origin yet', () => {
    expect(parseEmbedReferrer(undefined, ORIGIN)).toBeUndefined();
    expect(parseEmbedReferrer(`${ORIGIN}/e/tok123/instances/inst-a/d/uid`, undefined)).toBeUndefined();
  });
});

describe('isGrafanaNativePath', () => {
  it('recognizes dashboard, API, and static asset prefixes', () => {
    expect(isGrafanaNativePath('/d/abc/slug')).toBe(true);
    expect(isGrafanaNativePath('/api/search')).toBe(true);
    expect(isGrafanaNativePath('/public/build/app.js')).toBe(true);
    expect(isGrafanaNativePath('/unknown/path')).toBe(false);
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

/**
 * The proxy buffers up to `maxRewriteBufferBytes` per rewritable response and
 * runs inside the extension host process, so an upstream that accepts a
 * connection and then goes quiet -- or simply a lot of them at once -- is a
 * memory and socket problem for VS Code itself, not just a slow panel.
 * `GrafanaHttpClient` has had a 15s timeout since Task 2.1; this path never
 * got one.
 *
 * Timeouts here are shrunk via injected limits so the tests stay fast; the
 * shipped defaults are in DEFAULT_EMBED_PROXY_LIMITS.
 */
describe('GrafanaEmbedProxy upstream timeouts and concurrency', () => {
  /** Turns a hang into a readable assertion failure instead of a vitest-level timeout. */
  async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
        })
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  it('gives up on an upstream that never responds instead of hanging forever', async () => {
    upstream = await listen(() => {
      // Accept the request and never answer, like a wedged Grafana.
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-slow', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager, limits: { upstreamTimeoutMs: 300 } });
    await embedProxy.start();

    const result = await within(
      requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/api/health`)),
      3000,
      'proxy response for a wedged upstream'
    );

    expect(result.status).toBe(504);
  });

  it('tears down the upstream socket on timeout rather than leaking it', async () => {
    let upstreamSocketClosed = false;
    upstream = await listen((req) => {
      req.on('close', () => {
        upstreamSocketClosed = true;
      });
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-leak', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager, limits: { upstreamTimeoutMs: 300 } });
    await embedProxy.start();

    await within(
      requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/api/health`)),
      3000,
      'proxy response for a wedged upstream'
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(upstreamSocketClosed).toBe(true);
  });

  it('sheds load past the concurrency cap instead of queueing unbounded work', async () => {
    const release: Array<() => void> = [];
    upstream = await listen((_req, res) => {
      release.push(() => res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'));
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-flood', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({
      configManager,
      limits: { maxConcurrentRequests: 2, upstreamTimeoutMs: 5000 }
    });
    await embedProxy.start();
    const port = proxyPort(embedProxy);
    const path = embedPath(embedProxy, `/instances/${instance.id}/api/health`);

    const first = requestProxy(port, path);
    const second = requestProxy(port, path);
    // Let both occupy an upstream slot before the third arrives.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const third = await within(requestProxy(port, path), 3000, 'third concurrent request');

    expect(third.status).toBe(503);
    expect(third.headers['retry-after']).toBeDefined();

    for (const finish of release) {
      finish();
    }
    await within(Promise.all([first, second]), 3000, 'in-flight requests');
  });

  it('frees a concurrency slot once a request finishes, so the cap is not a one-way ratchet', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-serial', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager, limits: { maxConcurrentRequests: 1 } });
    await embedProxy.start();
    const port = proxyPort(embedProxy);
    const path = embedPath(embedProxy, `/instances/${instance.id}/api/health`);

    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await within(requestProxy(port, path), 3000, `sequential request ${attempt}`);
      expect(result.status).toBe(200);
    }
  });

  it('closes a client that dribbles its headers instead of holding the socket open', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager, limits: { headersTimeoutMs: 300, requestTimeoutMs: 600 } });
    await embedProxy.start();
    const port = proxyPort(embedProxy);

    const received = await within(
      new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write('GET /e/tok/instances/x/api/health HTTP/1.1\r\n');
          socket.write('Host: 127.0.0.1\r\n');
          // Never send the terminating blank line.
        });
        // Reading is required, not incidental: a paused socket never processes
        // the server's FIN, so without this the close is never observed.
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
        socket.on('error', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }),
      3000,
      'slowloris socket'
    );

    expect(received).toContain('408');
  });

  it('caps total buffered rewrite bytes across concurrent responses', async () => {
    const big = 'x'.repeat(64 * 1024);
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.write('<html><head></head><body>');
      let written = 0;
      const pump = setInterval(() => {
        written += big.length;
        if (written > 2 * 1024 * 1024 || !res.writable) {
          clearInterval(pump);
          res.end();
          return;
        }
        res.write(big);
      }, 1);
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-budget', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({
      configManager,
      limits: { maxTotalRewriteBufferBytes: 128 * 1024, upstreamTimeoutMs: 5000 }
    });
    await embedProxy.start();

    const result = await within(
      requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`)),
      5000,
      'oversized rewrite response'
    );

    expect(result.status).toBe(502);
    expect(result.body).toContain('too large');
  });
});

/**
 * PERF-02: a dashboard load issues hundreds of sub-resource requests, and
 * every one used to pay a full config parse (`getInstance`) plus a
 * SecretStorage IPC round-trip (`getToken`). The proxy now reads once per
 * instance and holds the pair until something invalidates it.
 */
describe('GrafanaEmbedProxy credential caching (PERF-02)', () => {
  it('reads the instance and token once across multiple requests to the same instance', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-cache', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const path = embedPath(embedProxy, `/instances/${instance.id}/api/health`);

    await requestProxy(proxyPort(embedProxy), path);
    await requestProxy(proxyPort(embedProxy), path);
    await requestProxy(proxyPort(embedProxy), path);

    expect(upstream.requestCount).toBe(3);
    expect(configManager.getInstanceCalls).toBe(1);
    expect(configManager.getTokenCalls).toBe(1);
  });

  it('re-reads the token after invalidateInstance', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-invalidate', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const path = embedPath(embedProxy, `/instances/${instance.id}/api/health`);

    await requestProxy(proxyPort(embedProxy), path);
    expect(configManager.getTokenCalls).toBe(1);

    embedProxy.invalidateInstance(instance.id);
    await requestProxy(proxyPort(embedProxy), path);

    expect(configManager.getTokenCalls).toBe(2);
  });

  it('re-reads every instance after invalidateAll', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-invalidate-all', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const path = embedPath(embedProxy, `/instances/${instance.id}/api/health`);

    await requestProxy(proxyPort(embedProxy), path);
    embedProxy.invalidateAll();
    await requestProxy(proxyPort(embedProxy), path);

    expect(configManager.getInstanceCalls).toBe(2);
    expect(configManager.getTokenCalls).toBe(2);
  });

  it('drops the cached credential when the upstream answers 401, so a rotated token is re-read', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('invalid token');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-rotated', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const path = embedPath(embedProxy, `/instances/${instance.id}/api/health`);

    await requestProxy(proxyPort(embedProxy), path);
    await requestProxy(proxyPort(embedProxy), path);

    expect(configManager.getTokenCalls).toBe(2);
  });

  it('start() drops cached credentials so a panel reopen sees an edited instance', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-reopen', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const path = embedPath(embedProxy, `/instances/${instance.id}/api/health`);

    await requestProxy(proxyPort(embedProxy), path);
    await embedProxy.start();
    await requestProxy(proxyPort(embedProxy), path);

    expect(configManager.getTokenCalls).toBe(2);
  });

  it('does not cache a missing token: adding one later is picked up without an explicit invalidation', async () => {
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-late-token', upstream.url);
    configManager.addInstance(instance, undefined);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const path = embedPath(embedProxy, `/instances/${instance.id}/api/health`);

    const before = await requestProxy(proxyPort(embedProxy), path);
    configManager.addInstance(instance, TOKEN);
    const after = await requestProxy(proxyPort(embedProxy), path);

    expect(before.status).toBe(502);
    expect(after.status).toBe(200);
  });
});

/**
 * PERF-03 (encoding half): only requests likely to yield a rewritable
 * response (HTML/JS/CSS) force `Accept-Encoding: identity`; everything else
 * keeps the client's own header so Grafana may compress the responses the
 * proxy pipes through verbatim.
 */
describe('GrafanaEmbedProxy upstream compression (PERF-03)', () => {
  it('passes the client Accept-Encoding through for a JSON API request', async () => {
    const seen: Array<string | undefined> = [];
    upstream = await listen((req, res) => {
      seen.push(req.headers['accept-encoding']);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-json', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/api/search`), {
      headers: { accept: 'application/json', 'accept-encoding': 'gzip, br' }
    });

    expect(seen).toEqual(['gzip, br']);
  });

  it('sends no Accept-Encoding at all for a non-rewritable request whose client sent none', async () => {
    const seen: Array<string | undefined> = [];
    upstream = await listen((req, res) => {
      seen.push(req.headers['accept-encoding']);
      res.writeHead(200, { 'content-type': 'image/png' }).end('png-bytes');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-image', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/public/img/icon.png`));

    expect(seen).toEqual([undefined]);
  });

  it('forces identity for the main dashboard document', async () => {
    const seen: Array<string | undefined> = [];
    upstream = await listen((req, res) => {
      seen.push(req.headers['accept-encoding']);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html><head></head><body></body></html>');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-doc', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`), {
      headers: { 'accept-encoding': 'gzip, br' }
    });

    expect(seen).toEqual(['identity']);
  });

  it('forces identity for JS bundle paths', async () => {
    const seen: Array<string | undefined> = [];
    upstream = await listen((req, res) => {
      seen.push(req.headers['accept-encoding']);
      res.writeHead(200, { 'content-type': 'application/javascript' }).end('console.log(1)');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-js', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/public/build/app.js`), {
      headers: { 'accept-encoding': 'gzip, br' }
    });

    expect(seen).toEqual(['identity']);
  });

  it('gunzips a gzip-encoded rewritable response before rewriting it', async () => {
    upstream = await listen((_req, res) => {
      const html = `<html><head></head><body><a href="${upstream!.url}/d/other">link</a></body></html>`;
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
        .end(zlib.gzipSync(html));
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-gzip', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`));

    expect(result.status).toBe(200);
    expect(result.headers['content-encoding']).toBeUndefined();
    expect(result.body).toContain('<base href=');
    expect(result.body).not.toContain(upstream.url);
    expect(result.body).toContain(`${embedProxy.origin}${embedPath(embedProxy, `/instances/${instance.id}`)}/d/other`);
  });
});

describe('isLikelyRewritableRequest', () => {
  it('recognizes document, script, and style requests by header or path', () => {
    expect(isLikelyRewritableRequest({ accept: 'text/html,application/xhtml+xml' }, '/d/abc/dash')).toBe(true);
    expect(isLikelyRewritableRequest({ 'sec-fetch-dest': 'script' }, '/anything')).toBe(true);
    expect(isLikelyRewritableRequest({}, '/public/build/app.js')).toBe(true);
    expect(isLikelyRewritableRequest({}, '/public/build/theme.css')).toBe(true);
    expect(isLikelyRewritableRequest({}, '/d/abc/dash')).toBe(true);
    expect(isLikelyRewritableRequest({}, '/alerting/grafana/rule/view')).toBe(true);
    expect(isLikelyRewritableRequest({}, '/')).toBe(true);
  });

  it('leaves API, image, and font requests alone', () => {
    expect(isLikelyRewritableRequest({ accept: 'application/json' }, '/api/search')).toBe(false);
    expect(isLikelyRewritableRequest({}, '/public/img/grafana_icon.svg')).toBe(false);
    expect(isLikelyRewritableRequest({}, '/public/fonts/roboto.woff2')).toBe(false);
    expect(isLikelyRewritableRequest({ 'sec-fetch-dest': 'image' }, '/avatar/abc')).toBe(false);
  });
});

/**
 * PERF-03 (cache half): rewritten HTML/JS/CSS is retained keyed by instance +
 * path and revalidated upstream via `If-None-Match`. A 304 replays the cached
 * rewrite (no body transfer, no re-rewrite); a 200 with a new ETag — what a
 * Grafana upgrade produces — replaces the entry, so nothing stale can ship.
 */
describe('GrafanaEmbedProxy rewrite cache (PERF-03)', () => {
  it('revalidates with If-None-Match and replays the cached rewrite on 304 without a second body transfer', async () => {
    let bodyServes = 0;
    const validators: Array<string | undefined> = [];
    upstream = await listen((req, res) => {
      validators.push(req.headers['if-none-match']);
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304, { etag: '"v1"' }).end();
        return;
      }
      bodyServes++;
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"v1"' })
        .end('<html><head></head><body>version-one</body></html>');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-rewrite-cache', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const path = embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`);

    const first = await requestProxy(proxyPort(embedProxy), path);
    const second = await requestProxy(proxyPort(embedProxy), path);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toBe(first.body);
    expect(second.body).toContain('version-one');
    expect(second.body).toContain('<base href=');
    expect(validators).toEqual([undefined, '"v1"']);
    expect(bodyServes).toBe(1);
    expect(upstream.requestCount).toBe(2);
  });

  it('answers 304 to a client that already holds the cached version', async () => {
    upstream = await listen((req, res) => {
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304, { etag: '"v1"' }).end();
        return;
      }
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"v1"' })
        .end('<html><head></head><body>version-one</body></html>');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-client-304', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const path = embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`);

    await requestProxy(proxyPort(embedProxy), path);
    const revalidation = await requestProxy(proxyPort(embedProxy), path, {
      headers: { 'if-none-match': '"v1"' }
    });

    expect(revalidation.status).toBe(304);
    expect(revalidation.body).toBe('');
  });

  it('serves the fresh body when the upstream ETag changes (a Grafana upgrade never reads stale)', async () => {
    let version = 1;
    upstream = await listen((req, res) => {
      // Version changed: the stored validator no longer matches, so the
      // upstream ignores the conditional and answers 200 with new content.
      if (req.headers['if-none-match'] === `"v${version}"`) {
        res.writeHead(304, { etag: `"v${version}"` }).end();
        return;
      }
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: `"v${version}"` })
        .end(`<html><head></head><body>version-${version}</body></html>`);
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-upgrade', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const path = embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`);

    const before = await requestProxy(proxyPort(embedProxy), path);
    version = 2;
    const after = await requestProxy(proxyPort(embedProxy), path);

    expect(before.body).toContain('version-1');
    expect(after.body).toContain('version-2');
  });

  it('never caches an error response', async () => {
    const validators: Array<string | undefined> = [];
    upstream = await listen((req, res) => {
      validators.push(req.headers['if-none-match']);
      res
        .writeHead(500, { 'content-type': 'text/html; charset=utf-8', etag: '"err"' })
        .end('<html><head></head><body>boom</body></html>');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-error', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const path = embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`);

    await requestProxy(proxyPort(embedProxy), path);
    await requestProxy(proxyPort(embedProxy), path);

    expect(validators).toEqual([undefined, undefined]);
  });

  it('drops cached rewrites for an instance on invalidateInstance', async () => {
    const validators: Array<string | undefined> = [];
    upstream = await listen((req, res) => {
      validators.push(req.headers['if-none-match']);
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"v1"' })
        .end('<html><head></head><body>fresh</body></html>');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-drop', upstream.url);
    configManager.addInstance(instance, TOKEN);
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    const path = embedPath(embedProxy, `/instances/${instance.id}/d/uid/slug`);

    await requestProxy(proxyPort(embedProxy), path);
    embedProxy.invalidateInstance(instance.id);
    await requestProxy(proxyPort(embedProxy), path);

    expect(validators).toEqual([undefined, undefined]);
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

/**
 * PERF-11 end to end: start() registers the proxy with the openPanels idle
 * tracker, so once the last embed panel has been closed for the idle delay
 * the proxy's server is shut down, and the next panel-open's start() call
 * brings it back.
 */
describe('GrafanaEmbedProxy idle shutdown (PERF-11)', () => {
  function stubPanel(): { panel: never; close(): void } {
    const disposeListeners: Array<() => void> = [];
    const panel = {
      reveal: () => undefined,
      dispose: () => {
        for (const listener of [...disposeListeners]) {
          listener();
        }
      },
      onDidDispose: (listener: () => void) => {
        disposeListeners.push(listener);
        return { dispose: () => undefined };
      }
    };
    return { panel: panel as never, close: () => panel.dispose() };
  }

  afterEach(() => {
    disposeOpenPanels();
    setEmbedProxyIdleDisposeTarget(undefined);
    vi.useRealTimers();
  });

  it('shuts down after the last panel closes and revives on the next start()', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();
    expect(embedProxy.origin).toBeDefined();

    vi.useFakeTimers();
    const tracked = stubPanel();
    trackOpenPanel('dashboard:idle-proxy', tracked.panel);
    tracked.close();

    vi.advanceTimersByTime(EMBED_PROXY_IDLE_DISPOSE_DELAY_MS - 1);
    expect(embedProxy.origin).toBeDefined();
    vi.advanceTimersByTime(1);
    // dispose() clears the origin synchronously; the socket teardown it then
    // awaits is irrelevant to what this test asserts.
    expect(embedProxy.origin).toBeUndefined();

    vi.useRealTimers();
    await embedProxy.start();
    expect(embedProxy.origin).toBeDefined();
  });

  it('keeps running while a panel is still open', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    vi.useFakeTimers();
    const first = stubPanel();
    const second = stubPanel();
    trackOpenPanel('dashboard:still-open', first.panel);
    trackOpenPanel('alert:still-open', second.panel);
    first.close();

    vi.advanceTimersByTime(EMBED_PROXY_IDLE_DISPOSE_DELAY_MS * 2);

    expect(embedProxy.origin).toBeDefined();
  });
});

describe('GrafanaEmbedProxy URL builders', () => {
  it('buildDashboardUrl follows the documented /e/:embedToken/instances/:instanceId/d/:uid/:slug scheme', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const base = `${embedProxy.origin}/e/${embedToken(embedProxy)}`;
    expect(embedProxy.buildDashboardUrl('inst-1', 'dash-uid', 'my-dashboard')).toBe(
      `${base}/instances/inst-1/d/dash-uid/my-dashboard`
    );
    expect(embedProxy.buildDashboardUrl('inst-1', 'dash-uid')).toBe(`${base}/instances/inst-1/d/dash-uid`);
  });

  it('buildAlertRuleUrl follows the documented /e/:embedToken/instances/:instanceId/alerting/grafana/:uid/view scheme', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    expect(embedProxy.buildAlertRuleUrl('inst-1', 'rule-uid')).toBe(
      `${embedProxy.origin}/e/${embedToken(embedProxy)}/instances/inst-1/alerting/grafana/rule-uid/view`
    );
  });

  it('URL builders throw before start() since there is no origin yet', () => {
    const configManager = new FakeConfigManager();
    const embedProxy = new GrafanaEmbedProxy({ configManager, certTrustStore: new GrafanaCertTrustStore(new MemoryMemento()) });
    expect(() => embedProxy.buildDashboardUrl('inst-1', 'dash-uid')).toThrow();
  });
});
