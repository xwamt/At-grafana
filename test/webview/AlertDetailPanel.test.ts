import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { AlertDetailEmbedProxy } from '../../src/webview/AlertDetailPanel';
import { AlertDetailPanel } from '../../src/webview/AlertDetailPanel';
import { disposeOpenPanels } from '../../src/webview/openPanels';

function fakeProxy(overrides: Partial<AlertDetailEmbedProxy> = {}): AlertDetailEmbedProxy {
  const origin = 'origin' in overrides ? overrides.origin : 'http://127.0.0.1:54321';
  return {
    origin,
    start: vi.fn(async () => undefined),
    buildAlertRuleUrl: vi.fn(
      (instanceId: string, uid: string) => `${origin}/instances/${instanceId}/alerting/grafana/${uid}/view`
    ),
    ...overrides
  };
}

describe('AlertDetailPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an iframe pointed at the proxy origin with a CSP restricted to that origin', async () => {
    const proxy = fakeProxy();
    const createWebviewPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');

    await AlertDetailPanel.open(proxy, 'instance-1', 'uid-1', 'High CPU');

    expect(createWebviewPanelSpy).toHaveBeenCalledTimes(1);
    const panel = createWebviewPanelSpy.mock.results[0]?.value;
    expect(panel.webview.html).toContain('frame-src http://127.0.0.1:54321');
    expect(panel.webview.html).toContain('http://127.0.0.1:54321/instances/instance-1/alerting/grafana/uid-1/view');
  });

  it('never leaks a real Grafana origin or a Bearer token into the generated HTML', async () => {
    const proxy = fakeProxy({
      buildAlertRuleUrl: vi.fn(
        (instanceId: string, uid: string) => `http://127.0.0.1:54321/instances/${instanceId}/alerting/grafana/${uid}/view`
      )
    });
    const createWebviewPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');

    await AlertDetailPanel.open(proxy, 'instance-2', 'uid-2', 'Secret Alert');

    const panel = createWebviewPanelSpy.mock.results[0]?.value;
    expect(panel.webview.html).not.toContain('grafana.example.com');
    expect(panel.webview.html).not.toContain('glsa_');
    expect(panel.webview.html.toLowerCase()).not.toContain('bearer');
    expect(panel.webview.html.toLowerCase()).not.toContain('authorization');
  });

  it('reveals an already-open panel instead of creating a duplicate for the same instance+uid', async () => {
    const proxy = fakeProxy();
    const createWebviewPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');

    await AlertDetailPanel.open(proxy, 'instance-3', 'uid-3', 'Dup Alert');
    const panel = createWebviewPanelSpy.mock.results[0]?.value;
    const revealSpy = vi.spyOn(panel, 'reveal');

    await AlertDetailPanel.open(proxy, 'instance-3', 'uid-3', 'Dup Alert');

    expect(createWebviewPanelSpy).toHaveBeenCalledTimes(1);
    expect(revealSpy).toHaveBeenCalledTimes(1);
  });

  it('opens a fresh panel once the previous one for the same key has been disposed', async () => {
    const proxy = fakeProxy();
    const createWebviewPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');

    await AlertDetailPanel.open(proxy, 'instance-4', 'uid-4', 'Alert');
    const panel = createWebviewPanelSpy.mock.results[0]?.value;
    panel.dispose();

    await AlertDetailPanel.open(proxy, 'instance-4', 'uid-4', 'Alert');

    expect(createWebviewPanelSpy).toHaveBeenCalledTimes(2);
  });

  it('shows an error and creates no panel when instanceId or uid is missing', async () => {
    const proxy = fakeProxy();
    const createWebviewPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

    await AlertDetailPanel.open(proxy, 'instance-5', '', 'Alert');

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

    await AlertDetailPanel.open(proxy, 'instance-6', 'uid-6', 'Alert');

    expect(createWebviewPanelSpy).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('EADDRINUSE'));
  });

  it('shows an error and creates no panel when the proxy reports no origin after starting', async () => {
    const proxy = fakeProxy({ origin: undefined });
    const createWebviewPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

    await AlertDetailPanel.open(proxy, 'instance-7', 'uid-7', 'Alert');

    expect(createWebviewPanelSpy).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledOnce();
  });

  it('hands the panel to the shared registry so deactivate can close it', async () => {
    const proxy = fakeProxy();
    const createWebviewPanelSpy = vi.spyOn(vscode.window, 'createWebviewPanel');

    await AlertDetailPanel.open(proxy, 'instance-8', 'uid-8', 'Alert');
    const panel = createWebviewPanelSpy.mock.results[0]?.value;
    const disposeSpy = vi.spyOn(panel, 'dispose');
    disposeOpenPanels();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
