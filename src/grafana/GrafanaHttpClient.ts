import * as http from 'node:http';
import * as https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { asRedactedLog, type AtGrafanaLog } from '../utils/logger';
import { isTlsConnectionError } from './testGrafanaConnection';

/**
 * `validation` is a deliberate addition beyond the kinds sketched in the
 * Task 2.1 brief (`network`/`tls`/`auth`/`api-error`/`invalid-response`):
 * it exists specifically for `proxyDatasourceRequest`'s method allowlist
 * guard (ADR-004 MON4), which is a client-side request-shape rejection that
 * happens *before* any network call, not a response-classification concern
 * like the other four kinds. See GrafanaDatasourcesApi.ts.
 *
 * `response-too-large` is Task 6.1's addition for the `maxResponseBytes`
 * early-abort (see `GrafanaRequestOptions.maxResponseBytes` below): thrown
 * when the response stream is deliberately destroyed mid-read because it
 * already exceeded the caller's byte cap. Callers that pass
 * `maxResponseBytes` and want a graceful truncation result (rather than a
 * hard failure) must catch this kind explicitly -- see
 * src/grafana/QueryLimits.ts.
 */
export type GrafanaApiErrorKind =
  | 'network'
  | 'tls'
  | 'auth'
  | 'api-error'
  | 'invalid-response'
  | 'validation'
  | 'response-too-large';

export class GrafanaApiError extends Error {
  constructor(
    public readonly kind: GrafanaApiErrorKind,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'GrafanaApiError';
  }
}

/**
 * Decoupled TOFU verifier interface (no vscode dependency), mirroring the
 * pattern behind GrafanaCertTrustStore. The implementation that actually
 * prompts the user and consults GrafanaCertTrustStore belongs to a later
 * extension-wiring phase, not this file — see Task 2.1 in the plan.
 */
export interface GrafanaCertVerifier {
  verify(host: string, port: number, fingerprint256: string): Promise<boolean>;
}

export interface GrafanaHttpClientOptions {
  baseUrl: string;
  token: string;
  certVerifier?: GrafanaCertVerifier;
  timeoutMs?: number;
  /**
   * Delay before each retry, and by its length the number of retries. See
   * `DEFAULT_RETRY_BACKOFF_MS`. Overridable for the same reason `timeoutMs`
   * is: so a test can assert the policy without sleeping through it.
   */
  retryBackoffMs?: readonly number[];
  /**
   * Diagnostics only. A failed Grafana call currently surfaces as one line of
   * red text in a tree node; the classified kind and status are what actually
   * separate "your token expired" from "your TLS is untrusted" from "Grafana
   * is down," so they go to the channel at `debug`.
   */
  log?: AtGrafanaLog;
}

export interface GrafanaRequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  /**
   * Task 6.1 (query-limits enforcement, requirements §5.2): when set, the
   * response stream is aborted as soon as the buffered byte count exceeds
   * this value, instead of buffering a potentially huge upstream response
   * fully before discovering it's oversized (see `performRequest`). Throws
   * a `GrafanaApiError` with `kind: 'response-too-large'`. Omitted (the
   * default) preserves the previous unbounded-buffering behavior exactly,
   * so every existing call site that doesn't opt in is unaffected.
   */
  maxResponseBytes?: number;
  /**
   * Opt out of the automatic retry that idempotent requests otherwise get.
   *
   * There is exactly one caller that must: `proxyDatasourceRequest`, the only
   * path metered by `QueryRateLimiter`. See `RETRIABLE_METHODS` for why.
   */
  retry?: boolean;
}

export const GRAFANA_CLIENT_USER_AGENT = 'AT-Grafana/1.0';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Two retries at 200ms then 600ms, i.e. three attempts and at most 800ms of
 * added latency before a request is declared failed. Short enough that a
 * genuinely dead Grafana still surfaces in the tree quickly, long enough to
 * ride out the restart of a single Grafana replica behind a load balancer.
 *
 * Timeouts are classified `network` and therefore retried too, so a
 * hard-hung Grafana costs three `timeoutMs` waits rather than one. That is
 * the deliberate price of not failing the tree on one slow response.
 */
export const DEFAULT_RETRY_BACKOFF_MS: readonly number[] = [200, 600];

/**
 * Methods safe to repeat. Retrying is only sound when a request that may
 * already have been executed can be executed again without a second effect,
 * so the non-idempotent half of the datasource proxy allowlist (POST) is
 * excluded even when it fails in a way that looks transient.
 */
const RETRIABLE_METHODS = new Set(['GET', 'HEAD']);

