import * as vscode from 'vscode';
import { GrafanaAgentToolService } from './agent/GrafanaAgentToolService';
import { GrafanaInstanceConfigManager } from './config/GrafanaInstanceConfigManager';
import type { GrafanaInstanceConfig } from './config/schema';
import { GrafanaApiClient } from './grafana/GrafanaApiClient';
import { GrafanaCertTrustStore } from './grafana/GrafanaCertTrustStore';
import { createInteractiveCertVerifier } from './grafana/createInteractiveCertVerifier';
import { ensureGrafanaTlsTrust } from './grafana/ensureGrafanaTlsTrust';
import { BridgeServer } from './mcp/BridgeServer';
import { syncPackagedHub } from './mcp/hubSync';
import { ensureAtSeriesConfigForCurrentIde, uninstallAtSeriesConfigForCurrentIde } from './mcp/McpConfigInstaller';
import { detectHostApp } from '@at-series/mcp-hub';
import { AlertTreeProvider } from './tree/AlertTreeProvider';
import { DashboardTreeProvider } from './tree/DashboardTreeProvider';
import type { GrafanaTreeItem } from './tree/GrafanaTreeItems';
import { formatError } from './utils/errors';
import { createRedactedLog, type AtGrafanaLog } from './utils/logger';
import { showTimedNotification } from './utils/notifications';
import { AlertDetailPanel } from './webview/AlertDetailPanel';
import { DashboardPanel } from './webview/DashboardPanel';
import { GrafanaEmbedProxy } from './webview/GrafanaEmbedProxy';
import { GrafanaInstanceFormPanel } from './webview/GrafanaInstanceFormPanel';
import { disposeOpenPanels } from './webview/openPanels';
import { t } from './i18n/t';

/** Arguments shape already wired by DashboardTreeItem/AlertRuleTreeItem's `command.arguments` (see GrafanaTreeItems.ts). */
interface OpenGrafanaEmbedArgs {
  instanceId?: string;
  uid?: string;
  title?: string;
  slug?: string;
  search?: string;
}

let extensionCleanup: { dispose(): Promise<void> } | undefined;

/**
 * Fresh GrafanaApiClient per call (not cached across edits) so a token/URL
 * rotation via the instance form is picked up on the very next tree refresh
 * instead of silently reusing stale credentials. The tree providers own the
 * (cheap) caching of fetched dashboard/alert data, not client instances.
 */
function createGrafanaClient(
  configManager: Pick<GrafanaInstanceConfigManager, 'getToken'>,
  instance: GrafanaInstanceConfig,
  certTrustStore: GrafanaCertTrustStore,
  log: AtGrafanaLog
): Promise<GrafanaApiClient> {
  return configManager.getToken(instance.id).then((token) => {
    if (!token) {
      throw new Error(
        t('No Service Account Token is configured for "{label}". Edit the instance to add one.', {
          label: instance.label
        })
      );
    }
    return new GrafanaApiClient({
      baseUrl: instance.url,
      token,
      certVerifier: createInteractiveCertVerifier(certTrustStore),
      log
    });
  });
}


/**
 * Phase 1: adds Grafana instance configuration (SecretStorage-backed token,
 * add/edit/delete via command palette). Phase 3 adds the dashboard/alert
 * tree views below. Dashboard/alert webviews land in Phase 4 (see
 * docs/plans/2026-07-29-at-grafana-v1-implementation-plan.md).
 */
