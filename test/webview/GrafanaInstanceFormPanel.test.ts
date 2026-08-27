import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { GrafanaInstanceConfig } from '../../src/config/schema';
import { GrafanaApiError, type GrafanaCertVerifier } from '../../src/grafana/GrafanaApiClient';
import { GrafanaCertTrustStore, type CertTrustMemento } from '../../src/grafana/GrafanaCertTrustStore';
import { createTofuConnectionTester, handleInstanceFormMessage } from '../../src/webview/GrafanaInstanceFormPanel';

function instance(overrides: Partial<GrafanaInstanceConfig> = {}): GrafanaInstanceConfig {
  return {
    id: 'instance-1',
    label: 'Production',
    url: 'https://grafana.example.com',
    allowBackgroundAccess: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

class MemoryMemento implements CertTrustMemento {
  private data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

describe('GrafanaInstanceFormPanel message handling', () => {
  it('creates a new instance on submit and disposes the panel', async () => {
    const postMessage = vi.fn();
    const dispose = vi.fn();
    const createInstance = vi.fn(async () => instance());
    const onSaved = vi.fn();

    const handled = await handleInstanceFormMessage(
      {
        type: 'submit',
        payload: {
          label: 'Production',
          url: 'https://grafana.example.com',
          token: 'glsa_abc',
          allowBackgroundAccess: 'on'
        }
      },
      undefined,
      { createInstance, updateInstance: vi.fn() } as never,
      onSaved,
      { dispose, webview: { postMessage } } as never
    );

    expect(handled).toBe(true);
    expect(createInstance).toHaveBeenCalledWith({
      label: 'Production',
      url: 'https://grafana.example.com',
      token: 'glsa_abc',
      allowBackgroundAccess: true
    });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects a new instance submitted without a token', async () => {
    const postMessage = vi.fn();
    const createInstance = vi.fn();

    const handled = await handleInstanceFormMessage(
      { type: 'submit', payload: { label: 'Production', url: 'https://grafana.example.com' } },
      undefined,
      { createInstance, updateInstance: vi.fn() } as never,
      vi.fn(),
      { dispose: vi.fn(), webview: { postMessage } } as never
    );

    expect(handled).toBe(true);
    expect(createInstance).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'error',
      payload: expect.stringContaining('Service Account Token')
    });
  });

  it('rejects an invalid url', async () => {
    const postMessage = vi.fn();

    await handleInstanceFormMessage(
      { type: 'submit', payload: { label: 'Production', url: 'not-a-url', token: 'x' } },
      undefined,
      { createInstance: vi.fn(), updateInstance: vi.fn() } as never,
      vi.fn(),
      { dispose: vi.fn(), webview: { postMessage } } as never
    );

    expect(postMessage).toHaveBeenCalledWith({ type: 'error', payload: expect.stringContaining('valid Grafana URL') });
  });

  it('updates an existing instance without requiring a new token', async () => {
    const updateInstance = vi.fn(async () => instance({ label: 'Renamed' }));
    const onSaved = vi.fn();
    const dispose = vi.fn();

    const handled = await handleInstanceFormMessage(
      { type: 'submit', payload: { label: 'Renamed', url: 'https://grafana.example.com', allowBackgroundAccess: true } },
      instance(),
      { createInstance: vi.fn(), updateInstance } as never,
      onSaved,
      { dispose, webview: { postMessage: vi.fn() } } as never
    );

    expect(handled).toBe(true);
    expect(updateInstance).toHaveBeenCalledWith(
      'instance-1',
      { label: 'Renamed', url: 'https://grafana.example.com', allowBackgroundAccess: true },
      undefined
    );
    expect(onSaved).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('reports errors thrown by the config manager back to the webview without disposing', async () => {
    const postMessage = vi.fn();
    const dispose = vi.fn();
    const createInstance = vi.fn(async () => {
      throw new Error('disk full');
    });

    await handleInstanceFormMessage(
      { type: 'submit', payload: { label: 'Production', url: 'https://grafana.example.com', token: 'x' } },
      undefined,
      { createInstance, updateInstance: vi.fn() } as never,
      vi.fn(),
      { dispose, webview: { postMessage } } as never
    );

    expect(postMessage).toHaveBeenCalledWith({ type: 'error', payload: 'disk full' });
    expect(dispose).not.toHaveBeenCalled();
  });

  it('runs a connection test and posts a success result', async () => {
    const postMessage = vi.fn();
    const testConnection = vi.fn(async () => ({ ok: true as const }));

    const handled = await handleInstanceFormMessage(
      { type: 'testConnection', payload: { url: 'https://grafana.example.com', token: 'x' } },
      undefined,
      { createInstance: vi.fn(), updateInstance: vi.fn() } as never,
      vi.fn(),
      { dispose: vi.fn(), webview: { postMessage } } as never,
      { testConnection }
    );

    expect(handled).toBe(true);
    expect(testConnection).toHaveBeenCalledWith('https://grafana.example.com', 'x');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'connectionTestResult',
      payload: { ok: true, message: 'Connection succeeded.' }
    });
  });

  it('runs a connection test and posts a distinct message per failure reason', async () => {
    const postMessage = vi.fn();
    const testConnection = vi.fn(async () => ({
      ok: false as const,
      reason: 'tls' as const,
      message: 'TLS certificate is not trusted: self-signed certificate'
    }));

    await handleInstanceFormMessage(
      { type: 'testConnection', payload: { url: 'https://grafana.example.com' } },
      undefined,
      { createInstance: vi.fn(), updateInstance: vi.fn() } as never,
      vi.fn(),
      { dispose: vi.fn(), webview: { postMessage } } as never,
      { testConnection }
    );

    expect(postMessage).toHaveBeenCalledWith({
      type: 'connectionTestResult',
      payload: { ok: false, message: 'TLS certificate is not trusted: self-signed certificate' }
    });
  });

  it('short-circuits the connection test for an invalid url without invoking the tester', async () => {
    const postMessage = vi.fn();
    const testConnection = vi.fn();

    await handleInstanceFormMessage(
      { type: 'testConnection', payload: { url: 'not-a-url' } },
      undefined,
      { createInstance: vi.fn(), updateInstance: vi.fn() } as never,
      vi.fn(),
      { dispose: vi.fn(), webview: { postMessage } } as never,
      { testConnection }
    );

    expect(testConnection).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'connectionTestResult',
      payload: { ok: false, message: expect.stringContaining('valid Grafana URL') }
    });
  });

  it('ignores unrelated message types', async () => {
    const handled = await handleInstanceFormMessage(
      { type: 'noop' },
      undefined,
      { createInstance: vi.fn(), updateInstance: vi.fn() } as never,
      vi.fn(),
      { dispose: vi.fn(), webview: { postMessage: vi.fn() } } as never
    );

    expect(handled).toBe(false);
  });
});

