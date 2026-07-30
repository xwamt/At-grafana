import { describe, expect, it } from 'vitest';
import { GrafanaCertTrustStore } from '../../src/grafana/GrafanaCertTrustStore';
import { ensureGrafanaTlsTrust } from '../../src/grafana/ensureGrafanaTlsTrust';

function memento() {
  const data = new Map<string, unknown>();
  return {
    get: <T>(key: string, defaultValue: T) => (data.has(key) ? (data.get(key) as T) : defaultValue),
    update: async (key: string, value: unknown) => {
      data.set(key, value);
    }
  };
}

describe('ensureGrafanaTlsTrust', () => {
  it('skips TLS trust for plain HTTP instances', async () => {
    const store = new GrafanaCertTrustStore(memento());
    const result = await ensureGrafanaTlsTrust('http://127.0.0.1:3000', 'token', store);
    expect(result).toEqual({ ok: true });
  });

  it('rejects invalid URLs without probing', async () => {
    const store = new GrafanaCertTrustStore(memento());
    const result = await ensureGrafanaTlsTrust('not-a-url', 'token', store);
    expect(result).toEqual({ ok: false, message: 'Invalid Grafana URL.' });
  });
});
