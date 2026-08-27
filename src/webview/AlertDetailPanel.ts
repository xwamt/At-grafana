import * as vscode from 'vscode';
import { formatError } from '../utils/errors';
import { buildEmbedWebviewOptions, renderEmbedWebviewHtml } from './html';
import type { GrafanaEmbedProxy } from './GrafanaEmbedProxy';
import { revealOpenPanel, trackOpenPanel } from './openPanels';
import { t } from '../i18n/t';

export type AlertDetailEmbedProxy = Pick<GrafanaEmbedProxy, 'start' | 'origin' | 'buildAlertRuleUrl'>;

/**
 * Task 4.3 (docs/plans/2026-07-29-at-grafana-v1-implementation-plan.md,
 * Phase 4) — same pattern as DashboardPanel, targeting the native Unified
 * Alerting rule view via GrafanaEmbedProxy.buildAlertRuleUrl (ADR-003).
 * Panels are deduplicated by `instanceId:uid` so clicking the same rule
 * twice reveals the existing tab instead of opening a duplicate.
 */
export class AlertDetailPanel {
  static async open(
    proxy: AlertDetailEmbedProxy,
    instanceId: string,
    uid: string,
    title: string
  ): Promise<void> {
    if (!instanceId || !uid) {
      await vscode.window.showErrorMessage(t('Cannot open this alert rule: the instance or rule id is missing.'));
      return;
    }

    const key = `alert:${instanceId}:${uid}`;
    if (revealOpenPanel(key)) {
      return;
    }

    let origin: string;
    try {
      await proxy.start();
      if (!proxy.origin) {
        throw new Error(t('AT Grafana embed proxy did not report an origin after starting.'));
      }
      origin = proxy.origin;
    } catch (error) {
      await vscode.window.showErrorMessage(
        t('Could not open alert rule "{title}": {message}', { title, message: formatError(error) })
      );
      return;
    }


    const panel = vscode.window.createWebviewPanel(
      'atGrafana.alertDetailPanel',
      title,
      vscode.ViewColumn.Active,
      buildEmbedWebviewOptions(origin)
    );
    trackOpenPanel(key, panel);

    panel.webview.html = renderEmbedWebviewHtml({
      title,
      proxyOrigin: origin,
      iframeSrc: proxy.buildAlertRuleUrl(instanceId, uid),
      language: vscode.env.language
    });
  }
}
