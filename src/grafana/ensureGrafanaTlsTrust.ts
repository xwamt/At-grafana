import type { GrafanaCertTrustStore } from './GrafanaCertTrustStore';
import { createInteractiveCertVerifier } from './createInteractiveCertVerifier';
import { GrafanaApiClient, GrafanaApiError } from './GrafanaApiClient';

export type GrafanaTlsTrustResult = { ok: true } | { ok: false; message: string };

/**
 * Ensures the Grafana instance's TLS certificate is trusted in the TOFU store
 * before opening an embed proxy view. For HTTPS instances this performs a
 * lightweight `/api/health` probe with the interactive certificate verifier,
 * which prompts once on first connect (or on fingerprint change) and records
 * the fingerprint in `certTrustStore` for `GrafanaEmbedProxy`'s pre-flight gate.
 */
export async function ensureGrafanaTlsTrust(
  instanceUrl: string,
  token: string,
  certTrustStore: GrafanaCertTrustStore
): Promise<GrafanaTlsTrustResult> {
  let parsed: URL;
  try {
    parsed = new URL(instanceUrl);
  } catch {
    return { ok: false, message: 'Invalid Grafana URL.' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: true };
  }

  try {
    const client = new GrafanaApiClient({
      baseUrl: instanceUrl,
      token,
      certVerifier: createInteractiveCertVerifier(certTrustStore)
    });
    await client.health();
    return { ok: true };
  } catch (error) {
    if (error instanceof GrafanaApiError) {
      return { ok: false, message: error.message };
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
