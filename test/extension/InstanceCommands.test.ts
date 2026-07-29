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

function extensionContext(): vscode.ExtensionContext {
  const globalStorage = new Map<string, unknown>();
  const secretStorage = new Map<string, string>();
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

describe('atGrafana instance commands', () => {
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

  beforeEach(() => {
    deactivate();
    registeredCommands.clear();
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((name: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(name, handler);
      return { dispose: vi.fn() };
    });
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
  });

  afterEach(() => {
    deactivate();
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
});
