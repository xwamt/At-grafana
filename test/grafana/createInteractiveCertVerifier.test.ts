import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createInteractiveCertVerifier } from '../../src/grafana/createInteractiveCertVerifier';
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createInteractiveCertVerifier', () => {
  it('prompts and trusts on accept when the fingerprint has never been seen before', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Trust Certificate' as never);
    const verifier = createInteractiveCertVerifier(store);

    const result = await verifier.verify('grafana.example.com', 443, 'SHA256:abc');

    expect(result).toBe(true);
    expect(showWarningMessage).toHaveBeenCalledTimes(1);
    expect(await store.check('grafana.example.com', 443, 'SHA256:abc')).toBe('trusted');
  });

  it('prompts and rejects (does not trust) when the user dismisses the unknown-cert prompt', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const verifier = createInteractiveCertVerifier(store);

    const result = await verifier.verify('grafana.example.com', 443, 'SHA256:abc');

    expect(result).toBe(false);
    expect(await store.check('grafana.example.com', 443, 'SHA256:abc')).toBe('unknown');
  });

  it('does not prompt at all when the fingerprint is already trusted', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    await store.trust('grafana.example.com', 443, 'SHA256:abc');
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage');
    const verifier = createInteractiveCertVerifier(store);

    const result = await verifier.verify('grafana.example.com', 443, 'SHA256:abc');

    expect(result).toBe(true);
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('prompts with a distinct message and trusts the new fingerprint on explicit accept when the fingerprint changed', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    await store.trust('grafana.example.com', 443, 'SHA256:old');
    const showWarningMessage = vi
      .spyOn(vscode.window, 'showWarningMessage')
      .mockResolvedValue('Trust New Certificate' as never);
    const verifier = createInteractiveCertVerifier(store);

    const result = await verifier.verify('grafana.example.com', 443, 'SHA256:new');

    expect(result).toBe(true);
    expect(await store.check('grafana.example.com', 443, 'SHA256:new')).toBe('trusted');
    const [message] = showWarningMessage.mock.calls[0] ?? [];
    expect(String(message)).toMatch(/changed/i);
  });

  it('fails closed (rejects) on a changed fingerprint when the user dismisses the prompt without an explicit choice', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    await store.trust('grafana.example.com', 443, 'SHA256:old');
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const verifier = createInteractiveCertVerifier(store);

    const result = await verifier.verify('grafana.example.com', 443, 'SHA256:new');

    expect(result).toBe(false);
    // The old fingerprint must remain the trusted one; the prompt was dismissed, not accepted.
    expect(await store.check('grafana.example.com', 443, 'SHA256:old')).toBe('trusted');
  });

  it('fails closed (rejects) on a changed fingerprint when the user explicitly rejects', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    await store.trust('grafana.example.com', 443, 'SHA256:old');
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Reject' as never);
    const verifier = createInteractiveCertVerifier(store);

    const result = await verifier.verify('grafana.example.com', 443, 'SHA256:new');

    expect(result).toBe(false);
  });

  it('the unknown-cert and changed-cert prompts use visibly different messages', async () => {
    const unknownStore = new GrafanaCertTrustStore(new MemoryMemento());
    const changedStore = new GrafanaCertTrustStore(new MemoryMemento());
    await changedStore.trust('grafana.example.com', 443, 'SHA256:old');

    const messages: string[] = [];
    vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(async (message: unknown) => {
      messages.push(String(message));
      return undefined;
    });

    await createInteractiveCertVerifier(unknownStore).verify('grafana.example.com', 443, 'SHA256:abc');
    await createInteractiveCertVerifier(changedStore).verify('grafana.example.com', 443, 'SHA256:new');

    expect(messages).toHaveLength(2);
    expect(messages[0]).not.toEqual(messages[1]);
    expect(messages[1]).toMatch(/changed/i);
  });
});
