import * as http from 'node:http';
import * as https from 'node:https';
import type { Socket } from 'node:net';
import * as zlib from 'node:zlib';
import { createBridgeToken, timingSafeEqualToken } from '@at-series/mcp-hub';
import type { GrafanaInstanceConfig } from '../config/schema';
import type { GrafanaInstanceConfigManager } from '../config/GrafanaInstanceConfigManager';
import type { GrafanaCertTrustStore } from '../grafana/GrafanaCertTrustStore';
import { attachCertVerification, type GrafanaCertVerifier } from '../grafana/GrafanaHttpClient';
import { formatError } from '../utils/errors';
import { asRedactedLog, type AtGrafanaLog } from '../utils/logger';
import { redactSensitiveText } from '../utils/redaction';
import { setEmbedProxyIdleDisposeTarget } from './openPanels';

/**
 * Task 4.1 (docs/plans/2026-07-29-at-grafana-v1-implementation-plan.md,
 * Phase 4) — local HTTP reverse proxy per ADR-003
 * (docs/decisions/ADR-003-panel-alert-embedding-via-local-proxy.md).
 *
 * ## Why a separate `http.Server`, not merged into BridgeServer
 *
 * Per the plan's Open Question 3, this is deliberately its own bare
 * `node:http` server, not a route prefix on `BridgeServer`. `BridgeServer`
 * serves small JSON tool-invocation results behind a shared-secret header;
 * this proxy streams arbitrary HTML/JS/CSS/binary Grafana responses to a
 * Webview `<iframe>` with per-instance TLS/token handling and body
 * rewriting. Keeping them as two independent servers makes each easier to
 * reason about and test in isolation, and matches ADR-003's framing of the
 * embed proxy as a distinct code path from the Bridge's `/invoke` handling.
 * The only thing the two share is "a bare Node `http.Server` bound to
 * 127.0.0.1 on an ephemeral port," which is small enough not to be worth a
 * shared abstraction (see BridgeServer.ts's `start`/`dispose` for the
 * equivalent bind/listen/close pattern this class mirrors).
 *
 * ## Authorization: the `/e/:embedToken` prefix
 *
 * Every request this proxy accepts gets the instance's Service Account Token
 * injected (see `forward`), so reaching it at all means holding an
 * authenticated read/write channel to Grafana. The instanceId cannot be that
 * credential: it lives in plaintext in VS Code's `globalState`
 * (`state.vscdb`), readable by any process running as the same user, so a
 * malicious npm postinstall script or a second extension could read it, scan
 * 127.0.0.1 for the port, and drive Grafana through this proxy for as long as
 * the extension stays active.
 *
 * So `start()` mints a per-run token (32 CSPRNG bytes via the shared
 * `createBridgeToken`) that every URL below is prefixed with, and
 * `handleRequest` rejects anything that does not present it. Alongside it:
 * the `Host` header must be the literal loopback authority (closing DNS
 * rebinding, where a hostname the attacker controls resolves to 127.0.0.1),
 * and any `Origin` header must be this proxy's own. Rejections are a bare
 * 404, not a 401 — a challenge would tell a port scanner it found the AT
 * Grafana proxy and that guessing is worth continuing.
 *
 * ## URL scheme (depended on by Task 4.2/4.3 — treat as a stable contract)
 *
 * - Dashboards: `/e/:embedToken/instances/:instanceId/d/:uid/:slug?`, mirroring Grafana's
 *   own dashboard URL (`/d/:uid/:slug`, slug optional/best-effort — Grafana
 *   resolves the dashboard by uid regardless of what the slug segment says).
 * - Alert rules: `/instances/:instanceId/alerting/grafana/:uid/view`,
 *   mirroring Grafana's native Unified Alerting rule view page.
 *   Both verified against Grafana's public documentation/source
 *   (`grafana/public/app/features/alerting/unified/utils/misc.ts`,
 *   `createRelativeUrl(\`/alerting/${source}/${id}/view\`)` with
 *   `source: 'grafana'` for Grafana-managed rules) as of 2026-07-29 —
 *   **high confidence**, but not exercised against a live Grafana instance
 *   in this environment; re-confirm at the Phase 4 checkpoint per the plan's
 *   own risk note. Prefixed with `/e/:embedToken` like every other route.
 * - Any other path under `/instances/:instanceId/...` is forwarded verbatim
 *   to the same path on the real Grafana origin, which is what lets
 *   Grafana's own JS fetch its sub-resources (JS/CSS bundles, `/api/...`
 *   XHR calls) through the proxy without a bespoke route per asset type.
 *
 * ## Known limitation: no WebSocket proxying (Grafana Live)
 *
 * `Upgrade: websocket` requests (used by some panels for Grafana Live
 * real-time push updates) are refused by destroying the socket rather than
 * proxied — an explicitly accepted risk mitigation from the plan's Risks
 * table. Dashboards still load and are fully interactive over plain HTTP;
 * only live-push panel updates degrade to needing a manual refresh.
 *
 * ## CSP guidance for Task 4.2/4.3 (not implemented here)
 *
 * See `buildRecommendedCsp` below — Task 4.2/4.3's Webview HTML should
 * restrict every CSP directive to this proxy's own origin only, per
 * ADR-003's last bullet, so the Webview's renderer/network layer never sees
 * the real Grafana origin or the Bearer token.
 */
export interface GrafanaEmbedProxyDependencies {
  configManager: Pick<GrafanaInstanceConfigManager, 'getInstance' | 'getToken'>;
  certTrustStore: GrafanaCertTrustStore;
  /**
   * Injectable for tests. Real usage should NOT wire
   * `createInteractiveCertVerifier` here — see the class doc above and
   * `createInteractiveCertVerifier.ts`'s doc comment for why the proxy
   * refuses untrusted instances outright instead of prompting per-request.
   * When omitted, a non-interactive default is used that only allows
   * traffic to hosts already recorded as trusted in `certTrustStore`.
   */
  certVerifier?: GrafanaCertVerifier;
  /** Overrides for DEFAULT_EMBED_PROXY_LIMITS; tests shrink the timeouts so they stay fast. */
  limits?: Partial<GrafanaEmbedProxyLimits>;
  /**
   * Diagnostics only. Everything this proxy refuses is refused *silently* by
   * design -- a bare 404 with no product name, a 502 rendered inside an
   * iframe the user may not even have open -- so the channel is the only
   * place the reason can be recorded. Never consulted for a decision.
   */
  log?: AtGrafanaLog;
}

/**
 * Resource ceilings for the proxy. These are not tuning knobs for throughput
 * -- they exist because this server runs inside the VS Code extension host,
 * so an upstream that accepts a connection and then goes quiet costs the
 * editor its memory and file descriptors, not just a blank panel.
 */
export interface GrafanaEmbedProxyLimits {
  /** Socket inactivity timeout for the request to the real Grafana. */
  upstreamTimeoutMs: number;
  /** Ceiling on how long a client may take to deliver a complete request. */
  requestTimeoutMs: number;
  /** Ceiling on how long a client may take to deliver its headers (slowloris). */
  headersTimeoutMs: number;
  /** Hard cap on simultaneously open client sockets. */
  maxConnections: number;
  /** Cap on requests being forwarded upstream at once; excess is shed with a 503. */
  maxConcurrentRequests: number;
  /** Cap on the buffered body of a single rewritable response. */
  maxRewriteBufferBytes: number;
  /** Cap on buffered rewrite bodies across all in-flight responses combined. */
  maxTotalRewriteBufferBytes: number;
  /** Cap on total bytes retained in the rewritten-response LRU cache (see `rewriteCache`). */
  maxRewriteCacheBytes: number;
}

