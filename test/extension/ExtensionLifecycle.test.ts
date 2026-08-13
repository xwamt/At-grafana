import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  bridgeDispose: vi.fn(async () => undefined),
  bridgeStart: vi.fn(async () => undefined),
  proxyDispose: vi.fn(async () => undefined),
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

vi.mock('../../src/webview/GrafanaEmbedProxy', () => ({
  GrafanaEmbedProxy: class {
    dispose = mocks.proxyDispose;
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
import { trackOpenPanel } from '../../src/webview/openPanels';

function extensionContext(): vscode.ExtensionContext {
  const globalStorage = new Map<string, unknown>();
  return {
    extensionUri: vscode.Uri.file('C:/Users/alan/.cursor/extensions/local.at-grafana-0.1.0'),
    globalStorageUri: vscode.Uri.file('C:/tmp/at-grafana-storage'),
    globalState: {
      get: vi.fn((key: string, defaultValue: unknown) => (globalStorage.has(key) ? globalStorage.get(key) : defaultValue)),
      update: vi.fn(async (key: string, value: unknown) => {
        globalStorage.set(key, value);
      })
    },
    secrets: {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => undefined)
    },
    subscriptions: []
  } as unknown as vscode.ExtensionContext;
}

/** Resolves on a later macrotask, so "did deactivate wait for this?" has a real answer. */
function slowDispose(record: () => void): () => Promise<undefined> {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    record();
    return undefined;
  };
}

function fakePanel(onDispose: () => void): vscode.WebviewPanel {
  const listeners: Array<() => void> = [];
  return {
    reveal: () => undefined,
    dispose: () => {
      onDispose();
      for (const listener of [...listeners]) {
        listener();
      }
    },
    onDidDispose: (listener: () => void) => {
      listeners.push(listener);
      return { dispose: () => undefined };
    }
  } as unknown as vscode.WebviewPanel;
}

describe('atGrafana extension lifecycle', () => {
  beforeEach(async () => {
    await deactivate();
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation(() => ({ dispose: vi.fn() }));
  });

  afterEach(async () => {
    await deactivate();
    vi.clearAllMocks();
  });

  it('waits for the bridge to finish unpublishing before deactivate resolves', async () => {
    const finished: string[] = [];
    mocks.bridgeDispose.mockImplementationOnce(slowDispose(() => finished.push('bridge')));
    activate(extensionContext());

    await deactivate();

    expect(finished).toEqual(['bridge']);
  });

  it('waits for the embed proxy to finish closing before deactivate resolves', async () => {
    const finished: string[] = [];
    mocks.proxyDispose.mockImplementationOnce(slowDispose(() => finished.push('proxy')));
    activate(extensionContext());

    await deactivate();

    expect(finished).toEqual(['proxy']);
  });

  it('keeps the async-disposing bridge and proxy out of context.subscriptions, which VS Code never awaits', () => {
    const context = extensionContext();

    activate(context);

    const disposers = context.subscriptions.map((sub) => (sub as { dispose?: unknown }).dispose);
    expect(disposers).not.toContain(mocks.bridgeDispose);
    expect(disposers).not.toContain(mocks.proxyDispose);
  });

  it('closes open panels before it starts waiting on the slower async disposals', async () => {
    const order: string[] = [];
    mocks.bridgeDispose.mockImplementationOnce(slowDispose(() => order.push('bridge')));
    mocks.proxyDispose.mockImplementationOnce(slowDispose(() => order.push('proxy')));
    activate(extensionContext());
    trackOpenPanel('dashboard:lifecycle', fakePanel(() => order.push('panel')));

    await deactivate();

    expect(order[0]).toBe('panel');
    expect(order).toHaveLength(3);
  });

  it('disposes each collaborator once even if deactivate is called twice', async () => {
    activate(extensionContext());

    await deactivate();
    await deactivate();

    expect(mocks.bridgeDispose).toHaveBeenCalledTimes(1);
    expect(mocks.proxyDispose).toHaveBeenCalledTimes(1);
  });

  it('lets the proxy shut down even when the bridge disposal rejects', async () => {
    mocks.bridgeDispose.mockRejectedValueOnce(new Error('registry file vanished'));
    activate(extensionContext());

    await expect(deactivate()).resolves.toBeUndefined();
    expect(mocks.proxyDispose).toHaveBeenCalledTimes(1);
  });
});
