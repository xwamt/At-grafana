import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AT_SERIES_TOKEN_HEADER } from '@at-series/mcp-hub';
import type { GrafanaAgentToolService, ToolInvokeResult } from '../../src/agent/GrafanaAgentToolService';
import type { GrafanaInstanceConfig } from '../../src/config/schema';
import { GrafanaCertTrustStore, type CertTrustMemento } from '../../src/grafana/GrafanaCertTrustStore';
import { GrafanaHttpClient } from '../../src/grafana/GrafanaHttpClient';
import { QueryRateLimiter } from '../../src/grafana/QueryRateLimiter';
import { BridgeServer } from '../../src/mcp/BridgeServer';
import { GrafanaEmbedProxy } from '../../src/webview/GrafanaEmbedProxy';
import { listen, type TestHttpServer } from '../grafana/testHttpServer';
import { recordingLog, type RecordingLog } from '../utils/recordingLog';

/**
 * The observability wiring, tested through the real components rather than
 * through the logger in isolation (`test/utils/logger.test.ts` already covers
 * the sink).
 *
 * Two properties are being pinned here, and the second one matters more than
 * the first:
 *
 * 1. Each surface the plugin can fail on emits *something* at a level that is
 *    visible by default -- the whole point of the batch is that a user hitting
 *    a proxy 502 or a rejected token had nothing to read.
 * 2. No credential ever reaches the channel. Every fixture below uses a
 *    realistically-shaped Grafana Service Account Token, and each test asserts
 *    it is absent from the whole transcript rather than only from the line it
 *    expected to check.
 */

const GRAFANA_TOKEN = 'glsa_H1o2Ck9dQvXzZ4bN7pLmR3sT8uW0yA6e_1f2a3b4c';

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
  return { id, label: `Instance ${id}`, url, allowBackgroundAccess: true, createdAt: 0, updatedAt: 0 };
}

interface RequestResult {
  status: number;
  body: string;
}

function requestProxy(
  port: number,
  path: string,
  options: { headers?: Record<string, string> } = {}
): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