/**
 * `upstreamTimeoutMs` matches `GrafanaHttpClient`'s long-standing 15s so both
 * paths to the same Grafana give up at the same point.
 *
 * The two buffer caps are deliberately a pair. Per-response alone bounds
 * nothing useful: the interesting failure is many concurrent rewritable
 * responses, where `maxConcurrentRequests * maxRewriteBufferBytes` is what
 * actually reaches the heap. `maxTotalRewriteBufferBytes` is the number that
 * bounds the extension host, and it is well under the per-response cap times
 * the concurrency cap on purpose -- a single pathological response may use the
 * full 25 MiB, but a fleet of them cannot.
 *
 * `maxConnections` is set far above the ~6 sockets a browser opens per origin
 * so a normally-loading dashboard never touches it; it is a runaway guard, not
 * a scheduling policy.
 */
export const DEFAULT_EMBED_PROXY_LIMITS: GrafanaEmbedProxyLimits = {
  upstreamTimeoutMs: 15_000,
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  maxConnections: 64,
  maxConcurrentRequests: 32,
  maxRewriteBufferBytes: 25 * 1024 * 1024,
  maxTotalRewriteBufferBytes: 64 * 1024 * 1024,
  // Sibling budget to maxTotalRewriteBufferBytes: in-flight rewrite buffers
  // and retained rewrite-cache entries are two separate pools, each with its
  // own ceiling. 32 MiB comfortably holds a Grafana build's rewritable
  // assets (index document + the JS/CSS bundles are single-digit MiB total)
  // without letting a long session hoard the extension host's heap.
  maxRewriteCacheBytes: 32 * 1024 * 1024
};

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

/** Upstream headers that block iframe embedding or break a cross-origin proxy shell. */
const EMBED_BLOCKING_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy'
]);

const REWRITABLE_CONTENT_TYPE_PATTERN = /^(text\/html|application\/javascript|text\/javascript|application\/x-javascript|text\/css)\b/i;

const INSTANCE_PATH_PATTERN = /^\/instances\/([^/]+)(\/.*)?$/;

/** Kept short so it costs little in every rewritten Grafana asset URL. */
const EMBED_TOKEN_PATH_SEGMENT = 'e';

const EMBED_TOKEN_PATH_PATTERN = /^\/e\/([^/]+)(\/.*)?$/;

/** Instance ids are `randomUUID()` outputs; anything else is rejected outright rather than risk-assessed, which also forecloses `..`/`@`/`%`-based smuggling through the instanceId segment. */
const SAFE_INSTANCE_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

/** Why `checkAdmission` refused, for the log only -- every value but `ok` produces the same bare 404. */
type AdmissionResult = 'ok' | 'not-started' | 'no-token' | 'token-mismatch' | 'host-mismatch' | 'origin-mismatch';

/**
 * One retained rewritten response (PERF-03). `etag` is the *upstream's* own
 * validator for the original body; the stored `body` is the rewritten form of
 * exactly that upstream version, so revalidating the etag against Grafana
 * (`If-None-Match` → 304) proves the rewritten copy is still current too.
 */
interface RewriteCacheEntry {
  etag: string;
  body: Buffer;
  contentType: string;
}

export class GrafanaEmbedProxy {
  private server: http.Server | undefined;
  private port: number | undefined;
  private embedToken: string | undefined;
  private readonly sockets = new Set<Socket>();
  private readonly limits: GrafanaEmbedProxyLimits;
  private inFlightRequests = 0;
  private rewriteBufferBytesInFlight = 0;
  private readonly log: AtGrafanaLog;
  /**
   * PERF-02: `handleRequest` used to hit `configManager.getInstance` (a zod
   * parse over the full instance list) plus `configManager.getToken` (a
   * SecretStorage IPC round-trip) for *every* proxied sub-resource — a
   * dashboard load issues hundreds. Entries leave via `invalidateInstance`/
   * `invalidateAll` (which `start()` calls, so every fresh panel-open batch
   * re-reads config once), when the config manager stops knowing the
   * instance, when its token becomes empty, or when the upstream answers 401
   * (a rotated token: the stale credential must not be pinned).
   */
  private readonly credentialCache = new Map<string, { instance: GrafanaInstanceConfig; token: string }>();
  /**
   * PERF-03: rewritten HTML/JS/CSS bodies, keyed by `instanceId + path` with
   * the upstream ETag stored per entry. A hit never serves the entry
   * outright — the request still goes upstream with `If-None-Match`, and only
   * an upstream `304 Not Modified` licenses replaying the cached rewrite.
   * That is strictly fresher than embedding the validator in the lookup key:
   * a Grafana upgrade answers 200 with a new ETag and the entry is replaced,
   * so a stale rewrite can never be served. What the cache saves is the body
   * transfer and the full-text rewrite, which for Grafana's multi-MiB JS
   * bundles is the expensive half. Map insertion order doubles as the LRU
   * order; total retained bytes are capped by `limits.maxRewriteCacheBytes`.
   */
  private readonly rewriteCache = new Map<string, RewriteCacheEntry>();
  private rewriteCacheBytes = 0;

  constructor(private readonly deps: GrafanaEmbedProxyDependencies) {
    this.limits = { ...DEFAULT_EMBED_PROXY_LIMITS, ...deps.limits };
    this.log = asRedactedLog(deps.log);
  }

  get origin(): string | undefined {
    return this.port === undefined ? undefined : `http://127.0.0.1:${this.port}`;
  }

  /**
   * Drops every cached credential and rewrite for `instanceId`. Exported for
   * the instance-form save path (and anything else that edits an instance):
   * the cache has no TTL, so an explicit invalidation is what keeps an
   * edited URL or rotated token from being served stale.
   */
  invalidateInstance(instanceId: string): void {
    this.credentialCache.delete(instanceId);
    for (const key of [...this.rewriteCache.keys()]) {
      if (key.startsWith(`${instanceId}\n`)) {
        this.evictRewriteCacheEntry(key);
      }
    }
  }

  invalidateAll(): void {
    this.credentialCache.clear();
    this.rewriteCache.clear();
    this.rewriteCacheBytes = 0;
  }

