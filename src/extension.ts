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
import { SharedGrafanaReads } from './tree/sharedGrafanaReads';
import { AlertRuleTreeItem, DashboardTreeItem, InstanceTreeItem, type GrafanaTreeItem } from './tree/GrafanaTreeItems';
import { formatError } from './utils/errors';
import { createRedactedLog, type AtGrafanaLog } from './utils/logger';
import {
  showFailureNotification,
  showTimedNotification,
  showWarningNotification,
  type NotificationAction
} from './utils/notifications';
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

/** `context.globalState` key: the one-time "MCP config was written" toast has been shown on this machine (UX-17). */
const MCP_CONFIG_NOTIFIED_KEY = 'atGrafana.mcpConfigNotified';

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

  // Shared recovery actions for failure/warning notifications (UX-02): every
  // MCP-related failure can be retried via the install command, and every
  // failure detail lives in the output channel.
  const openLogAction: NotificationAction = { title: t('Open Log'), run: () => logChannel.show(true) };
  const repairMcpAction: NotificationAction = { title: t('Repair MCP Config'), command: 'atGrafana.installMcpConfig' };

  const configManager = new GrafanaInstanceConfigManager(context.globalState, context.secrets);
  const certTrustStore = new GrafanaCertTrustStore(context.globalState, log);
  // Task 4.1's http.Server only binds on the first Webview panel open
  // (DashboardPanel/AlertDetailPanel call proxy.start(), itself idempotent)
  // — not eagerly here — per ADR-003's "not always-on" framing.
  const grafanaEmbedProxy = new GrafanaEmbedProxy({ configManager, certTrustStore, log });
  // One folders-promise cache shared by both trees, so a full refresh fetches
  // `/api/folders` once per instance instead of twice (PERF-04).
  const sharedGrafanaReads = new SharedGrafanaReads();
  const dashboardTreeProvider = new DashboardTreeProvider(
    configManager,
    (instance) => createGrafanaClient(configManager, instance, certTrustStore, log),
    { workspaceState: context.workspaceState, sharedReads: sharedGrafanaReads }
  );
  const alertTreeProvider = new AlertTreeProvider(
    configManager,
    (instance) => createGrafanaClient(configManager, instance, certTrustStore, log),
    {
      sharedReads: sharedGrafanaReads,
      getRefreshIntervalSeconds: () =>
        vscode.workspace.getConfiguration('atGrafana').get<number>('alerts.refreshIntervalSeconds', 0) ?? 0
    }
  );
  const refreshTreeViews = (): void => {
    dashboardTreeProvider.refresh();
    alertTreeProvider.refresh();
    // Form save / instance edits must drop the embed proxy's instance+token
    // cache (PERF-02) so the next dashboard request reads the new SecretStorage
    // token instead of replaying a rotated credential.
    grafanaEmbedProxy.invalidateAll();
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
  // UX-03: `ensureAtSeriesConfigForCurrentIde` returning undefined means "no
  // config file target" -- which has two very different user-facing causes.
  const describeMissingMcpTarget = (verb: 'install' | 'uninstall'): string => {
    if (hostApp === 'continue' && !currentWorkspaceFolder()) {
      return verb === 'install'
        ? t('No supported IDE MCP config target was detected. Open a workspace to install Continue config.')
        : t('No supported IDE MCP config target was detected. Open a workspace to uninstall Continue config.');
    }
    return verb === 'install'
      ? t('Current IDE does not support automatic MCP config install (supported: Cursor, Kiro, Continue).')
      : t('Current IDE does not support automatic MCP config uninstall (supported: Cursor, Kiro, Continue).');
  };

  // Await hub sync before writing MCP config so node can resolve ~/.at-series/mcp/hub.js.
  const hubReady = syncPackagedHub(context)
    .then((result) => {
      log.info(`hub-sync: ok (updated=${result.updated}, active=${result.activeVersion})`);
      return result;
    })
    .catch((error) => {
      log.error(`hub-sync: failed: ${formatError(error)}`);
      showWarningNotification(
        t('AT Series hub sync failed: {message}. MCP may not start until Repair succeeds.', {
          message: formatError(error)
        }),
        [repairMcpAction, openLogAction]
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
    },
    // FUNC-14: this runs with no user gesture (the Agent asked for it), so it
    // must never reach the interactive TOFU modal -- `interactiveTls: false`
    // makes openGrafanaEmbedPanel throw for a not-yet-trusted HTTPS instance,
    // and the tool reports `openedInIde: false` with that message instead.
    openDashboardInIde: async ({ instanceId, uid, title, search }) => {
      await openGrafanaEmbedPanel(
        configManager,
        certTrustStore,
        instanceId,
        uid,
        title ?? t('Dashboard'),
        (panelInstanceId, panelUid, panelTitle, slug, panelSearch) =>
          DashboardPanel.open(grafanaEmbedProxy, panelInstanceId, panelUid, panelTitle, slug, panelSearch),
        undefined,
        search,
        { interactiveTls: false }
      );
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
    showWarningNotification(t('AT Grafana MCP bridge failed to start: {message}', { message: formatError(error) }), [
      openLogAction
    ]);
  });

  void hubReady
    .then(() => ensureAtSeriesConfigForCurrentIde({ ...hostEnv, workspaceFolder: currentWorkspaceFolder() }))
    .then((result) => {
      // UX-17: the first silent write to the user's MCP config gets one
      // visible, dismissible mention -- once per machine, never again while
      // the config stays up to date.
      if (result?.updated === true && context.globalState.get<boolean>(MCP_CONFIG_NOTIFIED_KEY, false) !== true) {
        void context.globalState.update(MCP_CONFIG_NOTIFIED_KEY, true);
        const uninstallActionTitle = t('How to Undo');
        void vscode.window
          .showInformationMessage(
            t(
              'AT Grafana installed the AT Series MCP config for this IDE so AI agents can query your Grafana instances (read-only, per-instance opt-in).'
            ),
            uninstallActionTitle
          )
          .then((picked) => {
            if (picked === uninstallActionTitle) {
              showTimedNotification(
                t('Run "AT Grafana: Uninstall AT Series MCP Config" from the Command Palette to remove it.'),
                'info',
                8000
              );
            }
          });
      }
    })
    .catch((error) => {
      log.error(`mcp-config: could not be updated: ${formatError(error)}`);
      showWarningNotification(
        t('AT Series MCP config could not be updated: {message}', { message: formatError(error) }),
        [repairMcpAction, openLogAction]
      );
    });

  const installMcpConfigCommand = vscode.commands.registerCommand('atGrafana.installMcpConfig', async () => {
    try {
      await syncPackagedHub(context);
    } catch (error) {
      showFailureNotification(t('AT Series hub sync failed: {message}', { message: formatError(error) }), [
        openLogAction
      ]);
      return;
    }
    const result = await ensureAtSeriesConfigForCurrentIde({ ...hostEnv, workspaceFolder: currentWorkspaceFolder() });
    if (result) {
      showTimedNotification(
        result.updated ? t('AT Series MCP config installed/repaired.') : t('AT Series MCP config is already up to date.')
      );
      return;
    }
    showWarningNotification(describeMissingMcpTarget('install'));
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
    showWarningNotification(describeMissingMcpTarget('uninstall'));
  });

  const addInstanceCommand = vscode.commands.registerCommand('atGrafana.addInstance', () =>
    GrafanaInstanceFormPanel.open(context, configManager, refreshTreeViews, undefined, certTrustStore)
  );

  const manageInstancesCommand = vscode.commands.registerCommand('atGrafana.manageInstances', async () => {
    await manageInstances(context, configManager, refreshTreeViews, certTrustStore);
  });

  // FUNC-05: the only way to revoke a TOFU decision used to be wiping
  // globalState. QuickPick shows host:port plus the pinned fingerprint so the
  // user can tell entries apart before forgetting one.
  const forgetTrustedCertificateCommand = vscode.commands.registerCommand(
    'atGrafana.forgetTrustedCertificate',
    async () => {
      const trusted = certTrustStore.listTrusted();
      if (trusted.length === 0) {
        showTimedNotification(t('No trusted Grafana TLS certificates are recorded.'));
        return;
      }
      const picked = await vscode.window.showQuickPick(
        trusted.map((cert) => ({
          label: `${cert.host}:${cert.port}`,
          description: cert.fingerprint,
          cert
        })),
        { placeHolder: t('Select a trusted Grafana certificate to forget') }
      );
      if (!picked) {
        return;
      }
      await certTrustStore.forget(picked.cert.host, picked.cert.port);
      showTimedNotification(
        t('Forgot the trusted certificate for {hostPort}. The next HTTPS connection will ask again.', {
          hostPort: `${picked.cert.host}:${picked.cert.port}`
        })
      );
    }
  );

  // --- Tree item context-menu commands (UX-04 / FUNC-08). VS Code passes the
  // right-clicked tree item as the first argument; ErrorTreeItem passes a
  // plain `{ instanceId }` (UX-07), so both shapes are accepted.
  const requireInstance = async (arg: unknown): Promise<GrafanaInstanceConfig | undefined> => {
    const instanceId = instanceIdFromCommandArg(arg);
    const instance = instanceId ? await configManager.getInstance(instanceId) : undefined;
    if (!instance) {
      showWarningNotification(t('Select a Grafana instance in the AT Grafana sidebar first.'));
      return undefined;
    }
    return instance;
  };

  const editInstanceCommand = vscode.commands.registerCommand('atGrafana.editInstance', async (arg?: unknown) => {
    const instance = await requireInstance(arg);
    if (instance) {
      await GrafanaInstanceFormPanel.open(context, configManager, refreshTreeViews, instance, certTrustStore);
    }
  });

  const deleteInstanceCommand = vscode.commands.registerCommand('atGrafana.deleteInstance', async (arg?: unknown) => {
    const instance = await requireInstance(arg);
    if (instance) {
      await deleteInstanceWithConfirmation(configManager, instance, refreshTreeViews);
    }
  });

  const toggleAgentAccessCommand = vscode.commands.registerCommand(
    'atGrafana.toggleAgentAccess',
    async (arg?: unknown) => {
      const instance = await requireInstance(arg);
      if (!instance) {
        return;
      }
      const allowBackgroundAccess = !instance.allowBackgroundAccess;
      await configManager.updateInstance(instance.id, { allowBackgroundAccess });
      showTimedNotification(
        allowBackgroundAccess
          ? t('Agent access for "{label}" is now on.', { label: instance.label })
          : t('Agent access for "{label}" is now off.', { label: instance.label })
      );
      refreshTreeViews();
    }
  );

  const openInBrowserCommand = vscode.commands.registerCommand('atGrafana.openInBrowser', async (arg?: unknown) => {
    const url = grafanaUrlFromTreeItem(arg);
    if (!url) {
      showWarningNotification(t('This item has no Grafana URL to open.'));
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  });

  const copyGrafanaUrlCommand = vscode.commands.registerCommand('atGrafana.copyGrafanaUrl', async (arg?: unknown) => {
    const url = grafanaUrlFromTreeItem(arg);
    if (!url) {
      showWarningNotification(t('This item has no Grafana URL to copy.'));
      return;
    }
    await vscode.env.clipboard.writeText(url);
    showTimedNotification(t('Grafana URL copied to the clipboard.'));
  });

  const dashboardTreeView = vscode.window.createTreeView<GrafanaTreeItem>('atGrafana.dashboards', {
    treeDataProvider: dashboardTreeProvider
  });
  dashboardTreeProvider.attachTreeView(dashboardTreeView);
  // `createTreeView` (not `registerTreeDataProvider`) so the alerts view can
  // carry a firing-count badge (UX-11).
  const alertTreeView = vscode.window.createTreeView<GrafanaTreeItem>('atGrafana.alerts', {
    treeDataProvider: alertTreeProvider
  });
  const updateAlertBadge = (firingCount: number): void => {
    try {
      alertTreeView.badge =
        firingCount > 0 ? { value: firingCount, tooltip: t('{count} firing alert rules', { count: firingCount }) } : undefined;
    } catch {
      // `badge` is a newer TreeView API; a host without it must not break the tree.
    }
  };
  const firingCountSubscription = alertTreeProvider.onDidChangeFiringCount(updateAlertBadge);

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
      // Synchronous too: stops the alerts auto-refresh interval (UX-11).
      alertTreeProvider.dispose();
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

  const alertsRefreshIntervalListener = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('atGrafana.alerts.refreshIntervalSeconds')) {
      alertTreeProvider.refresh();
    }
  });

  context.subscriptions.push(
    logChannel,
    installMcpConfigCommand,
    uninstallMcpConfigCommand,
    addInstanceCommand,
    manageInstancesCommand,
    forgetTrustedCertificateCommand,
    editInstanceCommand,
    deleteInstanceCommand,
    toggleAgentAccessCommand,
    openInBrowserCommand,
    copyGrafanaUrlCommand,
    dashboardTreeView,
    alertTreeView,
    firingCountSubscription,
    alertsRefreshIntervalListener,
    refreshDashboardsCommand,
    refreshAlertsCommand,
    filterDashboardsCommand,
    clearDashboardFilterCommand,
    openDashboardCommand,
    openAlertRuleCommand
  );
}