/**
 * Module-level keep-alive pool shared by every GrafanaHttpClient (PERF-01).
 * Clients are constructed per call site (each `new GrafanaApiClient` builds a
 * fresh one), so a per-client agent could never reuse a connection across
 * calls; only a module-level agent actually pools TCP+TLS across tree
 * refreshes, MCP calls, and (via `getSharedGrafanaHttpsAgent`) the embed
 * proxy.
 *
 * One agent safely serves both trust modes: `https.Agent#getName` includes
 * `rejectUnauthorized` in the connection-pool key, so sockets opened for the
 * TOFU path (`rejectUnauthorized: false`, fingerprint checked by the
 * certVerifier) are never handed to strict requests, and vice versa.
 *
 * `maxSockets` bounds concurrent connections per origin; 8 comfortably covers
 * a tree refresh fan-out without letting the embed proxy's per-asset requests
 * open an unbounded socket pile against one Grafana.
 */
const sharedGrafanaHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

/**
 * Exported for GrafanaEmbedProxy (Task 4.1), which issues raw `https.request`
 * calls outside this client but must share the same connection pool rather
 * than growing its own per-asset sockets.
 */
export function getSharedGrafanaHttpsAgent(): https.Agent {
  return sharedGrafanaHttpsAgent;
}

/**
 * Whether repeating this failure could plausibly produce a different answer.
 *
 * `network` covers connection failures and timeouts; a 5xx is the server
 * saying it failed rather than that the request was wrong. Everything else is
 * excluded on purpose: 4xx and `auth` are verdicts about the request that a
 * second identical request cannot change, `invalid-response` and
 * `response-too-large` are deterministic properties of the body, and a `tls`
 * rejection means a fingerprint the user has not trusted -- repeating it just
 * fails again.
 */