  async start(): Promise<void> {
    // Even a no-op restart (server already up) drops cached credentials:
    // start() runs on every panel open, so this is the hook that keeps the
    // TTL-less credential cache honest without requiring config-change
    // events to be wired up. The hundreds of sub-resource requests that
    // follow one open still share a single config read. The rewrite cache
    // survives no-op restarts on purpose — every hit is revalidated against
    // the upstream ETag, so it cannot go stale — and is dropped below only
    // when a real restart mints a new embed token (the cached bodies were
    // rewritten against the old token's URL prefix).
    this.credentialCache.clear();
    if (this.server) {
      return;
    }
    this.invalidateAll();
    this.embedToken = createBridgeToken();
    const server = http.createServer(
      {
        // Node enforces the two timeouts below from a periodic sweep, not a
        // per-socket timer, and that sweep defaults to every 30s -- which
        // would round a 10s headers deadline up to as much as 40s. Tying the
        // interval to the deadline keeps enforcement close to the configured
        // value. The sweep timer is unref'd by Node, so it costs nothing.
        connectionsCheckingInterval: Math.min(30_000, Math.max(500, this.limits.headersTimeoutMs)),
        // Node's own defaults (5min / 60s) assume a public server that wants
        // to tolerate slow clients. This one only ever serves a local Webview,
        // so a client that cannot finish its headers promptly is holding a
        // socket for no legitimate reason.
        requestTimeout: this.limits.requestTimeoutMs,
        headersTimeout: this.limits.headersTimeoutMs
      },
      (request, response) => {
        void this.handleRequest(request, response);
      }
    );
    server.maxConnections = this.limits.maxConnections;
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    // CONNECT (e.g. HTTPS tunneling through this proxy) is refused by
    // destroying the socket; Node would otherwise leave it hanging open with
    // no listener. TRACE is refused inside handleRequest (it reaches the
    // normal 'request' event, unlike CONNECT).
    server.on('connect', (_request, socket) => {
      socket.destroy();
    });
    // Grafana Live WebSocket upgrades: destroy rather than hang. See the
    // class doc's "Known limitation" section — full WebSocket proxying is
    // out of scope for this task per the plan's accepted risk mitigation.
    server.on('upgrade', (_request, socket) => {
      socket.destroy();
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to start AT Grafana embed proxy.');
    }
    this.port = address.port;
    // PERF-11: once the last embed panel has been closed for a while there
    // is no legitimate client left, so openPanels shuts this server down.
    // Registered from start() (not the constructor) because start() is what
    // every panel-open path already calls, and it is idempotent — the next
    // open after an idle shutdown simply starts the proxy again.
    setEmbedProxyIdleDisposeTarget(this);
    // The origin, not the token-prefixed base: the base is a credential.
    this.log.info(`embed-proxy: listening on ${this.origin ?? ''}`);
  }

  async dispose(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.embedToken = undefined;
    this.inFlightRequests = 0;
    this.rewriteBufferBytesInFlight = 0;
    if (!server) {
      return;
    }
    const socketCount = this.sockets.size;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.log.info(`embed-proxy: stopped (closed ${socketCount} open socket(s))`);
  }

  /** Mirrors Grafana's own `/d/:uid/:slug` dashboard URL scheme (slug optional, cosmetic only — Grafana resolves by uid). */
  buildDashboardUrl(
    instanceId: string,
    dashboardUid: string,
    dashboardSlugOrPath?: string,
    search?: string
  ): string {
    const base = this.requireEmbedBase();
    const slugSegment = dashboardSlugOrPath ? `/${encodeURIComponent(dashboardSlugOrPath)}` : '';
    const query =
      search && search.length > 0 ? (search.startsWith('?') ? search : `?${search}`) : '';
    return `${base}/instances/${encodeURIComponent(instanceId)}/d/${encodeURIComponent(dashboardUid)}${slugSegment}${query}`;
  }

  /** Mirrors Grafana's native Unified Alerting rule view page (`/alerting/grafana/:uid/view`) — see class doc for the source verifying this. */
  buildAlertRuleUrl(instanceId: string, ruleUid: string): string {
    const base = this.requireEmbedBase();
    return `${base}/instances/${encodeURIComponent(instanceId)}/alerting/grafana/${encodeURIComponent(ruleUid)}/view`;
  }

  /**
   * The single place every externally-visible embed URL is built from, so a
   * new route cannot accidentally be minted without the token prefix.
   */
  private requireEmbedBase(): string {
    if (!this.origin || this.embedToken === undefined) {
      throw new Error('GrafanaEmbedProxy is not started.');
    }
    return `${this.origin}${this.embedPathPrefix()}`;
  }

  private embedPathPrefix(): string {
    return `/${EMBED_TOKEN_PATH_SEGMENT}/${this.embedToken ?? ''}`;
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (request.method === 'TRACE') {
        request.socket.destroy();
        return;
      }

      const rawUrl = request.url ?? '/';
      const tokenRoute = splitEmbedTokenPath(rawUrl);
      // Fallback attribution for the sub-resource requests that escape the
      // appSubUrl/base rewrite and arrive at the proxy root with neither the
      // token nor the instance in their path. See parseEmbedReferrer for why
      // this is read per-request from the Referer rather than from a cookie.
      const referrer = parseEmbedReferrer(request.headers.referer, this.origin);
      const presentedToken = tokenRoute?.token ?? referrer?.token;
      const admission = this.checkAdmission(request, presentedToken);
      if (admission !== 'ok') {
        // The 404 stays bare (see `respondNotFound`); the *reason* is only
        // ever written here, where a port scanner cannot read it.
        this.log.warn(
          `embed-proxy: rejected a request (reason=${admission}, method=${request.method ?? 'GET'}, ` +
            `path=${pathOnly(request.url ?? '/')})`
        );
        respondNotFound(response);
        return;
      }

      const parsedPath = parseProxyRoute(tokenRoute?.target ?? rawUrl, referrer?.instanceId);
      if (!parsedPath) {
        this.log.warn(`embed-proxy: no route matched ${pathOnly(request.url ?? '/')}`);
        respondError(response, 404, 'Unknown AT Grafana proxy route.');
        return;
      }

      const credentials = await this.resolveCredentials(parsedPath.instanceId);
      if (credentials.kind === 'unknown-instance') {
        this.log.warn(`embed-proxy: request named an unknown instance ${parsedPath.instanceId}`);
        respondError(response, 404, `Unknown Grafana instance: ${parsedPath.instanceId}.`);
        return;
      }
      if (credentials.kind === 'no-token') {
        this.log.error(`embed-proxy: instance ${parsedPath.instanceId} has no Service Account Token configured`);
        respondError(response, 502, 'No Service Account Token is configured for this Grafana instance.');
        return;
      }
      const { instance, token } = credentials;

      let realOrigin: URL;
      try {
        realOrigin = new URL(instance.url);
      } catch {
        this.log.error(`embed-proxy: instance ${instance.id} has an unparseable configured URL`);
        respondError(response, 502, 'This Grafana instance has an invalid configured URL.');
        return;
      }

      if (realOrigin.protocol === 'https:') {
        const trusted = await this.isHttpsOriginTrusted(realOrigin.hostname, portOf(realOrigin));
        if (!trusted) {
          // GrafanaCertTrustStore already warned (deduplicated) about *why*.
          this.log.error(`embed-proxy: refused instance ${instance.id}; its TLS certificate is not trusted`);
          respondError(
            response,
            502,
            "This Grafana instance's TLS certificate is not trusted. Confirm the certificate fingerprint " +
              '(Trust-On-First-Use) before opening this view.'
          );
          return;
        }
      } else if (realOrigin.protocol !== 'http:') {
        this.log.error(`embed-proxy: instance ${instance.id} uses an unsupported URL scheme ${realOrigin.protocol}`);
        respondError(response, 502, 'This Grafana instance has an unsupported URL scheme.');
        return;
      }

      let targetUrl: URL;
      try {
        targetUrl = buildTargetUrl(realOrigin, parsedPath.remainingPath, parsedPath.search);
      } catch {
        this.log.warn(`embed-proxy: refused a path that escaped instance ${instance.id}'s own origin`);
        respondError(response, 400, 'Invalid proxy request path.');
        return;
      }

      // Claimed only now, once the request is known to be headed upstream, so
      // that rejected and unroutable requests cannot exhaust the budget.
      if (!this.acquireRequestSlot(response)) {
        this.log.warn(
          `embed-proxy: shed a request for ${targetUrl.pathname}; the concurrency cap of ` +
            `${this.limits.maxConcurrentRequests} in-flight upstream requests is full`
        );
        respondServiceUnavailable(response);
        return;
      }

      this.log.trace(`embed-proxy: forwarding ${request.method ?? 'GET'} ${targetUrl.pathname} for instance ${instance.id}`);
      this.forward(request, response, targetUrl, realOrigin, instance.id, token);
    } catch (error) {
      this.log.error(`embed-proxy: unhandled error while routing a request: ${formatError(error)}`);
      if (!response.headersSent) {
        respondError(response, 502, `AT Grafana proxy error: ${formatError(error)}`);
      } else {
        response.destroy();
      }
    }
  }

