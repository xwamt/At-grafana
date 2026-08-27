import { asRedactedLog, noopLog, type AtGrafanaLog } from '../utils/logger';

const TRUSTED_CERTS_KEY = 'atGrafana.trustedCertFingerprints';

export type CertTrustStatus = 'unknown' | 'trusted' | 'changed';

export interface TrustedCert {
  host: string;
  port: number;
  fingerprint: string;
  trustedAt: number;
}

export interface CertTrustMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * Trust-on-first-use store for self-signed/private-CA Grafana TLS certificates,
 * keyed by instance host:port. Mirrors at-terminal-series's HostKeyStore (SSH
 * host keys) but stores a certificate fingerprint instead. See
 * docs/decisions/ADR-004 and Task 1.3 in the implementation plan.
 */
export class GrafanaCertTrustStore {
  /**
   * Remembers which `host:port -> presented fingerprint` mismatches have
   * already been reported. A changed certificate fails *every* sub-resource
   * of a proxied dashboard, so an undeduplicated warning would emit hundreds
   * of identical lines and bury whatever else the user opened the channel to
   * read. Bounded by the number of distinct fingerprints actually presented,
   * which in any real failure is one.
   */
  private readonly reportedMismatches = new Set<string>();
  private readonly log: AtGrafanaLog;

  constructor(
    private readonly globalState: CertTrustMemento,
    log: AtGrafanaLog = noopLog
  ) {
    this.log = asRedactedLog(log);
  }

  async check(host: string, port: number, fingerprint: string): Promise<CertTrustStatus> {
    const existing = this.read()[this.key(host, port)];
    if (!existing) {
      this.log.trace(`cert-trust: no recorded fingerprint for ${this.key(host, port)}`);
      return 'unknown';
    }
    if (existing.fingerprint === fingerprint) {
      this.log.trace(`cert-trust: ${this.key(host, port)} matches the trusted fingerprint`);
      return 'trusted';
    }
    this.warnOnceAboutMismatch(host, port, existing.fingerprint, fingerprint);
    return 'changed';
  }

  async trust(host: string, port: number, fingerprint: string): Promise<void> {
    const certs = this.read();
    const previous = certs[this.key(host, port)];
    certs[this.key(host, port)] = {
      host,
      port,
      fingerprint,
      trustedAt: Date.now()
    };
    await this.globalState.update(TRUSTED_CERTS_KEY, certs);
    // A trust decision is a durable security-relevant state change made once
    // per instance, so it earns a default-visible line -- unlike the `check`
    // that consults it on every request.
    this.log.info(
      previous
        ? `cert-trust: replaced the trusted fingerprint for ${this.key(host, port)} (was ${previous.fingerprint}, now ${fingerprint})`
        : `cert-trust: trusted ${this.key(host, port)} on first use (fingerprint ${fingerprint})`
    );
    this.reportedMismatches.delete(this.mismatchKey(host, port, fingerprint));
  }

  getTrusted(host: string, port: number): TrustedCert | undefined {
    return this.read()[this.key(host, port)];
  }

  /**
   * Every recorded trust decision, sorted by host:port so the "Forget Trusted
   * Certificate" QuickPick (FUNC-05) renders a stable order.
   */
  listTrusted(): TrustedCert[] {
    return Object.values(this.read()).sort((a, b) =>
      `${a.host}:${a.port}`.localeCompare(`${b.host}:${b.port}`)
    );
  }

  async forget(host: string, port: number): Promise<void> {
    const certs = this.read();
    delete certs[this.key(host, port)];
    await this.globalState.update(TRUSTED_CERTS_KEY, certs);
  }

  private warnOnceAboutMismatch(host: string, port: number, expected: string, presented: string): void {
    const key = this.mismatchKey(host, port, presented);
    if (this.reportedMismatches.has(key)) {
      return;
    }
    this.reportedMismatches.add(key);
    this.log.warn(
      `cert-trust: fingerprint CHANGED for ${this.key(host, port)} (trusted ${expected}, presented ${presented}); ` +
        'refusing the connection until the new certificate is confirmed'
    );
  }

  private read(): Record<string, TrustedCert> {
    return this.globalState.get<Record<string, TrustedCert>>(TRUSTED_CERTS_KEY, {});
  }

  private key(host: string, port: number): string {
    return `${host}:${port}`;
  }

  private mismatchKey(host: string, port: number, fingerprint: string): string {
    return `${this.key(host, port)}|${fingerprint}`;
  }
}
