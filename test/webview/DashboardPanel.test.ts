import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { DashboardEmbedProxy } from '../../src/webview/DashboardPanel';
import { DashboardPanel } from '../../src/webview/DashboardPanel';

function fakeContext(): vscode.ExtensionContext {
  return { subscriptions: [] } as unknown as vscode.ExtensionContext;
}

function fakeProxy(overrides: Partial<DashboardEmbedProxy> = {}): DashboardEmbedProxy {
  const origin = 'origin' in overrides ? overrides.origin : 'http://127.0.0.1:54321';
  return {
    origin,
    start: vi.fn(async () => undefined),
    buildDashboardUrl: vi.fn((instanceId: string, uid: string) => `${origin}/instances/${instanceId}/d/${uid}`),
    ...overrides
  };
}

describe('DashboardPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an iframe pointed at the proxy origin with a CSP restricted to that origin', async () => {
    const proxy = fakeProxy();
    const createWebviewPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');

    await DashboardPanel.open(fakeContext(), proxy, 'instance-1', 'uid-1', 'My Dashboard');

    expect(createWebviewPanelSpy).toHaveBeenCalledTimes(1);
    const panel = createWebviewPanelSpy.mock.results[0]?.value;
    expect(panel.webview.html).toContain('frame-src http://127.0.0.1:54321');
    expect(panel.webview.html).toContain('http://127.0.0.1:54321/instances/instance-1/d/uid-1');
  });

  it('never leaks a real Grafana origin or a Bearer token into the generated HTML', async () => {
    const proxy = fakeProxy({
      buildDashboardUrl: vi.fn(
        (instanceId: string, uid: string) => `http://127.0.0.1:54321/instances/${instanceId}/d/${uid}`
      )
    });
    const createWebviewPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');

    await DashboardPanel.open(fakeContext(), proxy, 'instance-2', 'uid-2', 'Secret Dashboard');

    const panel = createWebviewPanelSpy.mock.results[0]?.value;
    expect(panel.webview.html).not.toContain('grafana.example.com');
    expect(panel.webview.html).not.toContain('glsa_');
    expect(panel.webview.html.toLowerCase()).not.toContain('bearer');
    expect(panel.webview.html.toLowerCase()).not.toContain('authorization');
  });

  it('reveals an already-open panel instead of creating a duplicate for the same instance+uid', async () => {
    const proxy = fakeProxy();
    const createWebviewPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');

    await DashboardPanel.open(fakeContext(), proxy, 'instance-3', 'uid-3', 'Dup Dashboard');
    const panel = createWebviewPanelSpy.mock.results[0]?.value;
    const revealSpy = vi.spyOn(panel, 'reveal');

    await DashboardPanel.open(fakeContext(), proxy, 'instance-3', 'uid-3', 'Dup Dashboard');

    expect(createWebviewPanelSpy).toHaveBeenCalledTimes(1);
    expect(revealSpy).toHaveBeenCalledTimes(1);
  });

  it('opens a fresh panel once the previous one for the same key has been disposed', async () => {
    const proxy = fakeProxy();
    const createWebviewPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');

    await DashboardPanel.open(fakeContext(), proxy, 'instance-4', 'uid-4', 'Dash');
    const panel = createWebviewPanelSpy.mock.results[0]?.value;
    panel.dispose();

    await DashboardPanel.open(fakeContext(), proxy, 'instance-4', 'uid-4', 'Dash');

    expect(createWebviewPanelSpy).toHaveBeenCalledTimes(2);
  });

  it('shows an error and creates no panel when instanceId or uid is missing', async () => {
    const proxy = fakeProxy();
    const createWebviewPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

    await DashboardPanel.open(fakeContext(), proxy, '', 'uid-5', 'Dash');

    expect(createWebviewPanelSpy).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledOnce();
  });

  it('shows an error and creates no panel when the proxy fails to start', async () => {
    const proxy = fakeProxy({
      start: vi.fn(async () => {
        throw new Error('EADDRINUSE');
      })
    });
    const createWebviewPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

    await DashboardPanel.open(fakeContext(), proxy, 'instance-6', 'uid-6', 'Dash');

    expect(createWebviewPanelSpy).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('EADDRINUSE'));
  });

  it('shows an error and creates no panel when the proxy reports no origin after starting', async () => {
    const proxy = fakeProxy({ origin: undefined });
    const createWebviewPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

    await DashboardPanel.open(fakeContext(), proxy, 'instance-8', 'uid-8', 'Dash');

    expect(createWebviewPanelSpy).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledOnce();
  });

  it('adds the created panel to context.subscriptions', async () => {
    const proxy = fakeProxy();
    const context = fakeContext();

    await DashboardPanel.open(context, proxy, 'instance-7', 'uid-7', 'Dash');

    expect(context.subscriptions.length).toBeGreaterThan(0);
  });
});