  /**
   * Takes a concurrency slot for a request about to be forwarded, releasing it
   * when the client response closes.
   *
   * `close` on the response is the one event guaranteed to fire exactly once
   * on every outcome -- success, upstream error, upstream timeout, or the
   * Webview navigating away mid-request -- which is what keeps the counter
   * from drifting upward until the proxy wedges itself shut.
   */
  private acquireRequestSlot(response: http.ServerResponse): boolean {
    if (this.inFlightRequests >= this.limits.maxConcurrentRequests) {
      return false;
    }
    this.inFlightRequests++;
    let released = false;
    response.on('close', () => {
      if (released) {
        return;
      }
      released = true;
      this.inFlightRequests--;
    });
    return true;
  }

  /**
   * The whole admission gate, evaluated before anything else looks at the
   * request. See the class doc's "Authorization" section for the threat this
   * closes; the short version is that reaching this proxy is equivalent to
   * holding the instance's Service Account Token, so knowing the instanceId
   * (which any local process can read out of `state.vscdb`) must not be
   * sufficient.
   *
   * Returns *which* check failed rather than a boolean. The distinction never
   * leaves the process -- every failure produces the same bare 404, so no
   * caller can tell these apart -- but "the Webview sent no token" and "some
   * other local process is probing us" are opposite problems, and until this
   * batch there was nowhere to tell them apart from the outside either.
   */
  private checkAdmission(request: http.IncomingMessage, presentedToken: string | undefined): AdmissionResult {
    const expected = this.embedToken;
    if (expected === undefined) {
      return 'not-started';
    }
    if (presentedToken === undefined) {
      return 'no-token';
    }
    if (!timingSafeEqualToken(presentedToken, expected)) {
      return 'token-mismatch';
    }
    // Compared against the literal loopback authority rather than "some
    // hostname that resolves to 127.0.0.1", which is exactly the difference
    // that makes DNS rebinding fail here.
    if (request.headers.host !== `127.0.0.1:${this.port ?? ''}`) {
      return 'host-mismatch';
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== this.origin) {
      return 'origin-mismatch';
    }
    return 'ok';
  }

  /**
   * PERF-02: one config/SecretStorage read per instance per `start()`, not
   * per sub-resource. Negative outcomes are never cached — an instance the
   * config manager does not know, or an empty token, invalidates instead, so
   * the next request re-asks rather than pinning the failure.
   */
  private async resolveCredentials(
    instanceId: string
  ): Promise<
    | { kind: 'ok'; instance: GrafanaInstanceConfig; token: string }
    | { kind: 'unknown-instance' }
    | { kind: 'no-token' }
  > {
    const cached = this.credentialCache.get(instanceId);
    if (cached) {
      return { kind: 'ok', instance: cached.instance, token: cached.token };
    }
    const instance = await this.deps.configManager.getInstance(instanceId);
    if (!instance) {
      this.invalidateInstance(instanceId);
      return { kind: 'unknown-instance' };
    }
    const token = await this.deps.configManager.getToken(instance.id);
    if (!token) {
      this.invalidateInstance(instanceId);
      return { kind: 'no-token' };
    }
    this.credentialCache.set(instanceId, { instance, token });
    return { kind: 'ok', instance, token };
  }

  private evictRewriteCacheEntry(key: string): void {
    const entry = this.rewriteCache.get(key);
    if (!entry) {
      return;
    }
    this.rewriteCache.delete(key);
    this.rewriteCacheBytes -= entry.body.length;
  }

  /** Refreshes the entry's LRU position on every hit (Map insertion order is the eviction order). */
  private getRewriteCacheEntry(key: string): RewriteCacheEntry | undefined {
    const entry = this.rewriteCache.get(key);
    if (!entry) {
      return undefined;
    }
    this.rewriteCache.delete(key);
    this.rewriteCache.set(key, entry);
    return entry;
  }

  private storeRewriteCacheEntry(key: string, entry: RewriteCacheEntry): void {
    if (entry.body.length > this.limits.maxRewriteCacheBytes) {
      return;
    }
    this.evictRewriteCacheEntry(key);
    this.rewriteCache.set(key, entry);
    this.rewriteCacheBytes += entry.body.length;
    for (const oldestKey of this.rewriteCache.keys()) {
      if (this.rewriteCacheBytes <= this.limits.maxRewriteCacheBytes) {
        break;
      }
      this.evictRewriteCacheEntry(oldestKey);
    }
  }

  /**
   * Pre-flight TLS trust gate, checked *before* any socket is opened to the
   * real Grafana origin (satisfies ADR-003's "refused at the proxy layer,
   * not just the tree UI layer" — the refusal happens even if no webview or
   * tree code path ever double-checked trust first).
   *
   * Deliberately does not perform a fresh TLS handshake to fetch the
   * *current* live fingerprint here — see GrafanaEmbedProxy.test.ts and the
   * final task report for why, and `forward()` below for the additional
   * live per-connection check performed once we do open a real connection.
   */
  private async isHttpsOriginTrusted(host: string, port: number): Promise<boolean> {
    const verifier = this.deps.certVerifier ?? this.defaultCertVerifier();
    const trusted = this.deps.certTrustStore.getTrusted(host, port);
    return verifier.verify(host, port, trusted?.fingerprint ?? '');
  }

  private defaultCertVerifier(): GrafanaCertVerifier {
    const store = this.deps.certTrustStore;
    return {
      verify: async (host, port, fingerprint) => (await store.check(host, port, fingerprint)) === 'trusted'
    };
  }

  private forward(
    clientRequest: http.IncomingMessage,
    clientResponse: http.ServerResponse,
    targetUrl: URL,
    realOrigin: URL,
    instanceId: string,
    token: string
  ): void {
    const isHttps = targetUrl.protocol === 'https:';
    const client: typeof http | typeof https = isHttps ? https : http;

    const outgoingHeaders: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(clientRequest.headers)) {
      const lowerKey = key.toLowerCase();
      if (value === undefined || HOP_BY_HOP_HEADERS.has(lowerKey) || lowerKey === 'authorization') {
        continue;
      }
      outgoingHeaders[key] = value;
    }
    outgoingHeaders.host = targetUrl.host;
    // Never forward a client-supplied Authorization header (it can't be
    // trusted/spoofed-in from the Webview side); always inject our own.
    outgoingHeaders.authorization = `Bearer ${token}`;
    // PERF-03: only responses this proxy will rewrite (HTML/JS/CSS — see
    // relayResponse) need to arrive as plain UTF-8 text. Everything else —
    // images, fonts, JSON API payloads — is piped through verbatim, so the
    // client's own Accept-Encoding passes upstream untouched and Grafana may
    // compress. If the heuristic under-predicts and a compressed rewritable
    // body arrives anyway, relayResponse gunzips before rewriting.
    if (isLikelyRewritableRequest(clientRequest.headers, targetUrl.pathname)) {
      outgoingHeaders['accept-encoding'] = 'identity';
    }

    // PERF-03 rewrite cache: on a GET with a retained rewrite of this exact
    // path, ask Grafana to revalidate. A 304 below replays the cached
    // rewritten body without transferring or rewriting anything; any 200
    // (new ETag — e.g. a Grafana upgrade) flows through the normal rewrite
    // path and replaces the entry.
    const method = (clientRequest.method ?? 'GET').toUpperCase();
    const rewriteCacheKey = `${instanceId}\n${targetUrl.pathname}${targetUrl.search}`;
    const cachedRewrite = method === 'GET' ? this.getRewriteCacheEntry(rewriteCacheKey) : undefined;
    if (cachedRewrite) {
      outgoingHeaders['if-none-match'] = cachedRewrite.etag;
    }