describe('createTofuConnectionTester (FUNC-02 / UX-01)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A stand-in for GrafanaApiClient.health() that behaves like the real HTTPS
   * path: it asks the injected verifier about a fingerprint and throws the
   * same classified `tls` error GrafanaHttpClient throws on rejection.
   */
  function fakeHealthClientFactory(fingerprint: string) {
    return (_url: string, _token: string | undefined, certVerifier: GrafanaCertVerifier) => ({
      health: async () => {
        const trusted = await certVerifier.verify('grafana.example.com', 443, fingerprint);
        if (!trusted) {
          throw new GrafanaApiError('tls', 'certificate was rejected by the certificate verifier');
        }
        return { ok: true as const };
      }
    });
  }

  it('succeeds without prompting when the fingerprint is already trusted in the store', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    await store.trust('grafana.example.com', 443, 'SHA256:abc');
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const test = createTofuConnectionTester(store, fakeHealthClientFactory('SHA256:abc'));

    await expect(test('https://grafana.example.com', 'glsa_x')).resolves.toEqual({ ok: true });
    expect(showWarningMessage).not.toHaveBeenCalled();
  });

  it('prompts trust-on-first-use for an unknown fingerprint and succeeds when the user accepts', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    // The interactive verifier's accept button is the first message item.
    const showWarningMessage = vi
      .spyOn(vscode.window, 'showWarningMessage')
      .mockImplementation(async (_message: string, ...rest: unknown[]) => {
        const items = rest.filter((item): item is string => typeof item === 'string');
        return items[0] as never;
      });
    const test = createTofuConnectionTester(store, fakeHealthClientFactory('SHA256:new'));

    await expect(test('https://grafana.example.com', 'glsa_x')).resolves.toEqual({ ok: true });
    expect(showWarningMessage).toHaveBeenCalledOnce();
    expect(store.getTrusted('grafana.example.com', 443)?.fingerprint).toBe('SHA256:new');
  });

  it('reports a tls failure when the user rejects the trust prompt', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    const test = createTofuConnectionTester(store, fakeHealthClientFactory('SHA256:new'));

    const result = await test('https://grafana.example.com', 'glsa_x');

    expect(result).toMatchObject({ ok: false, reason: 'tls' });
    expect(store.getTrusted('grafana.example.com', 443)).toBeUndefined();
  });

  it('maps classified auth and network errors onto the form result reasons', async () => {
    const store = new GrafanaCertTrustStore(new MemoryMemento());
    const failWith = (error: Error) =>
      createTofuConnectionTester(store, () => ({
        health: async () => {
          throw error;
        }
      }));

    await expect(failWith(new GrafanaApiError('auth', 'token rejected', 401))('https://g', 't')).resolves.toMatchObject({
      ok: false,
      reason: 'auth'
    });
    await expect(failWith(new GrafanaApiError('network', 'unreachable'))('https://g', 't')).resolves.toMatchObject({
      ok: false,
      reason: 'network'
    });
    await expect(failWith(new Error('boom'))('https://g', 't')).resolves.toMatchObject({
      ok: false,
      reason: 'error',
      message: 'boom'
    });
  });
});
