import * as http from 'node:http';
import * as https from 'node:https';
import type { Socket } from 'node:net';
import { createBridgeToken, timingSafeEqualToken } from '@at-series/mcp-hub';
import type { GrafanaInstanceConfigManager } from '../config/GrafanaInstanceConfigManager';
import type { GrafanaCertTrustStore } from '../grafana/GrafanaCertTrustStore';
import { attachCertVerification, type GrafanaCertVerifier } from '../grafana/GrafanaHttpClient';
import { formatError } from '../utils/errors';
import { redactSensitiveText } from '../utils/redaction';

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
}

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

/** Rewritable content types get buffered whole-body for the origin-string replace (see rewriteAbsoluteReferences). Cap protects memory if Grafana ever serves something unexpectedly huge under one of these content types. */
const MAX_REWRITE_BUFFER_BYTES = 25 * 1024 * 1024;

const REWRITABLE_CONTENT_TYPE_PATTERN = /^(text\/html|application\/javascript|text\/javascript|application\/x-javascript|text\/css)\b/i;

const INSTANCE_PATH_PATTERN = /^\/instances\/([^/]+)(\/.*)?$/;

/** Kept short so it costs little in every rewritten Grafana asset URL. */
const EMBED_TOKEN_PATH_SEGMENT = 'e';

const EMBED_TOKEN_PATH_PATTERN = /^\/e\/([^/]+)(\/.*)?$/;

/** Instance ids are `randomUUID()` outputs; anything else is rejected outright rather than risk-assessed, which also forecloses `..`/`@`/`%`-based smuggling through the instanceId segment. */
const SAFE_INSTANCE_ID_PATTERN = /^[a-zA-Z0-9-]+$/;