    let clientErrorHandled = false;
    const proxyRequest = client.request(
      targetUrl,
      {
        method: clientRequest.method,
        headers: outgoingHeaders,
        timeout: this.limits.upstreamTimeoutMs,
        // Manual TOFU below (attachCertVerification), matching GrafanaHttpClient.
        rejectUnauthorized: isHttps ? false : undefined
      },
      (proxyResponse) => {
        if (proxyResponse.statusCode === 401) {
          // A token Grafana rejects must not stay pinned in the credential
          // cache: the user may have just rotated it, and the next request
          // should re-read SecretStorage rather than replay the stale one.
          this.invalidateInstance(instanceId);
        }
        if (cachedRewrite && proxyResponse.statusCode === 304) {
          proxyResponse.resume();
          this.respondFromRewriteCache(clientRequest, clientResponse, cachedRewrite);
          return;
        }
        this.relayResponse(proxyResponse, clientResponse, realOrigin, instanceId, {
          method,
          rewriteCacheKey
        });
      }
    );

    proxyRequest.on('timeout', () => {
      if (clientErrorHandled) {
        return;
      }
      clientErrorHandled = true;
      this.log.error(
        `embed-proxy: upstream timed out after ${this.limits.upstreamTimeoutMs}ms for ${targetUrl.pathname} (instance ${instanceId})`
      );
      // Node reports the idle socket but does not close it, so without this
      // the connection to Grafana survives for as long as Grafana keeps it --
      // exactly the leak that lets a wedged upstream accumulate sockets.
      proxyRequest.destroy();
      if (!clientResponse.headersSent) {
        respondError(clientResponse, 504, 'The Grafana instance did not respond in time.');
      } else {
        clientResponse.destroy();
      }
    });

    proxyRequest.on('error', (error) => {
      if (clientErrorHandled) {
        return;
      }
      clientErrorHandled = true;
      this.log.error(
        `embed-proxy: upstream request to ${targetUrl.pathname} failed (instance ${instanceId}): ${formatError(error)}`
      );
      if (!clientResponse.headersSent) {
        respondError(clientResponse, 502, `Failed to reach the Grafana instance: ${formatError(error)}`);
      } else {
        clientResponse.destroy();
      }
    });

    clientResponse.on('close', () => {
      if (!clientResponse.writableEnded) {
        proxyRequest.destroy();
      }
      // Past this point the client response can no longer be written to, so a
      // late timeout or error on a socket returning to the agent pool must not
      // try to answer it.
      clientErrorHandled = true;
    });