export function activate(context: vscode.ExtensionContext): void {
  // A `LogOutputChannel` rather than a plain one: VS Code then owns the level
  // (Output panel gear / `Developer: Set Log Level...`) and stamps each line,
  // so the extension contributes no setting of its own for it. Everything
  // below writes through `createRedactedLog`, which is the only thing allowed
  // to hand text to this channel -- see src/utils/logger.ts.
  const logChannel = vscode.window.createOutputChannel('AT Grafana', { log: true });
  const log = createRedactedLog(logChannel);

  const configManager = new GrafanaInstanceConfigManager(context.globalState, context.secrets);
  const certTrustStore = new GrafanaCertTrustStore(context.globalState, log);
  // Task 4.1's http.Server only binds on the first Webview panel open
  // (DashboardPanel/AlertDetailPanel call proxy.start(), itself idempotent)
  // — not eagerly here — per ADR-003's "not always-on" framing.
  const grafanaEmbedProxy = new GrafanaEmbedProxy({ configManager, certTrustStore, log });
  const dashboardTreeProvider = new DashboardTreeProvider(configManager, (instance) =>
    createGrafanaClient(configManager, instance, certTrustStore, log)
  );
  const alertTreeProvider = new AlertTreeProvider(configManager, (instance) =>
    createGrafanaClient(configManager, instance, certTrustStore, log)
  );
  const refreshTreeViews = (): void => {
    dashboardTreeProvider.refresh();
    alertTreeProvider.refresh();
  };
  // MCP activate order: detectHostApp → syncPackagedHub → BridgeServer.start (publish) →
  // ensureAtSeriesConfig → install/uninstall commands. Shutdown (via `deactivate`
  // below) only unpublishes; never uninstalls MCP config or deletes hub.js.
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
      log.info(`hub-sync: ok (updated=${result.updated}, active=${result.activeVersion})`);
      return result;
    })
    .catch((error) => {
      log.error(`hub-sync: failed: ${formatError(error)}`);
      void showTimedNotification(
        t('AT Series hub sync failed: {message}. MCP may not start until Repair succeeds.', {
          message: formatError(error)
        }),
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
    log,
    createClient: (baseUrl, token, certVerifier) => new GrafanaApiClient({ baseUrl, token, certVerifier, log }),
    // Task 6.1: read live each call (not cached) so editing
    // atGrafana.queryLimits.* takes effect on the next grafana_query_datasource
    // call without a reload -- see GrafanaAgentToolServiceDependencies's doc.
    getQueryLimitsConfig: () => {
      const config = vscode.workspace.getConfiguration('atGrafana');
      return {
        maxRangeMs: config.get<number>('queryLimits.maxRangeMs'),
        maxResponseBytes: config.get<number>('queryLimits.maxResponseBytes')
      };
    }
  });

  const bridgeServer = new BridgeServer({
    hostApp,
    pluginVersion:
      typeof context.extension?.packageJSON?.version === 'string' ? context.extension.packageJSON.version : undefined,
    toolService: grafanaAgentToolService,
    log
  });
  void bridgeServer.start().catch((error) => {
    log.error(`bridge: failed to start: ${formatError(error)}`);
    void showTimedNotification(
      t('AT Grafana MCP bridge failed to start: {message}', { message: formatError(error) }),
      'warning'
    );
  });

  void hubReady
    .then(() => ensureAtSeriesConfigForCurrentIde({ ...hostEnv, workspaceFolder: currentWorkspaceFolder() }))
    .catch((error) => {
      log.error(`mcp-config: could not be updated: ${formatError(error)}`);
      void showTimedNotification(
        t('AT Series MCP config could not be updated: {message}', { message: formatError(error) }),
        'warning'
      );
    });

  const installMcpConfigCommand = vscode.commands.registerCommand('atGrafana.installMcpConfig', async () => {
    try {
      await syncPackagedHub(context);
    } catch (error) {
      showTimedNotification(t('AT Series hub sync failed: {message}', { message: formatError(error) }), 'error');
      return;
    }
    const result = await ensureAtSeriesConfigForCurrentIde({ ...hostEnv, workspaceFolder: currentWorkspaceFolder() });
    if (result) {
      showTimedNotification(
        result.updated ? t('AT Series MCP config installed/repaired.') : t('AT Series MCP config is already up to date.')
      );
      return;
    }
    showTimedNotification(
      t('No supported IDE MCP config target was detected. Open a workspace to install Continue config.'),
      'warning'
    );
  });

  const uninstallMcpConfigCommand = vscode.commands.registerCommand('atGrafana.uninstallAtSeriesMcpConfig', async () => {
    const result = await uninstallAtSeriesConfigForCurrentIde({ ...hostEnv, workspaceFolder: currentWorkspaceFolder() });
    if (result?.removed) {
      showTimedNotification(t('AT Series MCP config uninstalled.'));
      return;
    }
    if (result) {
      showTimedNotification(t('AT Series MCP config was not present.'));
      return;
    }
    showTimedNotification(
      t('No supported IDE MCP config target was detected. Open a workspace to uninstall Continue config.'),
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
      prompt: t('Filter dashboards by title'),
      placeHolder: t('e.g. api-latency'),
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
      await openGrafanaEmbedPanel(
        configManager,
        certTrustStore,
        args?.instanceId ?? '',
        args?.uid ?? '',
        args?.title ?? t('Dashboard'),
        (instanceId, uid, title, slug, search) =>
          DashboardPanel.open(grafanaEmbedProxy, instanceId, uid, title, slug, search),
        args?.slug,
        args?.search
      );
    }
  );
  const openAlertRuleCommand = vscode.commands.registerCommand(
    'atGrafana.openAlertRule',
    async (args?: OpenGrafanaEmbedArgs) => {
      await openGrafanaEmbedPanel(
        configManager,
        certTrustStore,
        args?.instanceId ?? '',
        args?.uid ?? '',
        args?.title ?? t('Alert Rule'),
        (instanceId, uid, title) => AlertDetailPanel.open(grafanaEmbedProxy, instanceId, uid, title)
      );
    }
  );

  // VS Code awaits the promise `deactivate()` returns. It does NOT await the
  // `dispose()` of anything in `context.subscriptions` -- it calls each one and
  // moves on. Both `BridgeServer.dispose` and `GrafanaEmbedProxy.dispose` are
  // async and both finish work that has to actually complete: the bridge
  // unpublishes its `~/.at-series` registry record, the proxy closes a
  // listening socket. Registered as subscriptions they were fire-and-forget, so
  // a shutdown could strand a registry entry pointing at a dead port -- which
  // the Hub then pays a failed connection for on every later refresh. Hence
  // they are awaited here instead of pushed below.
  let disposed = false;
  const cleanup = {
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      if (extensionCleanup === cleanup) {
        extensionCleanup = undefined;
      }
      // Synchronous, and first: closing webview panels must not be delayed by
      // -- or lost to -- a slow or failing async shutdown below.
      disposeOpenPanels();
      const outcomes = await Promise.allSettled([bridgeServer.dispose(), grafanaEmbedProxy.dispose()]);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          // One failed shutdown step must not skip the others, and must not
          // reject out of `deactivate` -- VS Code would report the extension
          // as failing to deactivate over a best-effort cleanup.
          log.error(`deactivate: a shutdown step failed: ${formatError(outcome.reason)}`);
        }
      }
    }
  };
  extensionCleanup = cleanup;

  context.subscriptions.push(
    logChannel,
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
    openAlertRuleCommand
  );
}

