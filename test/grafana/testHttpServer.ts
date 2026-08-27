import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';

export interface TestHttpServer {
  url: string;
  requestCount: number;
  close(): Promise<void>;
}

export interface TestTlsHttpServer extends TestHttpServer {
  /**
   * Completed TLS handshakes, i.e. distinct client sockets. Stays at 1 across
   * multiple requests exactly when keep-alive socket reuse is happening --
   * the observable the PERF-01 regression tests hang their assertions on.
   */
  tlsConnectionCount: number;
}

export async function listen(handler: http.RequestListener): Promise<TestHttpServer> {
  const state = { requestCount: 0 };
  const server = http.createServer((req, res) => {
    state.requestCount++;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    get requestCount() {
      return state.requestCount;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

/**
 * Self-signed certificate fixture for 127.0.0.1 (valid ~100 years). Test-only
 * material: the private key is deliberately committed so the TLS keep-alive
 * tests run deterministically and offline. Clients under test either skip
 * chain validation (the TOFU path uses `rejectUnauthorized: false`) or are
 * expected to reject it. Regenerate with:
 *   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
 *     -keyout key.pem -out cert.pem -days 36500 -nodes \
 *     -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1"
 */
const SELF_SIGNED_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgROX2Zd4qfliZD5rK
/DFFnjO0BapLprJ+1B6+p6Q2OhahRANCAAQjiDoGh4vkI4msHeHVyazvmrwN1kl9
Jbnan9QQvY35Ks3OTJjqNvlcPdeBu/VLgaY2lPc8D5GDmEzP/xHRk3NJ
-----END PRIVATE KEY-----
`;

const SELF_SIGNED_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBkDCCATagAwIBAgIUQzt1Nisn9rsLgEl5joZlg+dlv1MwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDgyNzEwMzExOFoYDzIxMjYwODAz
MTAzMTE4WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQjiDoGh4vkI4msHeHVyazvmrwN1kl9Jbnan9QQvY35Ks3OTJjqNvlc
PdeBu/VLgaY2lPc8D5GDmEzP/xHRk3NJo2QwYjAdBgNVHQ4EFgQUKn2E5aZBiy4J
E0MvrMa6oBTxmWMwHwYDVR0jBBgwFoAUKn2E5aZBiy4JE0MvrMa6oBTxmWMwDwYD
VR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMAoGCCqGSM49BAMCA0gAMEUC
IHc5pciKXxM1ivIaFPusaKFAOfaoQurLLr8aNNLHRfZ9AiEA6QmhHCR75KDrMNgp
gAZTDGrL5P+Kaos3AY/XOaNJ0Hs=
-----END CERTIFICATE-----
`;

/**
 * HTTPS twin of `listen`, self-signed. `close()` relies on Node >= 19
 * closing idle keep-alive connections on `server.close()`, same as the
 * plain-HTTP helper.
 */
export async function listenTls(handler: http.RequestListener): Promise<TestTlsHttpServer> {
  const state = { requestCount: 0, tlsConnectionCount: 0 };
  const server = https.createServer({ key: SELF_SIGNED_TLS_KEY, cert: SELF_SIGNED_TLS_CERT }, (req, res) => {
    state.requestCount++;
    handler(req, res);
  });
  server.on('secureConnection', () => state.tlsConnectionCount++);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${address.port}`,
    get requestCount() {
      return state.requestCount;
    },
    get tlsConnectionCount() {
      return state.tlsConnectionCount;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

export function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text.length > 0 ? JSON.parse(text) : undefined);
    });
    req.on('error', reject);
  });
}
