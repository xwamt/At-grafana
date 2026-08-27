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

function extensionContext(extensionRoot = 'C:/Users/alan/.kiro/extensions/local.at-grafana-0.1.0'): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file(extensionRoot),
    globalStorageUri: vscode.Uri.file('C:/tmp/at-grafana-storage'),
    globalState: {
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
      update: vi.fn(async () => undefined)
    },
    secrets: {
      delete: vi.fn(async () => undefined),
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => undefined)
    },
    subscriptions: []
  } as unknown as vscode.ExtensionContext;
}

describe('atGrafana MCP config commands', () => {
  const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

  beforeEach(async () => {
    await deactivate();
    registeredCommands.clear();
    mocks.bridgeDispose.mockClear();
    mocks.bridgeStart.mockClear();
    mocks.ensureAtSeriesConfigForCurrentIde.mockClear();
    mocks.uninstallAtSeriesConfigForCurrentIde.mockClear();
    mocks.syncPackagedHub.mockClear();
    delete (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders;
    vi.spyOn(vscode.commands, 'registerCommand').mockImplementation((name: string, handler: (...args: unknown[]) => unknown) => {
      registeredCommands.set(name, handler);
      return { dispose: vi.fn() };
    });
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'withProgress').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await deactivate();
    vi.restoreAllMocks();
  });

  it('ensures AT Series MCP config on activation', async () => {
    activate(extensionContext());

    expect(mocks.syncPackagedHub).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(mocks.ensureAtSeriesConfigForCurrentIde).toHaveBeenCalledWith({
        appName: vscode.env.appName,
        appRoot: vscode.env.appRoot,
        uriScheme: vscode.env.uriScheme,
        extensionPath: 'C:/Users/alan/.kiro/extensions/local.at-grafana-0.1.0',
        workspaceFolder: undefined
      });
    });
  });

  it('install command calls ensure for current IDE', async () => {
    activate(extensionContext());

    await registeredCommands.get('atGrafana.installMcpConfig')?.();

    expect(mocks.ensureAtSeriesConfigForCurrentIde).toHaveBeenCalledWith({
      appName: vscode.env.appName,
      appRoot: vscode.env.appRoot,
      uriScheme: vscode.env.uriScheme,
      extensionPath: 'C:/Users/alan/.kiro/extensions/local.at-grafana-0.1.0',
      workspaceFolder: undefined
    });
  });

  it('uninstall command removes AT Series MCP config', async () => {
    activate(extensionContext('C:/Users/alan/.cursor/extensions/local.at-grafana-0.1.0'));

    await registeredCommands.get('atGrafana.uninstallAtSeriesMcpConfig')?.();

    expect(mocks.uninstallAtSeriesConfigForCurrentIde).toHaveBeenCalledWith({
      appName: vscode.env.appName,
      appRoot: vscode.env.appRoot,
      uriScheme: vscode.env.uriScheme,
      extensionPath: 'C:/Users/alan/.cursor/extensions/local.at-grafana-0.1.0',
      workspaceFolder: undefined
    });
  });

  it('explains that this IDE has no automatic MCP config support when no target exists (UX-03)', async () => {
    // The test host is neither Cursor/Kiro/Continue (vscode.env.appName is
    // undefined in the fixture), so a missing installer target must NOT tell
    // the user to open a workspace for Continue.
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    activate(extensionContext());
    // Let activation's own ensure call settle first, so the queued `undefined`
    // below deterministically belongs to the command invocation.
    await vi.waitFor(() => {
      expect(mocks.ensureAtSeriesConfigForCurrentIde).toHaveBeenCalledTimes(1);
    });
    mocks.ensureAtSeriesConfigForCurrentIde.mockResolvedValueOnce(undefined as never);

    await registeredCommands.get('atGrafana.installMcpConfig')?.();

    expect(showWarningMessage).toHaveBeenCalledWith(
      'Current IDE does not support automatic MCP config install (supported: Cursor, Kiro, Continue).'
    );
  });

  it('uses the uninstall variant of the unsupported-IDE copy (UX-03)', async () => {
    mocks.uninstallAtSeriesConfigForCurrentIde.mockResolvedValueOnce(undefined as never);
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    activate(extensionContext());

    await registeredCommands.get('atGrafana.uninstallAtSeriesMcpConfig')?.();

    expect(showWarningMessage).toHaveBeenCalledWith(
      'Current IDE does not support automatic MCP config uninstall (supported: Cursor, Kiro, Continue).'
    );
  });

  it('shows the one-time toast when activation writes the MCP config for the first time (UX-17)', async () => {
    mocks.ensureAtSeriesConfigForCurrentIde.mockResolvedValueOnce({ updated: true } as never);
    const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const context = extensionContext();

    activate(context);

    await vi.waitFor(() => {
      expect(showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining('installed the AT Series MCP config'),
        expect.any(String)
      );
    });
    expect(context.globalState.update).toHaveBeenCalledWith('atGrafana.mcpConfigNotified', true);
  });

  it('never repeats the first-write toast once the machine has been notified (UX-17)', async () => {
    mocks.ensureAtSeriesConfigForCurrentIde.mockResolvedValueOnce({ updated: true } as never);
    const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const context = extensionContext();
    (context.globalState.get as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string, defaultValue: unknown) => (key === 'atGrafana.mcpConfigNotified' ? true : defaultValue)
    );

    activate(context);

    await vi.waitFor(() => {
      expect(mocks.ensureAtSeriesConfigForCurrentIde).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it('stays silent on activation when the MCP config was already up to date (UX-17)', async () => {
    mocks.ensureAtSeriesConfigForCurrentIde.mockResolvedValueOnce({ updated: false } as never);
    const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    activate(extensionContext());

    await vi.waitFor(() => {
      expect(mocks.ensureAtSeriesConfigForCurrentIde).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(showInformationMessage).not.toHaveBeenCalled();
  });

  it('dispose unpublishes bridge without uninstalling MCP config', async () => {
    const context = extensionContext();
    activate(context);

    mocks.uninstallAtSeriesConfigForCurrentIde.mockClear();
    for (const subscription of [...context.subscriptions].reverse()) {
      await Promise.resolve(subscription.dispose());
    }
    await deactivate();

    expect(mocks.bridgeDispose).toHaveBeenCalled();
    expect(mocks.uninstallAtSeriesConfigForCurrentIde).not.toHaveBeenCalled();
  });
});
