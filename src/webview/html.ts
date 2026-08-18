import * as vscode from 'vscode';
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
}

/**
 * Task 4.2/4.3's dedicated shell for a Webview that embeds a live Grafana
 * page via GrafanaEmbedProxy (ADR-003). Deliberately not built on top of
 * renderWebviewHtml above: that helper's CSP has no `frame-src` at all
 * (restricted to `webview.cspSource`, VS Code's internal resource scheme),
 * so it can never permit an `<iframe>` pointed at the proxy's own
 * `http://127.0.0.1:<port>` origin. The whole shell here is a single
 * `<iframe>` with no inline/asset script of its own, so
 * `buildRecommendedCsp`'s origin-only `script-src` never needs loosening
 * with a nonce — see GrafanaEmbedProxy.ts's doc comment for why every
 * directive is scoped to the proxy origin only.
 */
export function renderEmbedWebviewHtml(options: EmbedWebviewOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${buildRecommendedCsp(options.proxyOrigin)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(options.title)}</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: var(--vscode-editor-background, #1e1e1e); }
    iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; }
  </style>
</head>
<body>
  <iframe src="${escapeAttr(options.iframeSrc)}" title="${escapeAttr(options.title)}"></iframe>
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
