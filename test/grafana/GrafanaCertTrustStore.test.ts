import { describe, expect, it } from 'vitest';
import { GrafanaCertTrustStore, type CertTrustMemento } from '../../src/grafana/GrafanaCertTrustStore';

class MemoryMemento implements CertTrustMemento {
  private data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

describe('GrafanaCertTrustStore', () => {
  it('returns unknown for an unseen host', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    expect(await store.check('grafana.example.com', 443, 'SHA256:abc')).toBe('unknown');
  });

  it('trusts a host and returns trusted for the same fingerprint', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    await store.trust('grafana.example.com', 443, 'SHA256:abc');
    expect(await store.check('grafana.example.com', 443, 'SHA256:abc')).toBe('trusted');
  });

  it('returns changed when a trusted fingerprint differs', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    await store.trust('grafana.example.com', 443, 'SHA256:abc');
    expect(await store.check('grafana.example.com', 443, 'SHA256:def')).toBe('changed');
  });

  it('forgets a trusted cert by host and port', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    await store.trust('grafana.example.com', 443, 'SHA256:abc');
    await store.forget('grafana.example.com', 443);
    expect(await store.check('grafana.example.com', 443, 'SHA256:def')).toBe('unknown');
  });

  it('persists trusted fingerprints across store instances sharing the same memento', async () => {
    const memento = new MemoryMemento();
    await new GrafanaCertTrustStore(memento).trust('grafana.example.com', 443, 'SHA256:abc');
    expect(await new GrafanaCertTrustStore(memento).check('grafana.example.com', 443, 'SHA256:abc')).toBe('trusted');
  });

  it('listTrusted returns an empty list when nothing has been trusted', () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    expect(store.listTrusted()).toEqual([]);
  });

  it('listTrusted returns every recorded cert, sorted by host:port', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    await store.trust('zeta.example.com', 443, 'SHA256:zzz');
    await store.trust('alpha.example.com', 3000, 'SHA256:aaa');

    const trusted = store.listTrusted();

    expect(trusted.map((cert) => `${cert.host}:${cert.port}`)).toEqual([
      'alpha.example.com:3000',
      'zeta.example.com:443'
    ]);
    expect(trusted[0]).toMatchObject({ host: 'alpha.example.com', port: 3000, fingerprint: 'SHA256:aaa' });
    expect(typeof trusted[0].trustedAt).toBe('number');
  });

  it('listTrusted no longer includes an entry after forget()', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    await store.trust('grafana.example.com', 443, 'SHA256:abc');
    await store.trust('other.example.com', 443, 'SHA256:def');

    await store.forget('grafana.example.com', 443);

    expect(store.listTrusted().map((cert) => cert.host)).toEqual(['other.example.com']);
  });
});
