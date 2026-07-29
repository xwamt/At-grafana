import * as vscode from 'vscode';
import { formatError } from '../utils/errors';
import type { GrafanaEmbedProxy } from './GrafanaEmbedProxy';
import { buildEmbedWebviewOptions, renderEmbedWebviewHtml } from './html';

export type AlertDetailEmbedProxy = Pick<GrafanaEmbedProxy, 'start' | 'origin' | 'buildAlertRuleUrl'>;

const openPanels = new Map<string, vscode.WebviewPanel>();

/**
 * Task 4.3 (docs/plans/2026-07-29-at-grafana-v1-implementation-plan.md,
 * Phase 4) — same pattern as DashboardPanel, targeting the native Unified
 * Alerting rule view via GrafanaEmbedProxy.buildAlertRuleUrl (ADR-003).
 * Panels are deduplicated by `instanceId:uid` so clicking the same rule
 * twice reveals the existing tab instead of opening a duplicate.
 */
export class AlertDetailPanel {
  static async open(
    context: vscode.ExtensionContext,
    proxy: AlertDetailEmbedProxy,
    instanceId: string,
    uid: string,
    title: string
  ): Promise<void> {
    if (!instanceId || !uid) {
      await vscode.window.showErrorMessage('Cannot open this alert rule: the instance or rule id is missing.');
      return;
    }

    const key = `${instanceId}:${uid}`;
    const existing = openPanels.get(key);
    if (existing) {
      existing.reveal();
      return;
    }

    let origin: string;
    try {
      await proxy.start();
      if (!proxy.origin) {
        throw new Error('AT Grafana embed proxy did not report an origin after starting.');
      }
      origin = proxy.origin;
    } catch (error) {
      await vscode.window.showErrorMessage(`Could not open alert rule "${title}": ${formatError(error)}`);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'atGrafana.alertDetailPanel',
      title,
      vscode.ViewColumn.Active,
      buildEmbedWebviewOptions(origin)
    );
    openPanels.set(key, panel);
    panel.onDidDispose(() => {
      openPanels.delete(key);
    });
    context.subscriptions.push(panel);

    panel.webview.html = renderEmbedWebviewHtml({
      title,
      proxyOrigin: origin,
      iframeSrc: proxy.buildAlertRuleUrl(instanceId, uid)
    });
  }
}
