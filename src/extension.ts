import * as vscode from 'vscode';
import { GrafanaAgentToolService } from './agent/GrafanaAgentToolService';
import { GrafanaInstanceConfigManager } from './config/GrafanaInstanceConfigManager';
import type { GrafanaInstanceConfig } from './config/schema';
import { GrafanaApiClient } from './grafana/GrafanaApiClient';
import { GrafanaCertTrustStore } from './grafana/GrafanaCertTrustStore';
import { BridgeServer } from './mcp/BridgeServer';
import { detectHostApp } from './mcp/hostApp';
import { syncPackagedHub } from './mcp/hubSync';
import { ensureAtSeriesConfigForCurrentIde, uninstallAtSeriesConfigForCurrentIde } from './mcp/McpConfigInstaller';
import { AlertTreeProvider } from './tree/AlertTreeProvider';
import { DashboardTreeProvider } from './tree/DashboardTreeProvider';
import type { GrafanaTreeItem } from './tree/GrafanaTreeItems';
import { formatError } from './utils/errors';
import { showTimedNotification } from './utils/notifications';
import { AlertDetailPanel } from './webview/AlertDetailPanel';
import { DashboardPanel } from './webview/DashboardPanel';
import { GrafanaEmbedProxy } from './webview/GrafanaEmbedProxy';
import { GrafanaInstanceFormPanel } from './webview/GrafanaInstanceFormPanel';

/** Arguments shape already wired by DashboardTreeItem/AlertRuleTreeItem's `command.arguments` (see GrafanaTreeItems.ts). */
interface OpenGrafanaEmbedArgs {
  instanceId?: string;
  uid?: string;
  title?: string;
}

let extensionCleanup: { dispose(): void } | undefined;

/**
 * Fresh GrafanaApiClient per call (not cached across edits) so a token/URL
 * rotation via the instance form is picked up on the very next tree refresh
 * instead of silently reusing stale credentials. The tree providers own the
 * (cheap) caching of fetched dashboard/alert data, not client instances.
 */
function createGrafanaClient(
  configManager: Pick<GrafanaInstanceConfigManager, 'getToken'>,
  instance: GrafanaInstanceConfig
): Promise<GrafanaApiClient> {
  return configManager.getToken(instance.id).then((token) => {
    if (!token) {
      throw new Error(`No Service Account Token is configured for "${instance.label}". Edit the instance to add one.`);
    }
    return new GrafanaApiClient({ baseUrl: instance.url, token });
  });
}

/**
 * Phase 1: adds Grafana instance configuration (SecretStorage-backed token,
 * add/edit/delete via command palette). Phase 3 adds the dashboard/alert
 * tree views below. Dashboard/alert webviews land in Phase 4 (see
 * docs/plans/2026-07-29-at-grafana-v1-implementation-plan.md).
 */
