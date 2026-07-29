import * as http from 'node:http';
import * as https from 'node:https';

export type GrafanaConnectionTestResult =
  | { ok: true }
  | { ok: false; reason: 'network' | 'tls' | 'auth' | 'error'; message: string };

export interface GrafanaConnectionTestOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8000;

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
]);

/**
 * Best-effort connectivity/auth probe against `GET {url}/api/health`, used by
 * the instance form's "Test connection" button (Task 1.2). This is
 * intentionally standalone (no dependency on the future GrafanaApiClient from
 * Phase 2) and does not consult GrafanaCertTrustStore — it only classifies
 * the failure so the form can show a distinct message per
 * requirements §5.4. Trust-on-first-use prompting happens once the real API
 * client (Task 2.1) wires certificate verification through the store.
 */
export function testGrafanaConnection(
  url: string,
  token: string | undefined,
  options: GrafanaConnectionTestOptions = {}
): Promise<GrafanaConnectionTestResult> {
  return new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL('/api/health', url);
    } catch {
      resolve({ ok: false, reason: 'error', message: 'Invalid Grafana URL.' });
      return;
    }

    const client = target.protocol === 'http:' ? http : https;
    const request = client.request(
      target,
      {
        method: 'GET',
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        headers: token ? { authorization: `Bearer ${token}` } : undefined
      },
      (response) => {
        response.resume();
        const status = response.statusCode ?? 0;
        if (status === 401 || status === 403) {
          resolve({ ok: false, reason: 'auth', message: `Grafana rejected the token (HTTP ${status}).` });
          return;
        }
        if (status >= 200 && status < 300) {
          resolve({ ok: true });
          return;
        }
        resolve({ ok: false, reason: 'error', message: `Grafana responded with HTTP ${status}.` });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error('Connection timed out.'));
    });

    request.on('error', (error: NodeJS.ErrnoException) => {
      if (isTlsConnectionError(error)) {
        resolve({ ok: false, reason: 'tls', message: `TLS certificate is not trusted: ${error.message}` });
        return;
      }
      resolve({ ok: false, reason: 'network', message: error.message });
    });

    request.end();
  });
}

export function isTlsConnectionError(error: NodeJS.ErrnoException): boolean {
  return typeof error.code === 'string' && TLS_ERROR_CODES.has(error.code);
}