/**
 * Extracts the instance id from whatever a command received: an
 * InstanceTreeItem from a context menu, or the `{ instanceId }` object an
 * ErrorTreeItem's inline command passes (UX-07).
 */
export function instanceIdFromCommandArg(arg: unknown): string | undefined {
  if (arg === null || typeof arg !== 'object') {
    return undefined;
  }
  const candidate = arg as { instance?: { id?: unknown }; instanceId?: unknown };
  if (candidate.instance && typeof candidate.instance === 'object' && typeof candidate.instance.id === 'string') {
    return candidate.instance.id;
  }
  return typeof candidate.instanceId === 'string' ? candidate.instanceId : undefined;
}

/**
 * The browser-facing URL for a tree item (UX-04): the instance root, the
 * dashboard's `/d/{uid}` page, or the alert rule's Unified Alerting detail
 * page.
 */
export function grafanaUrlFromTreeItem(item: unknown): string | undefined {
  if (item instanceof DashboardTreeItem) {
    return joinGrafanaPath(item.instance.url, `/d/${encodeURIComponent(item.uid)}`);
  }
  if (item instanceof AlertRuleTreeItem) {
    return joinGrafanaPath(item.instance.url, `/alerting/grafana/${encodeURIComponent(item.rule.uid)}/view`);
  }
  if (item instanceof InstanceTreeItem) {
    return item.instance.url;
  }
  return undefined;
}

function joinGrafanaPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * FUNC-14's non-interactive gate: an Agent-initiated open must never pop the
 * TOFU modal (no user gesture), so an HTTPS instance whose fingerprint is not
 * already in the trust store fails here with an instruction the Agent can
 * relay, instead of ever reaching `createInteractiveCertVerifier`. Uses the
 * same host:port keying as GrafanaHttpClient's verification (hostname +
 * explicit port, defaulting to 443 for https).
 */
export function assertAgentTlsPreTrusted(
  instanceUrl: string,
  certTrustStore: Pick<GrafanaCertTrustStore, 'getTrusted'>
): void {
  let parsed: URL;
  try {
    parsed = new URL(instanceUrl);
  } catch {
    throw new Error(t('Invalid Grafana URL.'));
  }
  if (parsed.protocol !== 'https:') {
    return;
  }
  const port = parsed.port ? Number(parsed.port) : 443;
  if (!certTrustStore.getTrusted(parsed.hostname, port)) {
    throw new Error(
      t(
        'The TLS certificate for {hostPort} is not trusted yet. Open this instance once in the AT Grafana sidebar (or run Test Connection in the instance form) to confirm its fingerprint.',
        { hostPort: `${parsed.hostname}:${port}` }
      )
    );
  }
}

interface OpenGrafanaEmbedPanelOptions {
  /**
   * `true` for user-initiated opens (tree clicks, command palette): failures
   * surface as error notifications and an unknown TLS fingerprint may prompt
   * trust-on-first-use. `false` for Agent-initiated opens (FUNC-14): failures
   * throw (the tool relays the message) and TLS trust is only *checked*,
   * never prompted -- the embed proxy still verifies the pinned fingerprint
   * on every request.
   */
  interactiveTls: boolean;
}