    if (isHttps) {
      const verifier = this.deps.certVerifier ?? this.defaultCertVerifier();
      attachCertVerification(proxyRequest, targetUrl.hostname, portOf(targetUrl), verifier, {
        onVerified: () => clientRequest.pipe(proxyRequest),
        onRejected: (error) => {
          clientErrorHandled = true;
          this.log.error(
            `embed-proxy: live TLS verification failed for ${targetUrl.host} (instance ${instanceId}): ${error.message}`
          );
          proxyRequest.destroy();
          if (!clientResponse.headersSent) {
            respondError(clientResponse, 502, `Grafana TLS certificate verification failed: ${redactSensitiveText(error.message)}`);
          } else {
            clientResponse.destroy();
          }
        }
      });
    } else {
      clientRequest.pipe(proxyRequest);
    }
  }

  /**
   * Serves a cached rewritten body after the upstream confirmed (304) that
   * the ETag it was built from is still current. A client that itself sent
   * the same validator gets the 304 passed along (it holds the identical
   * rewritten body in its own cache); everyone else gets the full 200.
   */
  private respondFromRewriteCache(
    clientRequest: http.IncomingMessage,
    clientResponse: http.ServerResponse,
    entry: RewriteCacheEntry
  ): void {
    if (clientResponse.headersSent) {
      clientResponse.destroy();
      return;
    }
    const baseHeaders: http.OutgoingHttpHeaders = {
      etag: entry.etag,
      'content-security-policy': buildProxiedDocumentCsp(),
      'referrer-policy': 'same-origin'
    };
    const clientValidator = firstHeaderValue(clientRequest.headers['if-none-match']);
    if (clientValidator !== undefined && clientValidator.includes(entry.etag)) {
      clientResponse.writeHead(304, baseHeaders);
      clientResponse.end();
      return;
    }
    clientResponse.writeHead(200, {
      ...baseHeaders,
      'content-type': entry.contentType,
      'content-length': entry.body.length.toString()
    });
    clientResponse.end(entry.body);
  }

  private relayResponse(
    proxyResponse: http.IncomingMessage,
    clientResponse: http.ServerResponse,
    realOrigin: URL,
    instanceId: string,
    cacheContext: { method: string; rewriteCacheKey: string }
  ): void {
    // Both carry the token prefix so Grafana's own `<base>`/appSubUrl-relative
    // requests stay on an authorized route instead of 404ing at the gate.
    const instancePathPrefix = `${this.embedPathPrefix()}/instances/${encodeURIComponent(instanceId)}`;
    const proxyBase = `${this.origin ?? ''}${instancePathPrefix}`;

    const headersOut: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(proxyResponse.headers)) {
      const lowerKey = key.toLowerCase();
      if (value === undefined || HOP_BY_HOP_HEADERS.has(lowerKey)) {
        continue;
      }
      // Auth here is Bearer-token based (injected by this proxy), not
      // cookie based — a real Grafana session cookie scoped to the real
      // origin is meaningless (and potentially confusing/leaky) once it
      // crosses into the 127.0.0.1 proxy origin, so it is dropped entirely.
      if (lowerKey === 'set-cookie' || EMBED_BLOCKING_RESPONSE_HEADERS.has(lowerKey)) {
        continue;
      }
      headersOut[key] = value;
    }

    // Set after the copy loop above has dropped the upstream's own CSP, so
    // this is always the policy that ships -- never a passed-through one.
    headersOut['content-security-policy'] = buildProxiedDocumentCsp();
    // Load-bearing, not hardening boilerplate: `parseEmbedReferrer` is the
    // only remaining way to attribute a sub-resource request that reached the
    // proxy root, and it needs the referrer's *path* (which carries the token
    // and instance id). `same-origin` guarantees the full URL on same-origin
    // requests -- which every request from the proxied document is -- while
    // sending nothing at all if the page ever navigates elsewhere.
    headersOut['referrer-policy'] = 'same-origin';

    const location = firstHeaderValue(proxyResponse.headers.location);
    if (location) {
      headersOut.location = rewriteAbsoluteReferences(location, realOrigin, proxyBase);
    }

    const contentType = firstHeaderValue(proxyResponse.headers['content-type']);
    if (REWRITABLE_CONTENT_TYPE_PATTERN.test(contentType ?? '')) {
      const contentEncoding = (firstHeaderValue(proxyResponse.headers['content-encoding']) ?? 'identity').toLowerCase();
      let bodySource: NodeJS.ReadableStream = proxyResponse;
      if (contentEncoding === 'gzip' || contentEncoding === 'x-gzip') {
        // The likely-rewritable heuristic in forward() under-predicted (it
        // forces identity precisely so this stays rare); decompress so the
        // rewrite still sees plain text. The client always receives the
        // rewritten body uncompressed.
        delete headersOut['content-encoding'];
        bodySource = proxyResponse.pipe(zlib.createGunzip());
      } else if (contentEncoding !== 'identity') {
        // br/zstd/deflate: no decompressor wired up. Piping the compressed
        // body through unrewritten beats corrupting it with a text rewrite;
        // absolute-origin references inside it stay unrewritten, which the
        // Webview CSP then blocks rather than leaks.
        this.log.warn(
          `embed-proxy: passing through a ${contentEncoding}-encoded rewritable response unrewritten (instance ${instanceId})`
        );
        clientResponse.writeHead(proxyResponse.statusCode ?? 502, headersOut);
        proxyResponse.pipe(clientResponse);
        return;
      }
      this.relayRewritableBody(
        bodySource,
        proxyResponse,
        clientResponse,
        headersOut,
        realOrigin,
        proxyBase,
        instancePathPrefix,
        contentType ?? '',
        cacheContext
      );
      return;
    }

    clientResponse.writeHead(proxyResponse.statusCode ?? 502, headersOut);
    proxyResponse.pipe(clientResponse);
  }

  /**
   * Buffers the whole body (bounded by MAX_REWRITE_BUFFER_BYTES) so
   * rewriteAbsoluteReferences can do a single origin-string replace across
   * the full text. This is a deliberate scope limit, not an oversight: a
   * real HTML/JS parser that rewrites only genuine URL contexts would be
   * far more robust across Grafana versions, but also far more complex and
   * itself a source of bugs. See the final task report for the residual
   * fragility this trades in for.
   */
  private relayRewritableBody(
    bodySource: NodeJS.ReadableStream,
    proxyResponse: http.IncomingMessage,
    clientResponse: http.ServerResponse,
    headersOut: http.OutgoingHttpHeaders,
    realOrigin: URL,
    proxyBase: string,
    instancePathPrefix: string,
    contentType: string,
    cacheContext: { method: string; rewriteCacheKey: string }
  ): void {
    // The rewritten body's length differs from the upstream's, and if the
    // body arrived gzipped its transfer framing is meaningless once
    // decompressed — a fresh content-length is set from the rewritten buffer
    // on the way out.
    delete headersOut['content-length'];
    delete headersOut['transfer-encoding'];

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    // What this response has added to the process-wide budget, refunded on
    // the *client* response's 'close' (which fires exactly once on every
    // outcome, including a client that walked away mid-body) so the shared
    // counter cannot drift upward. Keyed to the client rather than the
    // upstream response because `bodySource` may be a gunzip stream that
    // emits buffered chunks after the upstream stream already closed;
    // flipping `aborted` here makes those late chunks charge-free no-ops.
    let charged = 0;
    clientResponse.on('close', () => {
      this.rewriteBufferBytesInFlight -= charged;
      charged = 0;
      aborted = true;
    });

    bodySource.on('data', (chunk: Buffer | string) => {
      if (aborted) {
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      charged += buf.length;
      this.rewriteBufferBytesInFlight += buf.length;
      if (size > this.limits.maxRewriteBufferBytes || this.rewriteBufferBytesInFlight > this.limits.maxTotalRewriteBufferBytes) {
        aborted = true;
        chunks.length = 0;
        this.log.warn(
          `embed-proxy: abandoned a rewritable response after ${size} bytes ` +
            `(per-response cap ${this.limits.maxRewriteBufferBytes}, process-wide in flight ${this.rewriteBufferBytesInFlight}/${this.limits.maxTotalRewriteBufferBytes})`
        );
        proxyResponse.destroy();
        if (!clientResponse.headersSent) {
          respondError(clientResponse, 502, 'Grafana response was too large to rewrite.');
        } else {
          clientResponse.destroy();
        }
        return;
      }
      chunks.push(buf);
    });

    bodySource.on('end', () => {
      if (aborted) {
        return;
      }
      let body = rewriteAbsoluteReferences(Buffer.concat(chunks).toString('utf8'), realOrigin, proxyBase);
      if (/^text\/html\b/i.test(contentType)) {
        body = injectGrafanaEmbedShim(body, proxyBase, instancePathPrefix);
      }
      const rewritten = Buffer.from(body, 'utf8');
      const statusCode = proxyResponse.statusCode ?? 502;

      // Only a complete, successful GET is worth retaining, and only when the
      // upstream supplied an ETag to revalidate it with later — an entry that
      // can never produce a 304 would be dead weight. Error responses are
      // deliberately never cached.
      const etag = firstHeaderValue(proxyResponse.headers.etag);
      if (cacheContext.method === 'GET' && statusCode === 200 && etag) {
        this.storeRewriteCacheEntry(cacheContext.rewriteCacheKey, {
          etag,
          body: rewritten,
          contentType
        });
      }

      headersOut['content-length'] = rewritten.length.toString();
      clientResponse.writeHead(statusCode, headersOut);
      clientResponse.end(rewritten);
    });

    bodySource.on('error', (error: Error) => {
      if (aborted) {
        return;
      }
      aborted = true;
      this.log.error(`embed-proxy: upstream response stream failed mid-body: ${formatError(error)}`);
      if (!clientResponse.headersSent) {
        respondError(clientResponse, 502, 'Grafana upstream response error.');
      } else {
        clientResponse.destroy();
      }
    });

    if (bodySource !== proxyResponse) {
      // pipe() does not propagate errors: a failure on the raw upstream
      // stream (e.g. connection reset mid-gzip-body) must still answer the
      // client instead of leaving the gunzip stream waiting forever.
      proxyResponse.on('error', (error) => {
        if (aborted) {
          return;
        }
        aborted = true;
        this.log.error(`embed-proxy: upstream response stream failed mid-body: ${formatError(error)}`);
        if (!clientResponse.headersSent) {
          respondError(clientResponse, 502, 'Grafana upstream response error.');
        } else {
          clientResponse.destroy();
        }
      });
    }
  }
}

/**
 * CSP for the **proxied Grafana document itself** — the thing inside the
 * iframe. Not to be confused with `buildRecommendedCsp` below, which protects
 * the parent Webview document; CSP is per-document, so that one's `frame-src`
 * only decides *which* iframe may load, and says nothing about what the
 * document inside it may then do.
 *
 * This has to exist because `EMBED_BLOCKING_RESPONSE_HEADERS` deletes
 * Grafana's own CSP (it would otherwise refuse to be framed). Deleting it and
 * sending nothing back left the Grafana page running with no CSP at all,
 * which matters concretely: Grafana's Text panel supports raw HTML, so an
 * imported third-party dashboard JSON is a realistic way to get a script into
 * this document.
 *
 * `script-src` keeps `'unsafe-inline'`/`'unsafe-eval'` (as Grafana's own
 * default CSP template does) because Grafana boots from an inline script, we
 * inject another one for `appSubUrl`, and plugins eval. Constraining script
 * execution is therefore not on the table; what this policy actually buys is
 * the *egress* and *navigation* half -- `connect-src 'self'` stops an injected
 * script from beaconing anything out to an attacker-controlled origin (which
 * also cuts Grafana's own direct calls to grafana.com), `form-action 'self'`
 * stops it POSTing the page elsewhere, and `object-src 'none'` plus
 * `base-uri 'self'` close two classic rewrite tricks.
 *
 * `frame-ancestors` replaces the stripped `x-frame-options` and must admit the
 * VS Code Webview host document, or the panel renders blank.
 */
export function buildProxiedDocumentCsp(): string {
  return (
    "default-src 'self'; " +
    "base-uri 'self'; " +
    "object-src 'none'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; " +
    "font-src 'self' data:; " +
    "media-src 'self' data: blob:; " +
    "worker-src 'self' blob:; " +
    "connect-src 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors 'self' vscode-webview: vscode-file:;"
  );
}

