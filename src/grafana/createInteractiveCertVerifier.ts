import * as vscode from 'vscode';
import { t } from '../i18n/t';
import type { GrafanaCertTrustStore } from './GrafanaCertTrustStore';
import type { GrafanaCertVerifier } from './GrafanaHttpClient';

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
/**
 * Singleflight registry: one in-flight confirmation per trust store and
 * fingerprint. Keyed by the store instance through a `WeakMap` so multiple
 * `createInteractiveCertVerifier(store)` calls inside the same extension
 * share the same lock, while test-created `MemoryMemento` stores stay
 * isolated from one another and can be garbage collected.
 *
 * Without this, the tree views' `Promise.all` fan-out (or several panels
 * opening at once) issues multiple concurrent HTTPS requests against an
 * untrusted instance; each request reaches `verify()` before the first
 * prompt is answered and the user gets 2-4 identical modal dialogs.
 */
const inFlightByStore = new WeakMap<GrafanaCertTrustStore, Map<string, Promise<boolean>>>();

export function createInteractiveCertVerifier(trustStore: GrafanaCertTrustStore): GrafanaCertVerifier {
  return {
    async verify(host: string, port: number, fingerprint256: string): Promise<boolean> {
      const status = await trustStore.check(host, port, fingerprint256);

      if (status === 'trusted') {
        return true;
      }

      let storeInFlight = inFlightByStore.get(trustStore);
      if (!storeInFlight) {
        storeInFlight = new Map();
        inFlightByStore.set(trustStore, storeInFlight);
      }
      const key = `${host}:${port}|${fingerprint256}`;
      const existing = storeInFlight.get(key);
      if (existing) {
        return existing;
      }

      const pending = promptForTrust(trustStore, host, port, fingerprint256, status).finally(() => {
        storeInFlight!.delete(key);
      });
      storeInFlight.set(key, pending);
      return pending;
    }
  };
}

async function promptForTrust(
  trustStore: GrafanaCertTrustStore,
  host: string,
  port: number,
  fingerprint256: string,
  status: 'unknown' | 'changed'
): Promise<boolean> {
  if (status === 'changed') {
    const previous = trustStore.getTrusted(host, port);
    const trustAction = t('Trust New Certificate');
    const choice = await vscode.window.showWarningMessage(
      t(
        'SECURITY WARNING: The TLS certificate for Grafana instance {host}:{port} has CHANGED since it was last trusted.\n\nPreviously trusted fingerprint: {previousFingerprint}\nNew fingerprint presented: {fingerprint}\n\nThis can happen after a legitimate certificate rotation, but it can also indicate a machine-in-the-middle attack. Only continue if you can independently confirm the new fingerprint with whoever administers this Grafana server.',
        {
          host,
          port,
          previousFingerprint: previous?.fingerprint ?? t('(unknown)'),
          fingerprint: fingerprint256
        }
      ),
      { modal: true },
      trustAction,
      t('Reject')
    );
    if (choice === trustAction) {
      await trustStore.trust(host, port, fingerprint256);
      return true;
    }
    // Fail closed: an explicit "Reject" and a dismissed/closed modal are
    // indistinguishable from `showWarningMessage`'s return value
    // (both resolve `undefined`), and both must reject the certificate.
    return false;
  }

  // status === 'unknown'
  const trustAction = t('Trust Certificate');
  const choice = await vscode.window.showWarningMessage(
    t(
      'Grafana instance {host}:{port} presented a TLS certificate that has not been seen before.\n\nFingerprint: {fingerprint}\n\nIf you recognize and trust this Grafana server (for example, it uses a self-signed or private-CA certificate you administer), you can trust it now. Otherwise, reject the connection.',
      { host, port, fingerprint: fingerprint256 }
    ),
    { modal: true },
    trustAction,
    t('Reject')
  );
  if (choice === trustAction) {
    await trustStore.trust(host, port, fingerprint256);
    return true;
  }
  return false;
}

