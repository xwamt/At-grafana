import * as vscode from 'vscode';
import type { GrafanaCertTrustStore } from './GrafanaCertTrustStore';
import type { GrafanaCertVerifier } from './GrafanaHttpClient';

const TRUST_NEW_CERTIFICATE_ACTION = 'Trust New Certificate';
const TRUST_CERTIFICATE_ACTION = 'Trust Certificate';
const REJECT_ACTION = 'Reject';

/**
 * The first real, interactive Trust-On-First-Use verifier (Task 4.1). Mirrors
 * at-terminal-series's SSH host-key confirmation UX, but for Grafana TLS
 * certificate fingerprints:
 * - `unknown` (never seen before): prompts once, trusts on accept.
 * - `trusted` (matches the previously-trusted fingerprint): returns true
 *   immediately, no prompt — this is the steady-state, non-interruptive path.
 * - `changed` (fingerprint differs from the previously-trusted one — a
 *   legitimate cert rotation OR a MITM attempt): prompts with a more severe,
 *   explicit warning, and fails closed (rejects) unless the user explicitly
 *   picks the "trust new certificate" action; dismissing the modal (Escape,
 *   clicking away) is treated the same as an explicit reject.
 *
 * This file intentionally imports `vscode` (unlike the pure-logic
 * GrafanaCertTrustStore/GrafanaHttpClient files) since prompting is
 * inherently a UI concern.
 *
 * Wired into user-initiated flows that establish trust once up front:
 * `GrafanaApiClient` construction for tree/API calls, and
 * `ensureGrafanaTlsTrust()` ahead of opening dashboard/alert embed panels.
 * `GrafanaEmbedProxy` does not use this directly — prompting mid-request for
 * every proxied dashboard subresource would be unusable — so the proxy
 * instead refuses outright when an instance isn't already recorded as
 * trusted (see GrafanaEmbedProxy.ts's class doc).
 */
export function createInteractiveCertVerifier(trustStore: GrafanaCertTrustStore): GrafanaCertVerifier {
  return {
    async verify(host: string, port: number, fingerprint256: string): Promise<boolean> {
      const status = await trustStore.check(host, port, fingerprint256);

      if (status === 'trusted') {
        return true;
      }

      if (status === 'changed') {
        const previous = trustStore.getTrusted(host, port);
        const choice = await vscode.window.showWarningMessage(
          `SECURITY WARNING: The TLS certificate for Grafana instance ${host}:${port} has CHANGED since it was last trusted.\n\n` +
            `Previously trusted fingerprint: ${previous?.fingerprint ?? '(unknown)'}\n` +
            `New fingerprint presented: ${fingerprint256}\n\n` +
            'This can happen after a legitimate certificate rotation, but it can also indicate a ' +
            'machine-in-the-middle attack. Only continue if you can independently confirm the new ' +
            'fingerprint with whoever administers this Grafana server.',
          { modal: true },
          TRUST_NEW_CERTIFICATE_ACTION,
          REJECT_ACTION
        );
        if (choice === TRUST_NEW_CERTIFICATE_ACTION) {
          await trustStore.trust(host, port, fingerprint256);
          return true;
        }
        // Fail closed: an explicit "Reject" and a dismissed/closed modal are
        // indistinguishable from `showWarningMessage`'s return value
        // (both resolve `undefined`), and both must reject the certificate.
        return false;
      }

      // status === 'unknown'
      const choice = await vscode.window.showWarningMessage(
        `Grafana instance ${host}:${port} presented a TLS certificate that has not been seen before.\n\n` +
          `Fingerprint: ${fingerprint256}\n\n` +
          'If you recognize and trust this Grafana server (for example, it uses a self-signed or ' +
          'private-CA certificate you administer), you can trust it now. Otherwise, reject the connection.',
        { modal: true },
        TRUST_CERTIFICATE_ACTION,
        REJECT_ACTION
      );
      if (choice === TRUST_CERTIFICATE_ACTION) {
        await trustStore.trust(host, port, fingerprint256);
        return true;
      }
      return false;
    }
  };
}
