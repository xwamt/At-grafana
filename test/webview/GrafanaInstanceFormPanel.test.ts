import { describe, expect, it, vi } from 'vitest';
import type { GrafanaInstanceConfig } from '../../src/config/schema';
import { handleInstanceFormMessage } from '../../src/webview/GrafanaInstanceFormPanel';

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
