import * as http from 'node:http';
import * as https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { isTlsConnectionError } from './testGrafanaConnection';

/**
 * `validation` is a deliberate addition beyond the kinds sketched in the
 * Task 2.1 brief (`network`/`tls`/`auth`/`api-error`/`invalid-response`):
 * it exists specifically for `proxyDatasourceRequest`'s method allowlist
 * guard (ADR-004 MON4), which is a client-side request-shape rejection that
 * happens *before* any network call, not a response-classification concern
 * like the other four kinds. See GrafanaDatasourcesApi.ts.
 */
export type GrafanaApiErrorKind = 'network' | 'tls' | 'auth' | 'api-error' | 'invalid-response' | 'validation';

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
}

export interface GrafanaRequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
}

const DEFAULT_TIMEOUT_MS = 15_000;

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

  constructor(private readonly options: GrafanaHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  async requestJson<T>(method: string, path: string, requestOptions: GrafanaRequestOptions = {}): Promise<T> {
    let target: URL;
    try {
      target = this.buildUrl(path, requestOptions.query);
    } catch {
      throw new GrafanaApiError('invalid-response', `Invalid Grafana request path: ${path}`);
    }
    const bodyText = requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body);
    const { status, text } = await this.performRequest(target, method, bodyText);
    return parseJsonResponse<T>(status, text, target);
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

  private performRequest(target: URL, method: string, bodyText: string | undefined): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const isHttps = target.protocol === 'https:';
      const client: typeof http | typeof https = isHttps ? https : http;
      const headers: Record<string, string> = {
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
          rejectUnauthorized: usesCertVerifier ? false : undefined
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer | string) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => {
            resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
          });
          response.on('error', (error: NodeJS.ErrnoException) => reject(toNetworkOrTlsError(error)));
        }
      );

      request.on('timeout', () => {
        request.destroy(new GrafanaApiError('network', `Request to Grafana timed out: ${target.pathname}`));
      });

      request.on('error', (error) => {
        reject(error instanceof GrafanaApiError ? error : toNetworkOrTlsError(error as NodeJS.ErrnoException));
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
 * Wires a one-shot `secureConnect` handshake hook that defers `onVerified`
 * until the certVerifier's TOFU fingerprint check settles (mirroring the
 * SSH-host-key confirmation flow). Exported standalone so this
 * security-sensitive wiring exists in exactly one place: GrafanaHttpClient
 * uses it for buffered JSON requests, and GrafanaEmbedProxy (Task 4.1,
 * src/webview/GrafanaEmbedProxy.ts) reuses it verbatim for raw byte-stream
 * proxied requests instead of duplicating the secureConnect/fingerprint glue.
 */
export function attachCertVerification(
  request: http.ClientRequest,
  host: string,
  port: number,
  certVerifier: GrafanaCertVerifier,
  hooks: CertVerificationHooks
): void {
  request.on('socket', (socket) => {
    socket.once('secureConnect', () => {
      const fingerprint256 = (socket as TLSSocket).getPeerCertificate()?.fingerprint256;
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
    });
  });
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
    : new GrafanaApiError('tls', `Grafana TLS certificate for ${host}:${port} was rejected by the certificate verifier.`);
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