export class GrafanaEmbedProxy {
  private server: http.Server | undefined;
  private port: number | undefined;
  private embedToken: string | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly deps: GrafanaEmbedProxyDependencies) {}

  get origin(): string | undefined {
    return this.port === undefined ? undefined : `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.embedToken = createBridgeToken();
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
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
  }

  async dispose(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.embedToken = undefined;
    if (!server) {
      return;
    }
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
      // Cookie fallback exists for the same reason the instance cookie does:
      // some Grafana sub-resource requests escape the appSubUrl/base rewrite
      // and arrive at the proxy root. The cookie is only ever handed out on a
      // response to an already-authorized request, so it grants nothing to a
      // caller that never had the token.
      const presentedToken = tokenRoute?.token ?? parseEmbedTokenCookie(request.headers.cookie);
      if (!this.isAuthorized(request, presentedToken)) {
        respondNotFound(response);
        return;
      }

      const parsedPath = parseProxyRoute(tokenRoute?.target ?? rawUrl, parseInstanceCookie(request.headers.cookie));
      if (!parsedPath) {
        respondError(response, 404, 'Unknown AT Grafana proxy route.');
        return;
      }

      const instance = await this.deps.configManager.getInstance(parsedPath.instanceId);
      if (!instance) {
        respondError(response, 404, `Unknown Grafana instance: ${parsedPath.instanceId}.`);
        return;
      }

      const token = await this.deps.configManager.getToken(instance.id);
      if (!token) {
        respondError(response, 502, 'No Service Account Token is configured for this Grafana instance.');
        return;
      }

      let realOrigin: URL;
      try {
        realOrigin = new URL(instance.url);
      } catch {
        respondError(response, 502, 'This Grafana instance has an invalid configured URL.');
        return;
      }

      if (realOrigin.protocol === 'https:') {
        const trusted = await this.isHttpsOriginTrusted(realOrigin.hostname, portOf(realOrigin));
        if (!trusted) {
          respondError(
            response,
            502,
            "This Grafana instance's TLS certificate is not trusted. Confirm the certificate fingerprint " +
              '(Trust-On-First-Use) before opening this view.'
          );
          return;
        }
      } else if (realOrigin.protocol !== 'http:') {
        respondError(response, 502, 'This Grafana instance has an unsupported URL scheme.');
        return;
      }

      let targetUrl: URL;
      try {
        targetUrl = buildTargetUrl(realOrigin, parsedPath.remainingPath, parsedPath.search);
      } catch {
        respondError(response, 400, 'Invalid proxy request path.');
        return;
      }

      this.forward(request, response, targetUrl, realOrigin, instance.id, token, parsedPath.viaCookie);
    } catch (error) {
      if (!response.headersSent) {
        respondError(response, 502, `AT Grafana proxy error: ${formatError(error)}`);
      } else {
        response.destroy();
      }
    }
  }

  /**
   * The whole admission gate, evaluated before anything else looks at the
   * request. See the class doc's "Authorization" section for the threat this
   * closes; the short version is that reaching this proxy is equivalent to
   * holding the instance's Service Account Token, so knowing the instanceId
   * (which any local process can read out of `state.vscdb`) must not be
   * sufficient.
   */
  private isAuthorized(request: http.IncomingMessage, presentedToken: string | undefined): boolean {
    const expected = this.embedToken;
    if (expected === undefined || presentedToken === undefined || !timingSafeEqualToken(presentedToken, expected)) {
      return false;
    }
    // Compared against the literal loopback authority rather than "some
    // hostname that resolves to 127.0.0.1", which is exactly the difference
    // that makes DNS rebinding fail here.
    if (request.headers.host !== `127.0.0.1:${this.port ?? ''}`) {
      return false;
    }
    const origin = request.headers.origin;
    return origin === undefined || origin === this.origin;
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
    token: string,
    viaCookie = false
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
    // Force uncompressed responses so the HTML/JS/CSS rewrite step (see
    // relayResponse) can safely treat the response body as UTF-8 text
    // without first implementing gzip/br decompression.
    outgoingHeaders['accept-encoding'] = 'identity';

    let clientErrorHandled = false;
    const proxyRequest = client.request(
      targetUrl,
      {
        method: clientRequest.method,
        headers: outgoingHeaders,
        // Manual TOFU below (attachCertVerification), matching GrafanaHttpClient.
        rejectUnauthorized: isHttps ? false : undefined
      },
      (proxyResponse) => {
        this.relayResponse(proxyResponse, clientResponse, realOrigin, instanceId, viaCookie);
      }
    );

    proxyRequest.on('error', (error) => {
      if (clientErrorHandled) {
        return;
      }
      clientErrorHandled = true;
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
    });

    if (isHttps) {
      const verifier = this.deps.certVerifier ?? this.defaultCertVerifier();
      attachCertVerification(proxyRequest, targetUrl.hostname, portOf(targetUrl), verifier, {
        onVerified: () => clientRequest.pipe(proxyRequest),
        onRejected: (error) => {
          clientErrorHandled = true;
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

  private relayResponse(
    proxyResponse: http.IncomingMessage,
    clientResponse: http.ServerResponse,
    realOrigin: URL,
    instanceId: string,
    viaCookie: boolean
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

    const location = firstHeaderValue(proxyResponse.headers.location);
    if (location) {
      headersOut.location = rewriteAbsoluteReferences(location, realOrigin, proxyBase);
    }

    const contentType = firstHeaderValue(proxyResponse.headers['content-type']);
    if (!viaCookie) {
      headersOut['set-cookie'] = [buildInstanceEmbedCookie(instanceId), buildEmbedTokenCookie(this.embedToken ?? '')];
    }
    if (REWRITABLE_CONTENT_TYPE_PATTERN.test(contentType ?? '')) {
      this.relayRewritableBody(
        proxyResponse,
        clientResponse,
        headersOut,
        realOrigin,
        proxyBase,
        instancePathPrefix,
        contentType ?? ''
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
    proxyResponse: http.IncomingMessage,
    clientResponse: http.ServerResponse,
    headersOut: http.OutgoingHttpHeaders,
    realOrigin: URL,
    proxyBase: string,
    instancePathPrefix: string,
    contentType: string
  ): void {
    delete headersOut['content-length'];
    delete headersOut['transfer-encoding'];

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    proxyResponse.on('data', (chunk: Buffer | string) => {
      if (aborted) {
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_REWRITE_BUFFER_BYTES) {
        aborted = true;
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

    proxyResponse.on('end', () => {
      if (aborted) {
        return;
      }
      let body = rewriteAbsoluteReferences(Buffer.concat(chunks).toString('utf8'), realOrigin, proxyBase);
      if (/^text\/html\b/i.test(contentType)) {
        body = injectGrafanaEmbedShim(body, proxyBase, instancePathPrefix);
      }
      const rewritten = Buffer.from(body, 'utf8');
      headersOut['content-length'] = rewritten.length.toString();
      clientResponse.writeHead(proxyResponse.statusCode ?? 502, headersOut);
      clientResponse.end(rewritten);
    });

    proxyResponse.on('error', () => {
      if (aborted) {
        return;
      }
      if (!clientResponse.headersSent) {
        respondError(clientResponse, 502, 'Grafana upstream response error.');
      } else {
        clientResponse.destroy();
      }
    });
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
  /** True when the route was resolved from the embed cookie rather than `/instances/:id/...`. */
  viaCookie?: boolean;
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

const EMBED_INSTANCE_COOKIE = 'atGrafanaEmbedInstance';
const EMBED_TOKEN_COOKIE = 'atGrafanaEmbedToken';

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
 * Grafana path (`/d/...`, `/api/...`, etc.) paired with the embed cookie set
 * on the first instance-scoped HTML response.
 */
export function parseProxyRoute(rawUrl: string, instanceCookie?: string): ParsedInstancePath | undefined {
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

  if (!instanceCookie || !SAFE_INSTANCE_ID_PATTERN.test(instanceCookie) || !isGrafanaNativePath(parsed.pathname)) {
    return undefined;
  }

  return {
    instanceId: instanceCookie,
    remainingPath: parsed.pathname,
    search: parsed.search,
    viaCookie: true
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

export function parseInstanceCookie(cookieHeader: string | undefined): string | undefined {
  const instanceId = readCookie(cookieHeader, EMBED_INSTANCE_COOKIE);
  return instanceId !== undefined && SAFE_INSTANCE_ID_PATTERN.test(instanceId) ? instanceId : undefined;
}

/** Unvalidated on purpose: the only meaningful check on a token is the constant-time comparison in `isAuthorized`. */
export function parseEmbedTokenCookie(cookieHeader: string | undefined): string | undefined {
  return readCookie(cookieHeader, EMBED_TOKEN_COOKIE);
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(cookieHeader);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

function buildInstanceEmbedCookie(instanceId: string): string {
  return `${EMBED_INSTANCE_COOKIE}=${encodeURIComponent(instanceId)}; Path=/; HttpOnly; SameSite=Lax`;
}

/** Same attributes as the instance cookie: HttpOnly keeps it out of reach of any script the proxied page runs. */
function buildEmbedTokenCookie(token: string): string {
  return `${EMBED_TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
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
