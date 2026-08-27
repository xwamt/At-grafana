import * as vscode from 'vscode';
import { t } from '../i18n/t';
import { createNonce } from '../utils/nonce';
import { buildRecommendedCsp } from './GrafanaEmbedProxy';

export interface WebviewAsset {
  script: vscode.Uri;
  style?: vscode.Uri;
}

export function renderWebviewHtml(
  webview: vscode.Webview,
  asset: WebviewAsset,
  body: string,
  data: Readonly<Record<string, unknown>> = {}
): string {
  const nonce = createNonce();
  const styleTag = asset.style ? `<link rel="stylesheet" href="${webview.asWebviewUri(asset.style)}">` : '';
  const dataTags = Object.entries(data)
    .map(([id, value]) => `\n  ${renderJsonScript(id, value, nonce)}`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource} 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${styleTag}
</head>
<body>
  ${body}${dataTags}
  <script nonce="${nonce}" src="${webview.asWebviewUri(asset.script)}"></script>
</body>
</html>`;
}

export function renderJsonScript(id: string, value: unknown, nonce: string): string {
  const json = JSON.stringify(value) ?? 'null';
  return `<script type="application/json" id="${escapeAttr(id)}" nonce="${escapeAttr(nonce)}">${json.replaceAll('<', '\\u003c')}</script>`;
}


export interface EmbedWebviewOptions {
  title: string;
  iframeSrc: string;
  proxyOrigin: string;
  /**
   * BCP-47 tag for `<html lang>` (UX-12/UX-16). Callers that can reach
   * `vscode.env.language` pass it through; anything else falls back to `en`,
   * matching the shell's own (English-fallback) copy.
   */
  language?: string;
}

/**
 * Task 4.2/4.3's dedicated shell for a Webview that embeds a live Grafana
 * page via GrafanaEmbedProxy (ADR-003). Deliberately not built on top of
 * renderWebviewHtml above: that helper's CSP has no `frame-src` at all
 * (restricted to `webview.cspSource`, VS Code's internal resource scheme),
 * so it can never permit an `<iframe>` pointed at the proxy's own
 * `http://127.0.0.1:<port>` origin.
 *
 * UX-12: the shell shows a spinner until the iframe's `load` event and a
 * retry message on its `error` event, instead of the indistinguishable blank
 * panel both cases used to produce. The loader sits *behind* the iframe
 * (which stays transparent until the Grafana document paints), so even if
 * the wiring script were ever blocked the loader ends up covered by real
 * content rather than covering it. That script is this shell's only script
 * and is admitted by nonce — every CSP source list still names only the
 * proxy origin (ADR-003's last bullet).
 */
export function renderEmbedWebviewHtml(options: EmbedWebviewOptions): string {
  const nonce = createNonce();
  return `<!DOCTYPE html>
<html lang="${escapeAttr(options.language ?? 'en')}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildRecommendedCsp(options.proxyOrigin, nonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(options.title)}</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: var(--vscode-editor-background, #1e1e1e); color: var(--vscode-editor-foreground, #d4d4d4); font-family: var(--vscode-font-family, system-ui, sans-serif); }
    iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; z-index: 1; }
    .embed-status { position: fixed; inset: 0; z-index: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.75rem; text-align: center; padding: 1rem; }
    .embed-status[hidden] { display: none; }
    #embed-error { z-index: 2; background: var(--vscode-editor-background, #1e1e1e); }
    .embed-spinner { width: 28px; height: 28px; border-radius: 50%; border: 3px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.35)); border-top-color: var(--vscode-progressBar-background, #0078d4); animation: embed-spin 0.9s linear infinite; }
    @keyframes embed-spin { to { transform: rotate(360deg); } }
    #embed-retry { font: inherit; color: var(--vscode-button-foreground, #ffffff); background: var(--vscode-button-background, #0078d4); border: none; border-radius: 3px; padding: 0.4rem 1rem; cursor: pointer; }
  </style>
</head>
<body>
  <div id="embed-loading" class="embed-status" role="status">
    <div class="embed-spinner" aria-hidden="true"></div>
    <p>${escapeHtml(t('Loading Grafana…'))}</p>
  </div>
  <div id="embed-error" class="embed-status" role="alert" hidden>
    <p>${escapeHtml(t('Grafana did not load in this panel. Check that the instance is reachable, then retry.'))}</p>
    <button id="embed-retry" type="button">${escapeHtml(t('Retry'))}</button>
  </div>
  <iframe src="${escapeAttr(options.iframeSrc)}" id="embed-frame" title="${escapeAttr(options.title)}"></iframe>
  <script nonce="${nonce}">
    (function () {
      var frame = document.getElementById('embed-frame');
      var loading = document.getElementById('embed-loading');
      var failed = document.getElementById('embed-error');
      var retry = document.getElementById('embed-retry');
      frame.addEventListener('load', function () {
        loading.hidden = true;
        failed.hidden = true;
      });
      frame.addEventListener('error', function () {
        loading.hidden = true;
        failed.hidden = false;
      });
      retry.addEventListener('click', function () {
        failed.hidden = true;
        loading.hidden = false;
        frame.setAttribute('src', frame.getAttribute('src'));
      });
    })();
  </script>
</body>
</html>`;
}

/**
 * Options for the `vscode.window.createWebviewPanel` call backing an embed
 * panel. `portMapping` matters beyond the common local-dev case: in remote/
 * SSH/container workspaces the Webview's renderer runs on a different
 * machine than the extension host that bound this proxy port, so
 * `127.0.0.1:<port>` inside the iframe would otherwise resolve on the
 * *wrong* machine. Mapping `webviewPort` to the same `extensionHostPort` is
 * a no-op locally and lets VS Code's remote tunneling handle the rest.
 */
export function buildEmbedWebviewOptions(proxyOrigin: string): vscode.WebviewPanelOptions & vscode.WebviewOptions {
  const port = Number(new URL(proxyOrigin).port);
  return {
    enableScripts: true,
    localResourceRoots: [],
    // PERF-10, a deliberate product choice: every *hidden* embed panel keeps
    // a complete Grafana SPA (its JS heap, DOM, and query polling) alive in
    // its Webview process — N background dashboard tabs cost roughly N idle
    // browser tabs of Grafana. The alternative (false) discards the whole
    // page on tab switch and reloads Grafana from scratch on return, losing
    // time-range/zoom state; V1 accepts the memory cost for instant,
    // state-preserving tab switches.
    retainContextWhenHidden: true,
    portMapping: [{ webviewPort: port, extensionHostPort: port }]
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
