import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  bridgeDispose: vi.fn(async () => undefined),
  bridgeStart: vi.fn(async () => undefined),
  ensureAtSeriesConfigForCurrentIde: vi.fn(async () => ({ updated: true })),
  uninstallAtSeriesConfigForCurrentIde: vi.fn(async () => ({ removed: true })),
  syncPackagedHub: vi.fn(async () => ({ updated: false, activeVersion: '0.1.0' })),
  dashboardOpen: vi.fn(async (..._args: unknown[]) => undefined),
  alertOpen: vi.fn(async (..._args: unknown[]) => undefined),
  proxyDispose: vi.fn(async () => undefined),
  ensureGrafanaTlsTrust: vi.fn(async () => ({ ok: true as const }))
}));

vi.mock('../../src/mcp/BridgeServer', () => ({
  BridgeServer: class {
    dispose = mocks.bridgeDispose;
    start = mocks.bridgeStart;
  }
}));

vi.mock('../../src/mcp/hubSync', () => ({
  syncPackagedHub: mocks.syncPackagedHub
}));

vi.mock('../../src/mcp/McpConfigInstaller', () => ({
  ensureAtSeriesConfigForCurrentIde: mocks.ensureAtSeriesConfigForCurrentIde,
  uninstallAtSeriesConfigForCurrentIde: mocks.uninstallAtSeriesConfigForCurrentIde
}));

vi.mock('../../src/webview/DashboardPanel', () => ({
  DashboardPanel: { open: mocks.dashboardOpen }
}));

vi.mock('../../src/webview/AlertDetailPanel', () => ({
  AlertDetailPanel: { open: mocks.alertOpen }
}));

vi.mock('../../src/webview/GrafanaEmbedProxy', () => ({
  GrafanaEmbedProxy: class {
    dispose = mocks.proxyDispose;
  }
}));

vi.mock('../../src/grafana/ensureGrafanaTlsTrust', () => ({
  ensureGrafanaTlsTrust: mocks.ensureGrafanaTlsTrust
}));

import { activate, deactivate } from '../../src/extension';

function extensionContext(): vscode.ExtensionContext {
  const globalStorage = new Map<string, unknown>();
  const secretStorage = new Map<string, string>();
  const instances = [
    {
      id: 'inst-1',
      label: 'Grafana One',
      url: 'http://127.0.0.1:3000',
      allowBackgroundAccess: false,
      createdAt: 1,
      updatedAt: 1
    },
    {
      id: 'inst-2',
      label: 'Grafana Two',
      url: 'http://127.0.0.1:3001',
      allowBackgroundAccess: false,
      createdAt: 1,
      updatedAt: 1
    }
  ];
  globalStorage.set('atGrafana.instances', instances);
  secretStorage.set('atGrafana.token.inst-1', 'token-1');
  secretStorage.set('atGrafana.token.inst-2', 'token-2');
  return {
    extensionUri: vscode.Uri.file('C:/Users/alan/.kiro/extensions/local.at-grafana-0.1.0'),
    globalStorageUri: vscode.Uri.file('C:/tmp/at-grafana-storage'),
    globalState: {
      get: vi.fn((key: string, defaultValue: unknown) => (globalStorage.has(key) ? globalStorage.get(key) : defaultValue)),
      update: vi.fn(async (key: string, value: unknown) => {
        globalStorage.set(key, value);
      })
    },
    secrets: {
      delete: vi.fn(async (key: string) => {
        secretStorage.delete(key);
      }),
      get: vi.fn(async (key: string) => secretStorage.get(key)),
      store: vi.fn(async (key: string, value: string) => {
        secretStorage.set(key, value);
      })
    },
    subscriptions: []
  } as unknown as vscode.ExtensionContext;
}

describe('atGrafana panel commands', () => {
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

  beforeEach(async () => {
    await deactivate();
    registeredCommands.clear();
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((name: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(name, handler);
      return { dispose: vi.fn() };
    });
  });

  afterEach(async () => {
    await deactivate();
    vi.clearAllMocks();
  });

  it('registers atGrafana.openDashboard and atGrafana.openAlertRule', () => {
    activate(extensionContext());

    expect(registeredCommands.has('atGrafana.openDashboard')).toBe(true);
    expect(registeredCommands.has('atGrafana.openAlertRule')).toBe(true);
  });

  it('opens the dashboard panel with the arguments passed by the tree item', async () => {
    activate(extensionContext());

    await registeredCommands.get('atGrafana.openDashboard')?.({
      instanceId: 'inst-1',
      uid: 'uid-1',
      title: 'My Dashboard'
    });

    expect(mocks.dashboardOpen).toHaveBeenCalledWith(
      expect.anything(),
      'inst-1',
      'uid-1',
      'My Dashboard',
      undefined,
      undefined
    );
  });

  it('opens the alert detail panel with the arguments passed by the tree item', async () => {
    activate(extensionContext());

    await registeredCommands.get('atGrafana.openAlertRule')?.({
      instanceId: 'inst-2',
      uid: 'uid-2',
      title: 'High CPU'
    });

    expect(mocks.alertOpen).toHaveBeenCalledWith(expect.anything(), 'inst-2', 'uid-2', 'High CPU');
  });

  it('falls back to empty ids and a default title when invoked without arguments', async () => {
    activate(extensionContext());

    await registeredCommands.get('atGrafana.openDashboard')?.();

    expect(mocks.dashboardOpen).toHaveBeenCalledWith(expect.anything(), '', '', 'Dashboard', undefined, undefined);
  });

  it('passes the same shared GrafanaEmbedProxy instance to both panel types', async () => {
    activate(extensionContext());

    await registeredCommands.get('atGrafana.openDashboard')?.({ instanceId: 'inst-1', uid: 'b', title: 'c' });
    await registeredCommands.get('atGrafana.openAlertRule')?.({ instanceId: 'inst-1', uid: 'b', title: 'c' });

    const dashboardProxyArg = mocks.dashboardOpen.mock.calls[0]?.[0];
    const alertProxyArg = mocks.alertOpen.mock.calls[0]?.[0];
    expect(dashboardProxyArg).toBeDefined();
    expect(dashboardProxyArg).toBe(alertProxyArg);
  });

  it('shuts the shared GrafanaEmbedProxy down through deactivate, which is awaited', async () => {
    const context = extensionContext();

    activate(context);
    await deactivate();

    expect(mocks.proxyDispose).toHaveBeenCalledTimes(1);
  });
});