export function activate(context: vscode.ExtensionContext): void {
  const configManager = new GrafanaInstanceConfigManager(context.globalState, context.secrets);
  const certTrustStore = new GrafanaCertTrustStore(context.globalState);
  // Task 4.1's http.Server only binds on the first Webview panel open
  // (DashboardPanel/AlertDetailPanel call proxy.start(), itself idempotent)
  // — not eagerly here — per ADR-003's "not always-on" framing.
  const grafanaEmbedProxy = new GrafanaEmbedProxy({ configManager, certTrustStore });
  const dashboardTreeProvider = new DashboardTreeProvider(configManager, (instance) =>
    createGrafanaClient(configManager, instance)
  );
  const alertTreeProvider = new AlertTreeProvider(configManager, (instance) => createGrafanaClient(configManager, instance));
  const refreshTreeViews = (): void => {
    dashboardTreeProvider.refresh();
    alertTreeProvider.refresh();
  };
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

  // Reuses the same configManager/certTrustStore constructed above (not a
  // second GrafanaCertTrustStore instance) so a certificate trusted via one
  // surface (e.g. a Webview panel) is immediately recognized by Agent tool
  // calls too, and vice versa.
  const grafanaAgentToolService = new GrafanaAgentToolService({
    configManager,
    certTrustStore,
    createClient: (baseUrl, token, certVerifier) => new GrafanaApiClient({ baseUrl, token, certVerifier })
  });

  const bridgeServer = new BridgeServer({
    hostApp,
    pluginVersion:
      typeof context.extension?.packageJSON?.version === 'string' ? context.extension.packageJSON.version : undefined,
    toolService: grafanaAgentToolService
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
    GrafanaInstanceFormPanel.open(context, configManager, refreshTreeViews)
  );

  const manageInstancesCommand = vscode.commands.registerCommand('atGrafana.manageInstances', async () => {
    await manageInstances(context, configManager, refreshTreeViews);
  });

  const dashboardTreeView = vscode.window.createTreeView<GrafanaTreeItem>('atGrafana.dashboards', {
    treeDataProvider: dashboardTreeProvider
  });
  dashboardTreeProvider.attachTreeView(dashboardTreeView);
  const alertTreeView = vscode.window.registerTreeDataProvider<GrafanaTreeItem>('atGrafana.alerts', alertTreeProvider);

  const refreshDashboardsCommand = vscode.commands.registerCommand('atGrafana.refreshDashboards', () => {
    dashboardTreeProvider.refresh();
  });
  const refreshAlertsCommand = vscode.commands.registerCommand('atGrafana.refreshAlerts', () => {
    alertTreeProvider.refresh();
  });
  const filterDashboardsCommand = vscode.commands.registerCommand('atGrafana.filterDashboards', async () => {
    const value = await vscode.window.showInputBox({
      prompt: 'Filter dashboards by title',
      placeHolder: 'e.g. api-latency',
      value: dashboardTreeProvider.getFilter() ?? ''
    });
    if (value !== undefined) {
      dashboardTreeProvider.setFilter(value);
    }
  });
  const clearDashboardFilterCommand = vscode.commands.registerCommand('atGrafana.clearDashboardFilter', () => {
    dashboardTreeProvider.clearFilter();
  });

  const openDashboardCommand = vscode.commands.registerCommand(
    'atGrafana.openDashboard',
    async (args?: OpenGrafanaEmbedArgs) => {
      await DashboardPanel.open(context, grafanaEmbedProxy, args?.instanceId ?? '', args?.uid ?? '', args?.title ?? 'Dashboard');
    }
  );
  const openAlertRuleCommand = vscode.commands.registerCommand(
    'atGrafana.openAlertRule',
    async (args?: OpenGrafanaEmbedArgs) => {
      await AlertDetailPanel.open(context, grafanaEmbedProxy, args?.instanceId ?? '', args?.uid ?? '', args?.title ?? 'Alert Rule');
    }
  );

  context.subscriptions.push(
    bridgeServer,
    grafanaEmbedProxy,
    installMcpConfigCommand,
    uninstallMcpConfigCommand,
    addInstanceCommand,
    manageInstancesCommand,
    dashboardTreeView,
    alertTreeView,
    refreshDashboardsCommand,
    refreshAlertsCommand,
    filterDashboardsCommand,
    clearDashboardFilterCommand,
    openDashboardCommand,
    openAlertRuleCommand,
    cleanup
  );
}

async function manageInstances(
  context: vscode.ExtensionContext,
  configManager: GrafanaInstanceConfigManager,
  onChanged: () => void
): Promise<void> {
  const instances = await configManager.listInstances();
  if (instances.length === 0) {
    const answer = await vscode.window.showInformationMessage(
      'No Grafana instances configured yet.',
      'Add Instance'
    );
    if (answer === 'Add Instance') {
      await GrafanaInstanceFormPanel.open(context, configManager, onChanged);
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
    await GrafanaInstanceFormPanel.open(context, configManager, onChanged, picked.instance);
    return;
  }
  if (action === 'Delete') {
    await deleteInstanceWithConfirmation(configManager, picked.instance, onChanged);
  }
}

async function deleteInstanceWithConfirmation(
  configManager: GrafanaInstanceConfigManager,
  instance: GrafanaInstanceConfig,
  onChanged: () => void
): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    `Delete Grafana instance "${instance.label}"?`,
    { modal: true },
    'Delete'
  );
  if (answer === 'Delete') {
    await configManager.deleteInstance(instance.id);
    onChanged();
  }
}

export function deactivate(): void {
  extensionCleanup?.dispose();
}
