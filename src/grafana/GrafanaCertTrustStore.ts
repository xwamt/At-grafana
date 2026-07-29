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
  constructor(private readonly globalState: CertTrustMemento) {}

  async check(host: string, port: number, fingerprint: string): Promise<CertTrustStatus> {
    const existing = this.read()[this.key(host, port)];
    if (!existing) {
      return 'unknown';
    }
    return existing.fingerprint === fingerprint ? 'trusted' : 'changed';
  }

  async trust(host: string, port: number, fingerprint: string): Promise<void> {
    const certs = this.read();
    certs[this.key(host, port)] = {
      host,
      port,
      fingerprint,
      trustedAt: Date.now()
    };
    await this.globalState.update(TRUSTED_CERTS_KEY, certs);
  }

  getTrusted(host: string, port: number): TrustedCert | undefined {
    return this.read()[this.key(host, port)];
  }

  async forget(host: string, port: number): Promise<void> {
    const certs = this.read();
    delete certs[this.key(host, port)];
    await this.globalState.update(TRUSTED_CERTS_KEY, certs);
  }

  private read(): Record<string, TrustedCert> {
    return this.globalState.get<Record<string, TrustedCert>>(TRUSTED_CERTS_KEY, {});
  }

  private key(host: string, port: number): string {
    return `${host}:${port}`;
  }
}