/**
 * Recommended Webview CSP for Task 4.2/4.3, restricted entirely to this
 * proxy's own origin (ADR-003's last bullet) — pass `proxy.origin` once
 * `start()` has resolved. This governs the **parent** Webview document; see
 * `buildProxiedDocumentCsp` above for the one that governs the Grafana page
 * inside the iframe.
 */
export function buildRecommendedCsp(proxyOrigin: string): string {
  return (
    "default-src 'none'; " +
    `frame-src ${proxyOrigin}; ` +
    `img-src ${proxyOrigin} data:; ` +
    `style-src ${proxyOrigin} 'unsafe-inline'; ` +
    `script-src ${proxyOrigin}; ` +
    `font-src ${proxyOrigin} data:; ` +
    `connect-src ${proxyOrigin};`
  );
}

export interface ParsedInstancePath {
  instanceId: string;
  remainingPath: string;
  search: string;
}

const GRAFANA_NATIVE_PATH_PREFIXES = [
  '/d/',
  '/api/',
  '/public/',
  '/avatar/',
  '/alerting/',
  '/login',
  '/logout',
  '/explore',
  '/dashboards',
  '/plugins/',
  '/favicon.ico'
];

/**
 * Splits `/e/:embedToken/...` into the presented token and the request target
 * the rest of the routing sees. Returns undefined for any URL without a token
 * segment (including an unparseable one) — the caller treats "no token here"
 * and "malformed" identically, since both end at the same bare 404.
 */
export function splitEmbedTokenPath(rawUrl: string): { token: string; target: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, 'http://proxy-internal.invalid');
  } catch {
    return undefined;
  }

  const match = EMBED_TOKEN_PATH_PATTERN.exec(parsed.pathname);
  if (!match) {
    return undefined;
  }

  let token: string;
  try {
    token = decodeURIComponent(match[1] ?? '');
  } catch {
    return undefined;
  }

  const rest = match[2] && match[2].length > 0 ? match[2] : '/';
  return { token, target: `${rest}${parsed.search}` };
}

/**
 * Parses `/instances/:instanceId/...` safely: the instanceId segment can
 * never contain a literal or percent-encoded `/` (the regex only matches up
 * to the next literal slash), and the decoded id is further restricted to
 * `SAFE_INSTANCE_ID_PATTERN`, which rules out `..` traversal, `@`/`:`
 * userinfo-style tricks, and any other non-UUID-shaped input outright.
 */
export function parseInstancePath(rawUrl: string): ParsedInstancePath | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, 'http://proxy-internal.invalid');
  } catch {
    return undefined;
  }

  const match = INSTANCE_PATH_PATTERN.exec(parsed.pathname);
  if (!match) {
    return undefined;
  }

  let instanceId: string;
  try {
    instanceId = decodeURIComponent(match[1] ?? '');
  } catch {
    return undefined;
  }
  if (!SAFE_INSTANCE_ID_PATTERN.test(instanceId)) {
    return undefined;
  }

  const remainingPath = match[2] && match[2].length > 0 ? match[2] : '/';
  return { instanceId, remainingPath, search: parsed.search };
}

/**
 * Resolves either an explicit `/instances/:instanceId/...` route or a native
 * Grafana path (`/d/...`, `/api/...`, etc.) attributed to the instance whose
 * document issued it (`fallbackInstanceId`, from `parseEmbedReferrer`).
 */
export function parseProxyRoute(rawUrl: string, fallbackInstanceId?: string): ParsedInstancePath | undefined {
  const explicit = parseInstancePath(rawUrl);
  if (explicit) {
    return explicit;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl, 'http://proxy-internal.invalid');
  } catch {
    return undefined;
  }

  if (!fallbackInstanceId || !SAFE_INSTANCE_ID_PATTERN.test(fallbackInstanceId) || !isGrafanaNativePath(parsed.pathname)) {
    return undefined;
  }

  return {
    instanceId: fallbackInstanceId,
    remainingPath: parsed.pathname,
    search: parsed.search
  };
}

export function isGrafanaNativePath(pathname: string): boolean {
  if (pathname === '/' || pathname === '') {
    return true;
  }
  return GRAFANA_NATIVE_PATH_PREFIXES.some((prefix) => {
    if (prefix.endsWith('/')) {
      return pathname.startsWith(prefix);
    }
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  });
}

/**
 * Recovers the token and instance id from the URL of the document that issued
 * a request, for the sub-resource requests that reach the proxy root with
 * neither in their own path.
 *
 * ## Why not a cookie
 *
 * This used to be two `Path=/` cookies (`atGrafanaEmbedInstance` /
 * `atGrafanaEmbedToken`). A cookie is *ambient*: one slot per origin, shared
 * by every instance framed against this proxy. With two dashboards open, the
 * one that loaded last owned the slot, so the other one's bare `/api/...`
 * requests were routed to the wrong instance **and signed with that
 * instance's Service Account Token** -- instance A's panel driving instance B
 * under B's credentials. Scoping the cookie to `Path=/instances/<id>` cannot
 * fix that: a cookie path only matches request paths beneath it, so it would
 * never be sent on the root-relative requests that are the entire reason the
 * fallback exists.
 *
 * The referrer is per-request and names the exact document that made the
 * call, so N instances stay attributed independently no matter how many are
 * open. It is also strictly tighter than the cookie was: `SameSite=Lax` still
 * attached the old cookie to a top-level GET navigation started by an
 * unrelated page, whereas such a navigation carries that page's own referrer
 * (or none) and lands on the bare 404. Scripts cannot forge it either --
 * `Referer` is a forbidden header name, so page JS cannot set it.
 *
 * The same-origin check is what makes the token meaningful: only a document
 * this proxy itself served has our origin *and* our token in its URL.
 */
export function parseEmbedReferrer(
  referer: string | undefined,
  proxyOrigin: string | undefined
): { token: string; instanceId: string } | undefined {
  if (!referer || !proxyOrigin) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(referer);
  } catch {
    return undefined;
  }
  if (parsed.origin !== proxyOrigin) {
    return undefined;
  }

  const tokenRoute = splitEmbedTokenPath(`${parsed.pathname}${parsed.search}`);
  if (!tokenRoute) {
    return undefined;
  }
  const instancePath = parseInstancePath(tokenRoute.target);
  if (!instancePath) {
    return undefined;
  }
  return { token: tokenRoute.token, instanceId: instancePath.instanceId };
}

/**
 * Host allowlist: builds the outgoing request URL by grafting the sanitized
 * remaining path onto the instance's own configured origin, never by
 * re-parsing a path string as a fresh (potentially protocol-relative) URL.
 * Setting `.pathname`/`.search` on an existing URL instance (rather than
 * `new URL(remainingPath, origin)`) is what prevents a path segment like
 * `//evil.example.com/x` from being reinterpreted as a network-path
 * reference that would hijack the host — verified empirically (Node's URL
 * pathname setter keeps a leading `//` as a literal path, not authority).
 * The explicit host/protocol equality assertion below is a defense-in-depth
 * belt-and-braces check on top of that, not the primary mechanism.
 */
export function buildTargetUrl(origin: URL, remainingPath: string, search: string): URL {
  const target = new URL(origin.toString());
  target.pathname = remainingPath;
  target.search = search;
  if (target.protocol !== origin.protocol || target.host !== origin.host) {
    throw new Error('Resolved proxy target escaped the configured instance origin.');
  }
  return target;
}

/** File extensions whose responses carry the rewritable content types (HTML/JS/CSS). */
const REWRITABLE_PATH_EXTENSION_PATTERN = /\.(?:m?js|css|html?)$/i;