async function openGrafanaEmbedPanel(
  configManager: Pick<GrafanaInstanceConfigManager, 'getInstance' | 'getToken'>,
  certTrustStore: GrafanaCertTrustStore,
  instanceId: string,
  uid: string,
  title: string,
  openPanel: (instanceId: string, uid: string, title: string, slug?: string, search?: string) => Promise<void>,
  slug?: string,
  search?: string
): Promise<void> {
  if (!instanceId || !uid) {
    await openPanel(instanceId, uid, title, slug, search);
    return;
  }

  const instance = await configManager.getInstance(instanceId);
  if (!instance) {
    await vscode.window.showErrorMessage(t('Cannot open "{title}": unknown Grafana instance.', { title }));
    return;
  }

  const token = await configManager.getToken(instanceId);
  if (!token) {
    await vscode.window.showErrorMessage(
      t('Cannot open "{title}": no Service Account Token is configured for "{label}".', {
        title,
        label: instance.label
      })
    );
    return;
  }

  const trust = await ensureGrafanaTlsTrust(instance.url, token, certTrustStore);
  if (!trust.ok) {
    await vscode.window.showErrorMessage(t('Cannot open "{title}": {message}', { title, message: trust.message }));
    return;
  }

  await openPanel(instanceId, uid, title, slug, search);
}

async function manageInstances(
  context: vscode.ExtensionContext,
  configManager: GrafanaInstanceConfigManager,
  onChanged: () => void
): Promise<void> {
  const instances = await configManager.listInstances();
  if (instances.length === 0) {
    const answer = await vscode.window.showInformationMessage(
      t('No Grafana instances configured yet.'),
      t('Add Instance')
    );
    if (answer === t('Add Instance')) {
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
    { placeHolder: t('Select a Grafana instance to edit or delete') }
  );
  if (!picked) {
    return;
  }

  const action = await vscode.window.showQuickPick([t('Edit'), t('Delete')], {
    placeHolder: `${picked.instance.label}`
  });
  if (action === t('Edit')) {
    await GrafanaInstanceFormPanel.open(context, configManager, onChanged, picked.instance);
    return;
  }
  if (action === t('Delete')) {
    await deleteInstanceWithConfirmation(configManager, picked.instance, onChanged);
  }
}

async function deleteInstanceWithConfirmation(
  configManager: GrafanaInstanceConfigManager,
  instance: GrafanaInstanceConfig,
  onChanged: () => void
): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    t('Delete Grafana instance "{label}"?', { label: instance.label }),
    { modal: true },
    t('Delete')
  );
  if (answer === t('Delete')) {
    await configManager.deleteInstance(instance.id);
    onChanged();
  }
}


/** Async because VS Code awaits what this returns; see the `cleanup` doc in `activate`. */
export async function deactivate(): Promise<void> {
  await extensionCleanup?.dispose();
}