async function openGrafanaEmbedPanel(
  configManager: Pick<GrafanaInstanceConfigManager, 'getInstance' | 'getToken'>,
  certTrustStore: GrafanaCertTrustStore,
  instanceId: string,
  uid: string,
  title: string,
  openPanel: (instanceId: string, uid: string, title: string, slug?: string, search?: string) => Promise<void>,
  slug?: string,
  search?: string,
  options: OpenGrafanaEmbedPanelOptions = { interactiveTls: true }
): Promise<void> {
  const fail = async (message: string): Promise<void> => {
    if (!options.interactiveTls) {
      throw new Error(message);
    }
    await vscode.window.showErrorMessage(message);
  };

  if (!instanceId || !uid) {
    await openPanel(instanceId, uid, title, slug, search);
    return;
  }

  const instance = await configManager.getInstance(instanceId);
  if (!instance) {
    await fail(t('Cannot open "{title}": unknown Grafana instance.', { title }));
    return;
  }

  const token = await configManager.getToken(instanceId);
  if (!token) {
    await fail(
      t('Cannot open "{title}": no Service Account Token is configured for "{label}".', {
        title,
        label: instance.label
      })
    );
    return;
  }

  if (options.interactiveTls) {
    const trust = await ensureGrafanaTlsTrust(instance.url, token, certTrustStore);
    if (!trust.ok) {
      await fail(t('Cannot open "{title}": {message}', { title, message: trust.message }));
      return;
    }
  } else {
    // Throws when not already trusted; deliberately no health probe and no
    // interactive verifier on this path (FUNC-14).
    assertAgentTlsPreTrusted(instance.url, certTrustStore);
  }

  await openPanel(instanceId, uid, title, slug, search);
}

async function manageInstances(
  context: vscode.ExtensionContext,
  configManager: GrafanaInstanceConfigManager,
  onChanged: () => void,
  certTrustStore: GrafanaCertTrustStore
): Promise<void> {
  const instances = await configManager.listInstances();
  if (instances.length === 0) {
    const answer = await vscode.window.showInformationMessage(
      t('No Grafana instances configured yet.'),
      t('Add Instance')
    );
    if (answer === t('Add Instance')) {
      await GrafanaInstanceFormPanel.open(context, configManager, onChanged, undefined, certTrustStore);
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
    await GrafanaInstanceFormPanel.open(context, configManager, onChanged, picked.instance, certTrustStore);
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
