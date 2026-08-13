import * as vscode from 'vscode';
import { formatError } from '../utils/errors';
import { buildEmbedWebviewOptions, renderEmbedWebviewHtml } from './html';
import type { GrafanaEmbedProxy } from './GrafanaEmbedProxy';
import { revealOpenPanel, trackOpenPanel } from './openPanels';

export type DashboardEmbedProxy = Pick<GrafanaEmbedProxy, 'start' | 'origin' | 'buildDashboardUrl'>;

/**
 * Task 4.2 (docs/plans/2026-07-29-at-grafana-v1-implementation-plan.md,
 * Phase 4) — Webview panel embedding a live, fully-interactive native
 * Grafana dashboard page via GrafanaEmbedProxy (ADR-003). Panels are
 * deduplicated by `instanceId:uid` so clicking the same dashboard twice
 * reveals the existing tab instead of opening a duplicate.
 *
 * This class's own responsibility stops at "the proxy is up, here is an
 * iframe pointed at it" — actually reaching Grafana (auth, TLS trust,
 * unknown-dashboard 404s) is surfaced by the proxy/iframe itself once it
 * loads, not pre-flighted here (see GrafanaEmbedProxy's class doc).
 */
export class DashboardPanel {
  static async open(
    proxy: DashboardEmbedProxy,
    instanceId: string,
    uid: string,
    title: string,
    slug?: string,
    search?: string
  ): Promise<void> {
    if (!instanceId || !uid) {
      await vscode.window.showErrorMessage('Cannot open this dashboard: the instance or dashboard id is missing.');
      return;
    }

    const key = `dashboard:${instanceId}:${uid}`;
    if (revealOpenPanel(key)) {
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
      await vscode.window.showErrorMessage(`Could not open dashboard "${title}": ${formatError(error)}`);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'atGrafana.dashboardPanel',
      title,
      vscode.ViewColumn.Active,
      buildEmbedWebviewOptions(origin)
    );
    trackOpenPanel(key, panel);

    panel.webview.html = renderEmbedWebviewHtml({
      title,
      proxyOrigin: origin,
      iframeSrc: proxy.buildDashboardUrl(instanceId, uid, slug, search)
    });
  }
}
