import * as vscode from 'vscode';
import type { GrafanaInstanceConfigManager } from '../config/GrafanaInstanceConfigManager';
import type { GrafanaInstanceConfig } from '../config/schema';
import { testGrafanaConnection, type GrafanaConnectionTestResult } from '../grafana/testGrafanaConnection';
import { formatError } from '../utils/errors';
import { renderWebviewHtml } from './html';

type SubmitPayload = Record<string, unknown>;

type InstanceFormMessage =
  | { type?: 'submit'; payload?: SubmitPayload }
  | { type?: 'testConnection'; payload?: SubmitPayload }
  | { type?: string; payload?: SubmitPayload };

interface InstanceFormMessageOptions {
  testConnection?: (url: string, token: string | undefined) => Promise<GrafanaConnectionTestResult>;
}

export class GrafanaInstanceFormPanel {
  static async open(
    context: vscode.ExtensionContext,
    configManager: GrafanaInstanceConfigManager,
    onSaved: () => void,
    existing?: GrafanaInstanceConfig
  ): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      'grafanaInstanceForm',
      existing ? `Edit Grafana Instance: ${existing.label}` : 'Add Grafana Instance',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [context.extensionUri]
      }
    );
    const existingToken = existing ? await configManager.getToken(existing.id) : undefined;

    panel.webview.html = renderWebviewHtml(
      panel.webview,
      {
        script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'grafana-instance-form.js'),
        style: vscode.Uri.joinPath(context.extensionUri, 'webview', 'grafana-instance-form', 'index.css')
      },
      renderInstanceForm(existing, Boolean(existingToken))
    );

    panel.webview.onDidReceiveMessage(async (message: InstanceFormMessage) => {
      await handleInstanceFormMessage(message, existing, configManager, onSaved, panel);
    });
  }
}

export async function handleInstanceFormMessage(
  message: InstanceFormMessage,
  existing: GrafanaInstanceConfig | undefined,
  configManager: Pick<GrafanaInstanceConfigManager, 'createInstance' | 'updateInstance'>,
  onSaved: () => void,
  panel: Pick<vscode.WebviewPanel, 'dispose' | 'webview'>,
  options: InstanceFormMessageOptions = {}
): Promise<boolean> {
  if (message.type === 'testConnection' && message.payload) {
    await handleConnectionTest(message.payload, panel, options);
    return true;
  }

  if (message.type !== 'submit' || !message.payload) {
    return false;
  }

  try {
    const label = optionalString(message.payload.label);
    const url = optionalString(message.payload.url);
    const token = optionalString(message.payload.token);
    const allowBackgroundAccess =
      message.payload.allowBackgroundAccess === 'on' || message.payload.allowBackgroundAccess === true;

    if (!label) {
      await panel.webview.postMessage({ type: 'error', payload: 'Label is required.' });
      return true;
    }
    if (!url || !isValidGrafanaUrl(url)) {
      await panel.webview.postMessage({ type: 'error', payload: 'A valid Grafana URL is required.' });
      return true;
    }
    if (!existing && !token) {
      await panel.webview.postMessage({
        type: 'error',
        payload: 'A Service Account Token is required for new instances.'
      });
      return true;
    }

    if (existing) {
      await configManager.updateInstance(existing.id, { label, url, allowBackgroundAccess }, token);
    } else {
      await configManager.createInstance({ label, url, token, allowBackgroundAccess });
    }
    onSaved();
    panel.dispose();
  } catch (error) {
    await panel.webview.postMessage({ type: 'error', payload: formatError(error) });
  }

  return true;
}

async function handleConnectionTest(
  payload: SubmitPayload,
  panel: Pick<vscode.WebviewPanel, 'webview'>,
  options: InstanceFormMessageOptions
): Promise<void> {
  const url = optionalString(payload.url);
  const token = optionalString(payload.token);
  if (!url || !isValidGrafanaUrl(url)) {
    await panel.webview.postMessage({
      type: 'connectionTestResult',
      payload: { ok: false, message: 'Enter a valid Grafana URL before testing.' }
    });
    return;
  }

  const runTest = options.testConnection ?? testGrafanaConnection;
  const result = await runTest(url, token);
  await panel.webview.postMessage({
    type: 'connectionTestResult',
    payload: result.ok ? { ok: true, message: 'Connection succeeded.' } : { ok: false, message: result.message }
  });
}

function optionalString(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : undefined;
}

function isValidGrafanaUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function renderInstanceForm(existing?: GrafanaInstanceConfig, hasStoredToken = false): string {
  const submitText = existing ? 'Save Instance' : 'Add Instance';
  const tokenHelp =
    existing && hasStoredToken
      ? 'Leave blank to keep the saved Service Account Token.'
      : 'Stored securely in VS Code SecretStorage. Create one under Grafana → Administration → Service accounts.';
  const tokenPlaceholder = existing && hasStoredToken ? '••••••••' : 'glsa_...';

  return `<main class="instance-form-shell">
  <header class="form-header">
    <div>
      <h1>${existing ? 'Edit Grafana Instance' : 'Add Grafana Instance'}</h1>
      <p>Connect AT Grafana to a Grafana instance via a Service Account Token.</p>
    </div>
  </header>
  <form id="instance-form" class="instance-form">
    <label class="field-stack">Label <input name="label" value="${escapeAttr(existing?.label ?? '')}" required autocomplete="off"></label>
    <label class="field-stack">Grafana URL <input name="url" type="url" placeholder="https://grafana.example.com" value="${escapeAttr(existing?.url ?? '')}" required autocomplete="off"></label>
    <label class="field-stack">Service Account Token
      <input name="token" type="password" autocomplete="new-password" placeholder="${tokenPlaceholder}">
      <span class="field-help">${tokenHelp}</span>
    </label>
    <label class="toggle-row" for="allowBackgroundAccess">
      <span class="toggle-copy">
        <span class="toggle-title">Allow background Agent access</span>
        <span class="field-help">Lets Agents query this instance's dashboards, alerts, and datasources via MCP even when no panel is open (ADR-004).</span>
      </span>
      <input id="allowBackgroundAccess" name="allowBackgroundAccess" type="checkbox"${existing?.allowBackgroundAccess ? ' checked' : ''}>
    </label>
    <footer class="form-footer">
      <div class="form-feedback">
        <div id="form-error" class="form-error" role="status" aria-live="polite"></div>
        <div id="testStatus" class="test-status" role="status" aria-live="polite"></div>
      </div>
      <div class="form-actions">
        <button id="testConnectionButton" class="secondary-action" type="button">Test Connection</button>
        <button id="submitButton" class="primary-action" type="submit">
          <span id="submitLabel">${submitText}</span>
        </button>
      </div>
    </footer>
  </form>
</main>`;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