function isRetriableFailure(error: unknown): error is GrafanaApiError {
  if (!(error instanceof GrafanaApiError)) {
    return false;
  }
  if (error.kind === 'network') {
    return true;
  }
  return error.kind === 'api-error' && error.status !== undefined && error.status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The classification only -- never the query string, which carries PromQL/LogQL and sometimes a token. */
function describeFailure(error: GrafanaApiError): string {
  return error.status === undefined ? `kind=${error.kind}` : `kind=${error.kind}, status=${error.status}`;
}

/**
 * Thin wrapper around node:http/node:https carrying the trickiest, most
 * security-sensitive logic in this client. When no certVerifier is supplied
 * this behaves exactly like a normal https client (Node's default chain
 * validation applies, matching testGrafanaConnection). When a certVerifier
 * IS supplied, Node's own chain validation is disabled
 * (`rejectUnauthorized: false`) and trust is delegated entirely to the
 * verifier's fingerprint check — this mirrors the SSH-host-key-style TOFU
 * model (a known-fingerprint check, not "is this a publicly trusted CA")
 * used elsewhere in this codebase (GrafanaCertTrustStore), rather than
 * layering both checks, which would make self-signed/private-CA instances
 * impossible to trust at all.
 *
 * Never logs or interpolates `options.token` into any thrown error message.
 */
export class GrafanaHttpClient {
  private readonly baseUrl: string;
  private readonly log: AtGrafanaLog;

  constructor(private readonly options: GrafanaHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.log = asRedactedLog(options.log);
  }

  async requestJson<T>(method: string, path: string, requestOptions: GrafanaRequestOptions = {}): Promise<T> {
    let target: URL;
    try {
      target = this.buildUrl(path, requestOptions.query);
    } catch {
      throw new GrafanaApiError('invalid-response', `Invalid Grafana request path: ${path}`);
    }
    const bodyText = requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body);
    const backoffs = this.backoffScheduleFor(method, requestOptions.retry);

    for (let attempt = 0; ; attempt++) {
      try {
        const { status, text } = await this.performRequest(target, method, bodyText, requestOptions.maxResponseBytes);
        return parseJsonResponse<T>(status, text, target);
      } catch (error) {
        const backoffMs = backoffs[attempt];
        if (backoffMs === undefined || !isRetriableFailure(error)) {
          this.logClassifiedFailure(method, target, error);
          throw error;
        }
        this.log.debug(
          `grafana-api: ${method} ${target.pathname} failed transiently ` +
            `(${describeFailure(error)}); retrying in ${backoffMs}ms ` +
            `(attempt ${attempt + 2} of ${backoffs.length + 1})`
        );
        await delay(backoffMs);
      }
    }
  }

  /** An empty schedule means "one attempt"; see `RETRIABLE_METHODS` and `GrafanaRequestOptions.retry`. */
  private backoffScheduleFor(method: string, retry: boolean | undefined): readonly number[] {
    if (retry === false || !RETRIABLE_METHODS.has(method.toUpperCase())) {
      return [];
    }
    return this.options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  }

  /**
   * Only the classification reaches the channel -- never the query string,
   * which on the datasource proxy path carries the caller's PromQL/LogQL and
   * on a render URL can carry a token. `pathname` is what the existing error
   * messages already expose, so this adds no new surface.
   */
  private logClassifiedFailure(method: string, target: URL, error: unknown): void {
    if (error instanceof GrafanaApiError) {
      this.log.debug(`grafana-api: ${method} ${target.pathname} failed (${describeFailure(error)}): ${error.message}`);
      return;
    }
    this.log.debug(`grafana-api: ${method} ${target.pathname} failed with an unclassified error: ${String(error)}`);
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): URL {
    const target = new URL(path.startsWith('/') ? path.slice(1) : path, `${this.baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          target.searchParams.set(key, value);
        }
      }
    }
    return target;
  }

  private performRequest(
    target: URL,
    method: string,
    bodyText: string | undefined,
    maxResponseBytes?: number
  ): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      // Guards against the size-cap abort path below racing a subsequent
      // 'error'/'end' event on the same response/request (destroying a
      // stream doesn't guarantee no further events fire) -- settle exactly
      // once no matter which path gets there first.
      let settled = false;
      const settleResolve = (value: { status: number; text: string }) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const settleReject = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      const isHttps = target.protocol === 'https:';
      const client: typeof http | typeof https = isHttps ? https : http;
      const headers: Record<string, string> = {
        'user-agent': GRAFANA_CLIENT_USER_AGENT,
        authorization: `Bearer ${this.options.token}`,
        accept: 'application/json'
      };
      if (bodyText !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(bodyText).toString();
      }

      const certVerifier = this.options.certVerifier;
      const usesCertVerifier = isHttps && Boolean(certVerifier);

      const request = client.request(
        target,
        {
          method,
          headers,
          timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          // HTTPS goes through the shared keep-alive pool (PERF-01); plain
          // HTTP keeps Node's default global-agent behavior untouched.
          agent: isHttps ? sharedGrafanaHttpsAgent : undefined,
          rejectUnauthorized: usesCertVerifier ? false : undefined
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer | string) => {
            if (settled) {
              return;
            }
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buf.length;
            if (maxResponseBytes !== undefined && size > maxResponseBytes) {
              // Early-abort per Task 6.1: stop reading now rather than
              // buffering the rest of a response we already know is over
              // the cap. `response.destroy()` with no argument tears down
              // the stream without emitting its own 'error' event, so this
              // is the only place that settles the promise for this path.
              settleReject(
                new GrafanaApiError(
                  'response-too-large',
                  `Grafana response for ${target.pathname} exceeded the configured maximum of ${maxResponseBytes} bytes; aborted before buffering the full body.`
                )
              );
              response.destroy();
              return;
            }
            chunks.push(buf);
          });
          response.on('end', () => {
            settleResolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
          });
          response.on('error', (error: NodeJS.ErrnoException) => settleReject(toNetworkOrTlsError(error)));
        }
      );

      request.on('timeout', () => {
        request.destroy(new GrafanaApiError('network', `Request to Grafana timed out: ${target.pathname}`));
      });

      request.on('error', (error) => {
        settleReject(error instanceof GrafanaApiError ? error : toNetworkOrTlsError(error as NodeJS.ErrnoException));
      });

      if (usesCertVerifier && certVerifier) {
        // Deferred write: nothing leaves the process until verify() settles.
        attachCertVerification(request, target.hostname, portOf(target), certVerifier, {
          onVerified: () => writeAndEnd(request, bodyText),
          onRejected: (error) => request.destroy(error)
        });
        return;
      }

      writeAndEnd(request, bodyText);
    });
  }
}

export interface CertVerificationHooks {
  onVerified(): void;
  onRejected(error: GrafanaApiError): void;
}

/**
 * Wires the handshake hook that defers `onVerified` until the certVerifier's
 * TOFU fingerprint check settles (mirroring the SSH-host-key confirmation
 * flow). Exported standalone so this security-sensitive wiring exists in
 * exactly one place: GrafanaHttpClient uses it for buffered JSON requests,
 * and GrafanaEmbedProxy (Task 4.1, src/webview/GrafanaEmbedProxy.ts) reuses
 * it verbatim for raw byte-stream proxied requests instead of duplicating
 * the secureConnect/fingerprint glue.
 *
 * Keep-alive twist (PERF-01): a socket handed out of an Agent's free pool
 * already completed its TLS handshake and will never emit 'secureConnect'
 * again, so waiting for that event left the deferred write -- and the whole
 * request -- hanging until timeout on every reused socket (the default on
 * Node >= 19, where the global agents keep-alive). When the handshake is
 * already done the peer certificate is read synchronously and verified
 * immediately instead. Both paths run the same `verifyCertFingerprint`, so
 * a fingerprint that changed since the socket was first trusted still fails
 * closed on reuse.
 */
export function attachCertVerification(
  request: http.ClientRequest,
  host: string,
  port: number,
  certVerifier: GrafanaCertVerifier,
  hooks: CertVerificationHooks
): void {
  // Exactly one verification (and therefore one onVerified/onRejected) per
  // request, even if the reused-socket path and a late 'secureConnect' were
  // ever to fire for the same socket.
  let verificationStarted = false;
  request.on('socket', (socket) => {
    const tlsSocket = socket as TLSSocket;
    const runVerification = () => {
      if (verificationStarted) {
        return;
      }
      verificationStarted = true;
      const fingerprint256 = tlsSocket.getPeerCertificate()?.fingerprint256;
      verifyCertFingerprint(certVerifier, host, port, fingerprint256)
        .then((verifyError) => {
          if (verifyError) {
            hooks.onRejected(verifyError);
            return;
          }
          hooks.onVerified();
        })
        .catch((error: unknown) => {
          hooks.onRejected(
            new GrafanaApiError(
              'tls',
              `Grafana TLS certificate verification failed: ${error instanceof Error ? error.message : String(error)}`
            )
          );
        });
    };
    if (isTlsHandshakeAlreadyComplete(request, tlsSocket)) {
      runVerification();
      return;
    }
    socket.once('secureConnect', runVerification);
  });
}

/**
 * Whether this socket's TLS handshake already happened, meaning
 * 'secureConnect' will never fire for this request. `reusedSocket` is the
 * Agent's own keep-alive signal; the fingerprint probe covers any other way
 * a post-handshake socket could be assigned, and is the exact datum the
 * verification needs anyway. (`tlsSocket.authorized` is useless here: the
 * TLSSocket constructor initializes it to `false`, not `undefined`, so it
 * cannot distinguish "handshake pending" from "handshake done".)
 */
function isTlsHandshakeAlreadyComplete(request: http.ClientRequest, socket: TLSSocket): boolean {
  if (request.reusedSocket) {
    return true;
  }
  return typeof socket.getPeerCertificate === 'function' && Boolean(socket.getPeerCertificate()?.fingerprint256);
}

/**
 * Exported standalone so the fingerprint-classification logic is
 * unit-testable without a real TLS handshake (see
 * test/grafana/GrafanaHttpClient.test.ts), matching the existing
 * `isTlsConnectionError` pattern in testGrafanaConnection.ts.
 */
export async function verifyCertFingerprint(
  verifier: GrafanaCertVerifier,
  host: string,
  port: number,
  fingerprint256: string | undefined
): Promise<GrafanaApiError | undefined> {
  if (!fingerprint256) {
    return new GrafanaApiError('tls', `Grafana TLS certificate for ${host}:${port} did not present a fingerprint.`);
  }
  const trusted = await verifier.verify(host, port, fingerprint256);
  return trusted
    ? undefined
    : new GrafanaApiError(
        'tls',
        `Grafana TLS certificate for ${host}:${port} was rejected by the certificate verifier.` +
          // UX-08: this message reaches the Agent via MCP tool errors, where
          // no TOFU prompt can be shown -- tell it the human recovery path.
          ' The user must open this instance once in the AT Grafana sidebar to confirm its TLS fingerprint (Trust-On-First-Use).'
      );
}

function writeAndEnd(request: http.ClientRequest, bodyText: string | undefined): void {
  if (bodyText !== undefined) {
    request.write(bodyText);
  }
  request.end();
}

function portOf(target: URL): number {
  if (target.port) {
    return Number(target.port);
  }
  return target.protocol === 'https:' ? 443 : 80;
}

function toNetworkOrTlsError(error: NodeJS.ErrnoException): GrafanaApiError {
  if (isTlsConnectionError(error)) {
    return new GrafanaApiError('tls', `Grafana TLS certificate is not trusted: ${error.message}`);
  }
  return new GrafanaApiError('network', error.message);
}

function parseJsonResponse<T>(status: number, text: string, target: URL): T {
  if (status === 401 || status === 403) {
    throw new GrafanaApiError('auth', `Grafana rejected the request (HTTP ${status}).`, status);
  }
  if (status < 200 || status >= 300) {
    const detail = extractErrorMessage(text);
    throw new GrafanaApiError(
      'api-error',
      `Grafana returned HTTP ${status} for ${target.pathname}${detail ? `: ${detail}` : '.'}`,
      status
    );
  }
  if (text.length === 0) {
    return undefined as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GrafanaApiError('invalid-response', `Grafana returned a non-JSON response for ${target.pathname}.`);
  }
}

function extractErrorMessage(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { message?: unknown }).message === 'string') {
      return (parsed as { message: string }).message;
    }
  } catch {
    // Body wasn't JSON; fall through to the generic status-only message.
  }
  return undefined;
}
