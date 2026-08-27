import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  bridgeDispose: vi.fn(async () => undefined),
  bridgeStart: vi.fn(async () => undefined),
  ensureAtSeriesConfigForCurrentIde: vi.fn(async () => ({ updated: true })),
  uninstallAtSeriesConfigForCurrentIde: vi.fn(async () => ({ removed: true })),
  syncPackagedHub: vi.fn(async () => ({ updated: false, activeVersion: '0.1.0' }))
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

import { activate, deactivate } from '../../src/extension';
import { DashboardTreeItem } from '../../src/tree/GrafanaTreeItems';
import type { GrafanaInstanceConfig } from '../../src/config/schema';

function instanceConfig(overrides: Partial<GrafanaInstanceConfig> = {}): GrafanaInstanceConfig {
  return {
    id: 'inst-1',
    label: 'Grafana One',
    url: 'https://grafana.example.com',
    allowBackgroundAccess: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

interface ContextSeed {
  instances?: GrafanaInstanceConfig[];
  trustedCerts?: Record<string, { host: string; port: number; fingerprint: string; trustedAt: number }>;
}

function extensionContext(seed: ContextSeed = {}): vscode.ExtensionContext & { __globalStorage: Map<string, unknown> } {
  const globalStorage = new Map<string, unknown>();
  const secretStorage = new Map<string, string>();
  if (seed.instances) {
    globalStorage.set('atGrafana.instances', seed.instances);
    for (const instance of seed.instances) {
      secretStorage.set(`atGrafana.token.${instance.id}`, `token-${instance.id}`);
    }
  }
  if (seed.trustedCerts) {
    globalStorage.set('atGrafana.trustedCertFingerprints', seed.trustedCerts);
  }
  return {
    __globalStorage: globalStorage,
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
  } as unknown as vscode.ExtensionContext & { __globalStorage: Map<string, unknown> };
}

describe('atGrafana instance commands', () => {
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

  beforeEach(async () => {
    await deactivate();
    registeredCommands.clear();
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((name: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(name, handler);
      return { dispose: vi.fn() };
    });
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    // Resolve timed toasts immediately so no 3s delay timer outlives a test.
    vi.spyOn(vscode.window, 'withProgress').mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    await deactivate();
    vi.restoreAllMocks();
  });

  it('registers atGrafana.addInstance and atGrafana.manageInstances', () => {
    activate(extensionContext());

    expect(registeredCommands.has('atGrafana.addInstance')).toBe(true);
    expect(registeredCommands.has('atGrafana.manageInstances')).toBe(true);
  });

  it('manageInstances offers to add an instance when none are configured', async () => {
    activate(extensionContext());
    const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    await registeredCommands.get('atGrafana.manageInstances')?.();

    expect(showInformationMessage).toHaveBeenCalledWith(
      'No Grafana instances configured yet.',
      'Add Instance'
    );
  });

  it('addInstance opens the instance form webview without throwing', async () => {
    activate(extensionContext());

    const handler = registeredCommands.get('atGrafana.addInstance');
    expect(handler).toBeDefined();
    await expect(handler?.()).resolves.toBeUndefined();
  });

  it('registers the tree context-menu and certificate commands', () => {
    activate(extensionContext());

    for (const command of [
      'atGrafana.editInstance',
      'atGrafana.deleteInstance',
      'atGrafana.toggleAgentAccess',
      'atGrafana.openInBrowser',
      'atGrafana.copyGrafanaUrl',
      'atGrafana.forgetTrustedCertificate'
    ]) {
      expect(registeredCommands.has(command), command).toBe(true);
    }
  });

  it('toggleAgentAccess flips allowBackgroundAccess and saves the instance (UX-04)', async () => {
    const context = extensionContext({ instances: [instanceConfig({ allowBackgroundAccess: false })] });
    activate(context);

    await registeredCommands.get('atGrafana.toggleAgentAccess')?.({ instance: { id: 'inst-1' } });

    const saved = context.__globalStorage.get('atGrafana.instances') as GrafanaInstanceConfig[];
    expect(saved).toHaveLength(1);
    expect(saved[0].allowBackgroundAccess).toBe(true);

    await registeredCommands.get('atGrafana.toggleAgentAccess')?.({ instance: { id: 'inst-1' } });
    const savedAgain = context.__globalStorage.get('atGrafana.instances') as GrafanaInstanceConfig[];
    expect(savedAgain[0].allowBackgroundAccess).toBe(false);
  });

  it('deleteInstance asks for confirmation and deletes on Delete (UX-04)', async () => {
    const context = extensionContext({ instances: [instanceConfig()] });
    activate(context);
    const showWarningMessage = vi
      .spyOn(vscode.window, 'showWarningMessage')
      .mockResolvedValue('Delete' as never);

    await registeredCommands.get('atGrafana.deleteInstance')?.({ instance: { id: 'inst-1' } });

    expect(showWarningMessage).toHaveBeenCalledWith(
      'Delete Grafana instance "Grafana One"?',
      { modal: true },
      'Delete'
    );
    expect(context.__globalStorage.get('atGrafana.instances')).toEqual([]);
  });

  it('deleteInstance keeps the instance when the confirmation is dismissed', async () => {
    const context = extensionContext({ instances: [instanceConfig()] });
    activate(context);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);

    await registeredCommands.get('atGrafana.deleteInstance')?.({ instance: { id: 'inst-1' } });

    expect(context.__globalStorage.get('atGrafana.instances')).toHaveLength(1);
  });

  it('copyGrafanaUrl writes the dashboard URL to the clipboard (UX-04)', async () => {
    const context = extensionContext({ instances: [instanceConfig()] });
    activate(context);
    const writeText = vi.spyOn(vscode.env.clipboard, 'writeText').mockResolvedValue(undefined);

    const item = new DashboardTreeItem(instanceConfig(), 'dash-1', 'CPU');
    await registeredCommands.get('atGrafana.copyGrafanaUrl')?.(item);

    expect(writeText).toHaveBeenCalledWith('https://grafana.example.com/d/dash-1');
  });

  it('forgetTrustedCertificate lists host:port entries and forgets the picked one (FUNC-05)', async () => {
    const context = extensionContext({
      trustedCerts: {
        'grafana.example.com:443': {
          host: 'grafana.example.com',
          port: 443,
          fingerprint: 'SHA256:abc',
          trustedAt: 1
        }
      }
    });
    activate(context);
    const showQuickPick = vi
      .spyOn(vscode.window, 'showQuickPick')
      .mockImplementation(async (items: unknown) => (items as unknown[])[0] as never);

    await registeredCommands.get('atGrafana.forgetTrustedCertificate')?.();

    const pickedItems = showQuickPick.mock.calls[0]?.[0] as Array<{ label: string; description?: string }>;
    expect(pickedItems[0].label).toBe('grafana.example.com:443');
    expect(pickedItems[0].description).toBe('SHA256:abc');
    expect(context.__globalStorage.get('atGrafana.trustedCertFingerprints')).toEqual({});
  });

  it('forgetTrustedCertificate with nothing trusted never opens a QuickPick', async () => {
    activate(extensionContext());
    const showQuickPick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);

    await registeredCommands.get('atGrafana.forgetTrustedCertificate')?.();

    expect(showQuickPick).not.toHaveBeenCalled();
  });
});