let proxy: GrafanaEmbedProxy | undefined;
let upstream: TestHttpServer | undefined;
const bridges: BridgeServer[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await proxy?.dispose();
  proxy = undefined;
  await upstream?.close();
  upstream = undefined;
  while (bridges.length > 0) {
    await bridges.pop()?.dispose();
  }
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function proxyPort(instance: GrafanaEmbedProxy): number {
  return Number(new URL(instance.origin ?? '').port);
}

/** The proxy's own token-prefixed base, recovered the only way a caller legitimately can. */
function embedPath(instance: GrafanaEmbedProxy, suffix: string): string {
  const base = new URL(instance.buildDashboardUrl('probe', 'probe'));
  const prefix = base.pathname.slice(0, base.pathname.indexOf('/instances/'));
  return `${prefix}${suffix}`;
}

describe('embed proxy logging', () => {
  it('records the listening origin on start and the shutdown on dispose', async () => {
    const log = recordingLog();
    proxy = new GrafanaEmbedProxy({
      configManager: new FakeConfigManager(),
      certTrustStore: new GrafanaCertTrustStore(new MemoryMemento()),
      log
    });

    await proxy.start();
    const origin = proxy.origin;
    await proxy.dispose();
    proxy = undefined;

    expect(log.messages('info').join('\n')).toContain(origin ?? 'MISSING ORIGIN');
    expect(log.messages('info').some((line) => /stopped/i.test(line))).toBe(true);
  });

  it('names the reason an admission check rejected a request without changing the bare 404', async () => {
    const log = recordingLog();
    const configManager = new FakeConfigManager();
    proxy = new GrafanaEmbedProxy({
      configManager,
      certTrustStore: new GrafanaCertTrustStore(new MemoryMemento()),
      log
    });
    await proxy.start();
    const port = proxyPort(proxy);

    const noToken = await requestProxy(port, '/instances/inst-1/api/health');
    const badToken = await requestProxy(port, '/e/not-the-token/instances/inst-1/api/health');
    const badHost = await requestProxy(port, embedPath(proxy, '/instances/inst-1/api/health'), {
      headers: { host: 'grafana.evil.example.com' }
    });
    const badOrigin = await requestProxy(port, embedPath(proxy, '/instances/inst-1/api/health'), {
      headers: { origin: 'https://evil.example.com' }
    });

    for (const result of [noToken, badToken, badHost, badOrigin]) {
      expect(result.status).toBe(404);
      expect(result.body).toBe('Not Found');
    }

    const warnings = log.messages('warn').join('\n');
    expect(warnings).toContain('no-token');
    expect(warnings).toContain('token-mismatch');
    expect(warnings).toContain('host-mismatch');
    expect(warnings).toContain('origin-mismatch');
  });

  it('records an upstream timeout with the deadline that expired', async () => {
    const log = recordingLog();
    upstream = await listen(() => {
      // Accept and never answer, like a wedged Grafana.
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-slow', upstream.url);
    configManager.addInstance(instance, GRAFANA_TOKEN);
    proxy = new GrafanaEmbedProxy({
      configManager,
      certTrustStore: new GrafanaCertTrustStore(new MemoryMemento()),
      limits: { upstreamTimeoutMs: 200 },
      log
    });
    await proxy.start();

    const result = await requestProxy(proxyPort(proxy), embedPath(proxy, `/instances/${instance.id}/api/health`));

    expect(result.status).toBe(504);
    const errors = log.messages('error').join('\n');
    expect(errors).toMatch(/timed out/i);
    expect(errors).toContain('200');
    expect(log.text()).not.toContain(GRAFANA_TOKEN);
  });

  it('records an unreachable upstream as an error', async () => {
    const log = recordingLog();
    // Bind then immediately release, so the port is almost certainly refused.
    const dead = await listen(() => undefined);
    const deadUrl = dead.url;
    await dead.close();
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-dead', deadUrl);
    configManager.addInstance(instance, GRAFANA_TOKEN);
    proxy = new GrafanaEmbedProxy({
      configManager,
      certTrustStore: new GrafanaCertTrustStore(new MemoryMemento()),
      log
    });
    await proxy.start();

    const result = await requestProxy(proxyPort(proxy), embedPath(proxy, `/instances/${instance.id}/api/health`));

    expect(result.status).toBe(502);
    expect(log.messages('error').join('\n')).toMatch(/upstream/i);
    expect(log.text()).not.toContain(GRAFANA_TOKEN);
  });

  it('records the concurrency cap that shed a request', async () => {
    const log = recordingLog();
    const release: Array<() => void> = [];
    upstream = await listen((_req, res) => {
      release.push(() => res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'));
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-flood', upstream.url);
    configManager.addInstance(instance, GRAFANA_TOKEN);
    proxy = new GrafanaEmbedProxy({
      configManager,
      certTrustStore: new GrafanaCertTrustStore(new MemoryMemento()),
      limits: { maxConcurrentRequests: 1, upstreamTimeoutMs: 5000 },
      log
    });
    await proxy.start();
    const port = proxyPort(proxy);
    const path = embedPath(proxy, `/instances/${instance.id}/api/health`);

    const first = requestProxy(port, path);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await requestProxy(port, path);

    expect(second.status).toBe(503);
    expect(log.messages('warn').join('\n')).toMatch(/concurren/i);

    for (const finish of release) {
      finish();
    }
    await first;
  });

  it('logs nothing above debug for a request that succeeds', async () => {
    const log = recordingLog();
    upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    const configManager = new FakeConfigManager();
    const instance = makeInstance('inst-quiet', upstream.url);
    configManager.addInstance(instance, GRAFANA_TOKEN);
    proxy = new GrafanaEmbedProxy({
      configManager,
      certTrustStore: new GrafanaCertTrustStore(new MemoryMemento()),
      log
    });
    await proxy.start();
    log.clear();

    const result = await requestProxy(proxyPort(proxy), embedPath(proxy, `/instances/${instance.id}/api/health`));

    expect(result.status).toBe(200);
    // One line per proxied sub-resource would make the channel unreadable for
    // the failures it exists to show; a healthy request is trace/debug only.
    expect(log.messages('error')).toEqual([]);
    expect(log.messages('warn')).toEqual([]);
    expect(log.messages('info')).toEqual([]);
  });
});

describe('bridge server logging', () => {
  async function startBridge(log: RecordingLog): Promise<{ port: number; token: string }> {
    const home = await mkdtemp(join(tmpdir(), 'at-grafana-log-bridge-'));
    tempRoots.push(home);
    const server = new BridgeServer({ home, hostApp: 'cursor', pluginVersion: '0.1.0', log });
    bridges.push(server);
    await server.start();
    const dir = join(home, '.at-series', 'bridges', 'cursor');
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    const record = JSON.parse(await readFile(join(dir, files[0]!), 'utf8')) as { port: number; token: string };
    return record;
  }

  function bridgeRequest(port: number, path: string, token?: string): Promise<RequestResult> {
    return requestProxy(port, path, token === undefined ? {} : { headers: { [AT_SERIES_TOKEN_HEADER]: token } });
  }

  it('records start and stop, and never writes the bridge token to the channel', async () => {
    const log = recordingLog();
    const { port, token } = await startBridge(log);

    expect(log.messages('info').join('\n')).toContain(String(port));

    await bridges.pop()?.dispose();
    expect(log.messages('info').some((line) => /stopped/i.test(line))).toBe(true);
    expect(log.text()).not.toContain(token);
  });

  it('records a rejected request without echoing the presented credential', async () => {
    const log = recordingLog();
    const { port } = await startBridge(log);
    log.clear();

    const result = await bridgeRequest(port, '/tools', 'a-wrong-but-well-formed-token');

    expect(result.status).toBe(401);
    expect(log.messages('warn').join('\n')).toMatch(/unauthoriz/i);
    expect(log.text()).not.toContain('a-wrong-but-well-formed-token');
  });

  it('records a failed tool invocation with the tool name and error code', async () => {
    const log = recordingLog();
    const home = await mkdtemp(join(tmpdir(), 'at-grafana-log-bridge-'));
    tempRoots.push(home);
    const server = new BridgeServer({
      home,
      hostApp: 'cursor',
      pluginVersion: '0.1.0',
      log,
      toolService: {
        invoke: async (): Promise<ToolInvokeResult> => ({
          ok: false,
          code: 'INTERNAL_ERROR',
          message: `Grafana rejected the request: Bearer ${GRAFANA_TOKEN}`
        })
      } as unknown as GrafanaAgentToolService
    });
    bridges.push(server);
    await server.start();
    const dir = join(home, '.at-series', 'bridges', 'cursor');
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    const record = JSON.parse(await readFile(join(dir, files[0]!), 'utf8')) as { port: number; token: string };

    const result = await new Promise<RequestResult>((resolve, reject) => {
      const body = JSON.stringify({ name: 'grafana_list_folders', arguments: { instanceId: 'inst-1' } });
      const req = http.request(
        {
          host: '127.0.0.1',
          port: record.port,
          path: '/invoke',
          method: 'POST',
          headers: {
            [AT_SERIES_TOKEN_HEADER]: record.token,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body)
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', reject);
      req.end(body);
    });

    expect(result.status).toBe(500);
    const errors = log.messages('error').join('\n');
    expect(errors).toContain('grafana_list_folders');
    expect(errors).toContain('INTERNAL_ERROR');
    expect(log.text()).not.toContain(GRAFANA_TOKEN);
  });
});

describe('TLS trust-on-first-use logging', () => {
  it('records a new trust decision and warns once per changed fingerprint', async () => {
    const log = recordingLog();
    const store = new GrafanaCertTrustStore(new MemoryMemento(), log);

    await store.trust('grafana.example.com', 443, 'AA:BB:CC');
    expect(log.messages('info').join('\n')).toContain('grafana.example.com:443');

    expect(await store.check('grafana.example.com', 443, 'AA:BB:CC')).toBe('trusted');
    expect(log.messages('warn')).toEqual([]);

    expect(await store.check('grafana.example.com', 443, 'DD:EE:FF')).toBe('changed');
    // A changed fingerprint fails every proxied sub-resource of a dashboard,
    // so the warning has to be deduplicated or it buries everything else.
    expect(await store.check('grafana.example.com', 443, 'DD:EE:FF')).toBe('changed');
    expect(log.messages('warn')).toHaveLength(1);
    expect(log.messages('warn')[0]).toContain('DD:EE:FF');
    expect(log.messages('warn')[0]).toContain('AA:BB:CC');
  });
});

describe('query rate limiter logging', () => {
  it('records which instance was shed and what its budget looked like', () => {
    const log = recordingLog();
    let clock = 0;
    const limiter = new QueryRateLimiter({
      maxRequestsPerWindow: 1,
      windowMs: 60_000,
      maxConcurrent: 4,
      now: () => clock,
      log
    });

    const first = limiter.tryAcquire('inst-busy');
    expect(first.allowed).toBe(true);
    expect(log.messages('warn')).toEqual([]);

    const second = limiter.tryAcquire('inst-busy');
    expect(second.allowed).toBe(false);

    const warning = log.messages('warn')[0] ?? '';
    expect(warning).toContain('inst-busy');
    expect(warning).toContain('rate');
    expect(warning).toMatch(/\d/);
    clock += 60_000;
  });

  it('distinguishes a concurrency rejection from a rate rejection', () => {
    const log = recordingLog();
    const limiter = new QueryRateLimiter({
      maxRequestsPerWindow: 100,
      windowMs: 60_000,
      maxConcurrent: 1,
      now: () => 0,
      log
    });

    limiter.tryAcquire('inst-parallel');
    limiter.tryAcquire('inst-parallel');

    expect(log.messages('warn')[0]).toContain('concurrency');
  });
});

describe('Grafana API error classification logging', () => {
  it('records the classified kind and status without the request credential', async () => {
    const log = recordingLog();
    upstream = await listen((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"message":"upstream unavailable"}');
    });
    const client = new GrafanaHttpClient({ baseUrl: upstream.url, token: GRAFANA_TOKEN, log });

    await client.requestJson('GET', '/api/search').catch((error: unknown) => error);

    const debugLines = log.messages('debug').join('\n');
    expect(debugLines).toContain('api-error');
    expect(debugLines).toContain('503');
    expect(debugLines).toContain('/api/search');
    expect(log.text()).not.toContain(GRAFANA_TOKEN);
  });

  it('classifies an unreachable host as a network error', async () => {
    const log = recordingLog();
    const dead = await listen(() => undefined);
    const deadUrl = dead.url;
    await dead.close();
    const client = new GrafanaHttpClient({ baseUrl: deadUrl, token: GRAFANA_TOKEN, log });

    await client.requestJson('GET', '/api/search').catch((error: unknown) => error);

    expect(log.messages('debug').join('\n')).toContain('network');
  });
});
