import * as vscode from 'vscode';
import { GrafanaInstanceConfigManager } from './config/GrafanaInstanceConfigManager';
import type { GrafanaInstanceConfig } from './config/schema';
import { BridgeServer } from './mcp/BridgeServer';
import { detectHostApp } from './mcp/hostApp';
import { syncPackagedHub } from './mcp/hubSync';
import { ensureAtSeriesConfigForCurrentIde, uninstallAtSeriesConfigForCurrentIde } from './mcp/McpConfigInstaller';
import { formatError } from './utils/errors';
import { showTimedNotification } from './utils/notifications';
import { GrafanaInstanceFormPanel } from './webview/GrafanaInstanceFormPanel';

let extensionCleanup: { dispose(): void } | undefined;

/**
 * Phase 1: adds Grafana instance configuration (SecretStorage-backed token,
 * add/edit/delete via command palette). Tree views and dashboard/alert
 * webviews are added in later phases (see
 * docs/plans/2026-07-29-at-grafana-v1-implementation-plan.md).
 */
export function activate(context: vscode.ExtensionContext): void {
  const configManager = new GrafanaInstanceConfigManager(context.globalState, context.secrets);
  let disposed = false;
  const cleanup = {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      if (extensionCleanup === cleanup) {
        extensionCleanup = undefined;
      }
    }
  };
  extensionCleanup = cleanup;

  // MCP activate order: detectHostApp → syncPackagedHub → BridgeServer.start (publish) →
  // ensureAtSeriesConfig → install/uninstall commands. Dispose (via BridgeServer in
  // subscriptions) only unpublishes; never uninstalls MCP config or deletes hub.js.
  const hostEnv = {
    appName: vscode.env.appName,
    appRoot: vscode.env.appRoot,
    uriScheme: vscode.env.uriScheme,
    extensionPath: context.extensionUri.fsPath
  };
  const hostApp = detectHostApp(hostEnv);
  const currentWorkspaceFolder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // Await hub sync before writing MCP config so node can resolve ~/.at-series/mcp/hub.js.
  const hubReady = syncPackagedHub(context)
    .then((result) => {
      console.log(`AT Grafana hub sync ok (updated=${result.updated}, active=${result.activeVersion})`);
      return result;
    })
    .catch((error) => {
      console.error('AT Grafana hub sync failed:', formatError(error));
      void showTimedNotification(
        `AT Series hub sync failed: ${formatError(error)}. MCP may not start until Repair succeeds.`,
        'warning'
      );
      throw error;
    });

  const bridgeServer = new BridgeServer({
    hostApp,
    pluginVersion:
      typeof context.extension?.packageJSON?.version === 'string' ? context.extension.packageJSON.version : undefined
  });
  void bridgeServer.start().catch((error) => {
    void showTimedNotification(`AT Grafana MCP bridge failed to start: ${formatError(error)}`, 'warning');
  });

  void hubReady
    .then(() => ensureAtSeriesConfigForCurrentIde({ ...hostEnv, workspaceFolder: currentWorkspaceFolder() }))
    .catch((error) => {
      void showTimedNotification(`AT Series MCP config could not be updated: ${formatError(error)}`, 'warning');
    });

  const installMcpConfigCommand = vscode.commands.registerCommand('atGrafana.installMcpConfig', async () => {
    try {
      await syncPackagedHub(context);
    } catch (error) {
      await showTimedNotification(`AT Series hub sync failed: ${formatError(error)}`, 'error');
      return;
    }
    const result = await ensureAtSeriesConfigForCurrentIde({ ...hostEnv, workspaceFolder: currentWorkspaceFolder() });
    if (result) {
      await showTimedNotification(
        result.updated ? 'AT Series MCP config installed/repaired.' : 'AT Series MCP config is already up to date.'
      );
      return;
    }
    await showTimedNotification(
      'No supported IDE MCP config target was detected. Open a workspace to install Continue config.',
      'warning'
    );
  });

  const uninstallMcpConfigCommand = vscode.commands.registerCommand('atGrafana.uninstallAtSeriesMcpConfig', async () => {
    const result = await uninstallAtSeriesConfigForCurrentIde({ ...hostEnv, workspaceFolder: currentWorkspaceFolder() });
    if (result?.removed) {
      await showTimedNotification('AT Series MCP config uninstalled.');
      return;
    }
    if (result) {
      await showTimedNotification('AT Series MCP config was not present.');
      return;
    }
    await showTimedNotification(
      'No supported IDE MCP config target was detected. Open a workspace to uninstall Continue config.',
      'warning'
    );
  });

  const addInstanceCommand = vscode.commands.registerCommand('atGrafana.addInstance', () =>
    GrafanaInstanceFormPanel.open(context, configManager, () => undefined)
  );

  const manageInstancesCommand = vscode.commands.registerCommand('atGrafana.manageInstances', async () => {
    await manageInstances(context, configManager);
  });

  context.subscriptions.push(
    bridgeServer,
    installMcpConfigCommand,
    uninstallMcpConfigCommand,
    addInstanceCommand,
    manageInstancesCommand,
    cleanup
  );
}

async function manageInstances(
  context: vscode.ExtensionContext,
  configManager: GrafanaInstanceConfigManager
): Promise<void> {
  const instances = await configManager.listInstances();
  if (instances.length === 0) {
    const answer = await vscode.window.showInformationMessage(
      'No Grafana instances configured yet.',
      'Add Instance'
    );
    if (answer === 'Add Instance') {
      await GrafanaInstanceFormPanel.open(context, configManager, () => undefined);
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(
    instances.map((instance) => ({
      label: instance.label,
      description: instance.url,
      instance
    })),
    { placeHolder: 'Select a Grafana instance to edit or delete' }
  );
  if (!picked) {
    return;
  }

  const action = await vscode.window.showQuickPick(['Edit', 'Delete'], {
    placeHolder: `${picked.instance.label}`
  });
  if (action === 'Edit') {
    await GrafanaInstanceFormPanel.open(context, configManager, () => undefined, picked.instance);
    return;
  }
  if (action === 'Delete') {
    await deleteInstanceWithConfirmation(configManager, picked.instance);
  }
}

async function deleteInstanceWithConfirmation(
  configManager: GrafanaInstanceConfigManager,
  instance: GrafanaInstanceConfig
): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    `Delete Grafana instance "${instance.label}"?`,
    { modal: true },
    'Delete'
  );
  if (answer === 'Delete') {
    await configManager.deleteInstance(instance.id);
  }
}

export function deactivate(): void {
  extensionCleanup?.dispose();
}