/**
 * Grafana SPA document routes: the paths whose responses are the HTML shell
 * that `injectGrafanaEmbedShim` must rewrite. Kept in sync with the routes
 * the proxy's own URL builders mint (`/d/...`, `/alerting/.../view`) plus the
 * root/dashboards landing pages Grafana may redirect between.
 */
const REWRITABLE_DOCUMENT_PATH_PATTERN = /^\/(?:$|d\/|alerting(?:\/|$)|dashboards(?:\/|$)|explore(?:\/|$))/;

/**
 * PERF-03: whether a request is likely to produce a response the proxy will
 * rewrite (HTML document, JS bundle, CSS). Only these force
 * `Accept-Encoding: identity` upstream — everything else (images, fonts,
 * JSON API traffic, which dominate a dashboard's request count) keeps the
 * client's own header so Grafana may compress, since those responses are
 * piped through verbatim anyway.
 *
 * Deliberately over-inclusive on the signals a real Webview sends
 * (`Accept: text/html`, `Sec-Fetch-Dest`): a false positive merely costs one
 * uncompressed transfer, while a false negative would hand the rewrite step
 * a compressed body — recoverable (relayResponse gunzips gzip), but the
 * slow path.
 */
export function isLikelyRewritableRequest(headers: http.IncomingHttpHeaders, pathname: string): boolean {
  const accept = firstHeaderValue(headers.accept) ?? '';
  if (/\btext\/(?:html|css)\b/i.test(accept)) {
    return true;
  }
  const fetchDest = firstHeaderValue(headers['sec-fetch-dest']) ?? '';
  if (/^(?:document|iframe|frame|script|style)$/i.test(fetchDest)) {
    return true;
  }
  if (REWRITABLE_PATH_EXTENSION_PATTERN.test(pathname)) {
    return true;
  }
  return REWRITABLE_DOCUMENT_PATH_PATTERN.test(pathname);
}

/**
 * Makes Grafana's frontend treat the proxy's `/instances/:id` prefix as its
 * real `appSubUrl` (the same mechanism Grafana uses when served under a
 * reverse-proxy subpath). That way SPA routes (`/d/...`) AND plugin module
 * loads (`/public/plugins/loki/module.js`) both stay under the instance
 * prefix — stripping the prefix via `history.replaceState` breaks plugin
 * loading (SystemJS resolves modules against the rewritten URL / empty
 * appSubUrl and ends up requesting `/public/plugins/...` off the proxy root,
 * or relative to `/d/:uid/...`, which yields "Could not load plugin").
 */
export function injectGrafanaEmbedShim(html: string, proxyBase: string, instancePathPrefix: string): string {
  const withAppSubUrl = rewriteGrafanaAppSubUrl(html, instancePathPrefix);
  const baseTag = `<base href="${escapeHtml(proxyBase)}/">`;
  // Defensive runtime patch: Grafana writes grafanaBootData in an inline
  // script later in the document; overwrite appSubUrl again right before the
  // main bundles execute if the static rewrite missed a variant of the key.
  const prefixJson = JSON.stringify(instancePathPrefix);
  const bootPatch =
    `<script>(function(){var p=${prefixJson};` +
    `function apply(){var d=window.grafanaBootData;if(d&&d.settings){d.settings.appSubUrl=p;` +
    `if(typeof d.settings.appUrl==="string"){try{var u=new URL(d.settings.appUrl);` +
    `d.settings.appUrl=u.origin+p+(p.endsWith("/")?"":"/");}catch(e){}}}}` +
    `apply();document.addEventListener("DOMContentLoaded",apply);})();</script>`;
  const headInjection = `${baseTag}${bootPatch}`;
  const withoutExistingBase = withAppSubUrl.replace(/<base\b[^>]*>/gi, '');
  if (/<head[\s>]/i.test(withoutExistingBase)) {
    return withoutExistingBase.replace(/<head(\s[^>]*)?>/i, `$&${headInjection}`);
  }
  if (/<html[\s>]/i.test(withoutExistingBase)) {
    return withoutExistingBase.replace(/<html(\s[^>]*)?>/i, `$&<head>${headInjection}</head>`);
  }
  return `${headInjection}${withoutExistingBase}`;
}

/** Rewrites `"appSubUrl":"..."` inside Grafana's inline boot JSON to the proxy instance prefix. */
export function rewriteGrafanaAppSubUrl(html: string, instancePathPrefix: string): string {
  return html.replace(
    /("appSubUrl"\s*:\s*)("(?:\\.|[^"\\])*")/g,
    `$1${JSON.stringify(instancePathPrefix)}`
  );
}

/** @deprecated Use injectGrafanaEmbedShim — kept as an alias for tests. */
export function injectProxyBaseTag(html: string, proxyBase: string): string {
  const instancePathPrefix = new URL(`${proxyBase}/`).pathname.replace(/\/$/, '');
  return injectGrafanaEmbedShim(html, proxyBase, instancePathPrefix);
}

export function rewriteAbsoluteReferences(text: string, realOrigin: URL, proxyBase: string): string {
  const hostPort = realOrigin.host;
  const httpsForm = `https://${hostPort}`;
  const httpForm = `http://${hostPort}`;
  const protocolRelativeForm = `//${hostPort}`;

  // Longest/most-specific forms first so a subsequent protocol-relative pass
  // doesn't double-process what an absolute-form pass already replaced.
  let result = splitJoin(text, httpsForm, proxyBase);
  result = splitJoin(result, httpForm, proxyBase);
  result = splitJoin(result, protocolRelativeForm, proxyBase);
  return result;
}

function splitJoin(text: string, search: string, replacement: string): string {
  return search.length === 0 ? text : text.split(search).join(replacement);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The path of a request URL, without its query string. Log lines about
 * rejected requests use this rather than `request.url`, since a rejected
 * request is by definition attacker-influenced and its query string is not
 * something worth copying into a file the user may paste into an issue.
 * (`redactSensitiveText` would strip a recognized token from either form;
 * this keeps unrecognized junk out too.)
 */
function pathOnly(rawUrl: string): string {
  const queryStart = rawUrl.indexOf('?');
  return queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
}

function portOf(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }
  return url.protocol === 'https:' ? 443 : 80;
}

/**
 * The response for every failed admission check. Deliberately says nothing:
 * no product name, no "proxy", nothing that would tell someone sweeping
 * loopback ports that they found the AT Grafana embed proxy and that
 * continuing to guess is worthwhile. `respondError` below is for callers that
 * already got past the gate.
 */
function respondNotFound(response: http.ServerResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from('Not Found', 'utf8');
  response.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length.toString()
  });
  response.end(body);
}

/**
 * Load shedding, not an error: the caller already passed the admission gate,
 * so this says "come back in a moment" with a `Retry-After` the Webview and
 * Grafana's own fetch retries can act on, rather than surfacing as a failure
 * the user has to reason about.
 */
function respondServiceUnavailable(response: http.ServerResponse): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from('AT Grafana proxy is busy; retry shortly.', 'utf8');
  response.writeHead(503, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length.toString(),
    'retry-after': '1'
  });
  response.end(body);
}

function respondError(response: http.ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const safeMessage = escapeHtml(redactSensitiveText(message));
  const body = Buffer.from(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>AT Grafana Proxy</title></head>` +
      `<body><h1>AT Grafana proxy error (${status})</h1><p>${safeMessage}</p></body></html>`,
    'utf8'
  );
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length.toString()
  });
  response.end(body);
}

function escapeHtml(text: string): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return text.replace(/[&<>"']/g, (char) => entities[char] ?? char);
}
