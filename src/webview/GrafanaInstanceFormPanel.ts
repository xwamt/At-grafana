import * as vscode from 'vscode';
import type { GrafanaInstanceConfigManager } from '../config/GrafanaInstanceConfigManager';
import type { GrafanaInstanceConfig } from '../config/schema';
import { createInteractiveCertVerifier } from '../grafana/createInteractiveCertVerifier';
import type { GrafanaCertTrustStore } from '../grafana/GrafanaCertTrustStore';
import { GrafanaApiClient, GrafanaApiError, type GrafanaCertVerifier } from '../grafana/GrafanaApiClient';
import { testGrafanaConnection, type GrafanaConnectionTestResult } from '../grafana/testGrafanaConnection';
import { formatError } from '../utils/errors';
import { renderWebviewHtml } from './html';
import { buildWebviewStrings, t } from '../i18n/t';

type SubmitPayload = Record<string, unknown>;

type InstanceFormMessage =
  | { type?: 'submit'; payload?: SubmitPayload }
  | { type?: 'testConnection'; payload?: SubmitPayload }
  | { type?: string; payload?: SubmitPayload };

interface InstanceFormMessageOptions {
  testConnection?: (url: string, token: string | undefined) => Promise<GrafanaConnectionTestResult>;
}

/** The one method of GrafanaApiClient the connection test needs; injectable so tests never open a socket. */
type HealthProbeClient = Pick<GrafanaApiClient, 'health'>;

export type TofuHealthClientFactory = (
  url: string,
  token: string | undefined,
  certVerifier: GrafanaCertVerifier
) => HealthProbeClient;

const defaultHealthClientFactory: TofuHealthClientFactory = (url, token, certVerifier) =>
  new GrafanaApiClient({ baseUrl: url, token: token ?? '', certVerifier });

/**
 * FUNC-02 / UX-01: the form's Test Connection button probes through the real
 * Grafana client WITH the interactive TOFU verifier, instead of the bare
 * `testGrafanaConnection` probe that deliberately ignores the trust store.
 * Consequences, in order:
 * - a fingerprint already trusted in `certTrustStore` connects silently;
 * - an unknown fingerprint prompts trust-on-first-use -- clicking Test
 *   Connection is exactly the user gesture ADR-004 wants behind that modal;
 * - a rejected prompt (or changed fingerprint the user declines) still
 *   reports a `tls` failure so the form shows the distinct TLS message.
 */
export function createTofuConnectionTester(
  certTrustStore: GrafanaCertTrustStore,
  createClient: TofuHealthClientFactory = defaultHealthClientFactory
): (url: string, token: string | undefined) => Promise<GrafanaConnectionTestResult> {
  return async (url, token) => {
    try {
      const client = createClient(url, token, createInteractiveCertVerifier(certTrustStore));
      await client.health();
      return { ok: true };
    } catch (error) {
      if (error instanceof GrafanaApiError) {
        const reason =
          error.kind === 'auth' ? 'auth' : error.kind === 'tls' ? 'tls' : error.kind === 'network' ? 'network' : 'error';
        return { ok: false, reason, message: error.message };
      }
      return { ok: false, reason: 'error', message: formatError(error) };
    }
  };
}

export class GrafanaInstanceFormPanel {
  static async open(
    context: vscode.ExtensionContext,
    configManager: GrafanaInstanceConfigManager,
    onSaved: () => void,
    existing?: GrafanaInstanceConfig,
    certTrustStore?: GrafanaCertTrustStore
  ): Promise<void> {
    const title = existing
      ? t('Edit Grafana Instance: {label}', { label: existing.label })
      : t('Add Grafana Instance');
    const panel = vscode.window.createWebviewPanel(
      'grafanaInstanceForm',
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [context.extensionUri]
      }
    );
    const existingToken = existing ? await configManager.getToken(existing.id) : undefined;
    const formHtml = renderInstanceForm(existing, Boolean(existingToken));

    panel.webview.html = renderWebviewHtml(
      panel.webview,
      {
        script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview', 'grafana-instance-form.js'),
        style: vscode.Uri.joinPath(context.extensionUri, 'webview', 'grafana-instance-form', 'index.css')
      },
      formHtml.body,
      formHtml.data
    );

    const options: InstanceFormMessageOptions = certTrustStore
      ? { testConnection: createTofuConnectionTester(certTrustStore) }
      : {};
    panel.webview.onDidReceiveMessage(async (message: InstanceFormMessage) => {
      await handleInstanceFormMessage(message, existing, configManager, onSaved, panel, options);
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
      await panel.webview.postMessage({ type: 'error', payload: t('Label is required.') });
      return true;
    }
    if (!url || !isValidGrafanaUrl(url)) {
      await panel.webview.postMessage({ type: 'error', payload: t('A valid Grafana URL is required.') });
      return true;
    }
    if (!existing && !token) {
      await panel.webview.postMessage({
        type: 'error',
        payload: t('A Service Account Token is required for new instances.')
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
      payload: { ok: false, message: t('Enter a valid Grafana URL before testing.') }
    });
    return;
  }

  const runTest = options.testConnection ?? testGrafanaConnection;
  const result = await runTest(url, token);
  await panel.webview.postMessage({
    type: 'connectionTestResult',
    payload: result.ok ? { ok: true, message: t('Connection succeeded.') } : { ok: false, message: result.message }
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

export function renderInstanceForm(
  existing?: GrafanaInstanceConfig,
  hasStoredToken = false
): { body: string; data: Record<string, unknown> } {
  const submitText = existing ? t('Save Instance') : t('Add Instance');
  const tokenHelp =
    existing && hasStoredToken
      ? t('Leave blank to keep the saved Service Account Token.')
      : t('Stored securely in the IDE\'s SecretStorage. Create one under Grafana → Administration → Service accounts.');
  const tokenPlaceholder = existing && hasStoredToken ? '••••••••' : 'glsa_...';

  const body = `<main class="instance-form-shell">
  <header class="form-header">
    <div>
      <h1>${escapeAttr(existing ? t('Edit Grafana Instance') : t('Add Grafana Instance'))}</h1>
      <p>${escapeAttr(t('Connect AT Grafana to a Grafana instance via a Service Account Token.'))}</p>
    </div>
  </header>
  <form id="instance-form" class="instance-form">
    <label class="field-stack">${escapeAttr(t('Label'))} <input name="label" value="${escapeAttr(existing?.label ?? '')}" required autocomplete="off"></label>
    <label class="field-stack">${escapeAttr(t('Grafana URL'))} <input name="url" type="url" placeholder="https://grafana.example.com" value="${escapeAttr(existing?.url ?? '')}" required autocomplete="off"></label>
    <label class="field-stack">${escapeAttr(t('Service Account Token'))}
      <input name="token" type="password" autocomplete="new-password" placeholder="${tokenPlaceholder}" aria-describedby="token-help">
      <span id="token-help" class="field-help">${escapeAttr(tokenHelp)}</span>
    </label>
    <label class="toggle-row" for="allowBackgroundAccess">
      <span class="toggle-copy">
        <span class="toggle-title">${escapeAttr(t('Allow background Agent access'))}</span>
        <span id="agent-access-help" class="field-help">${escapeAttr(t('Lets AI agents query this instance\'s dashboards, alerts, and datasources read-only with its token via MCP, even when no panel is open.'))}</span>
      </span>
      <input id="allowBackgroundAccess" name="allowBackgroundAccess" type="checkbox" aria-describedby="agent-access-help"${existing?.allowBackgroundAccess ? ' checked' : ''}>
    </label>
    <footer class="form-footer">
      <div class="form-feedback">
        <div id="form-error" class="form-error" role="alert"></div>
        <div id="testStatus" class="test-status" role="status" aria-live="polite"></div>
      </div>
      <div class="form-actions">
        <button id="testConnectionButton" class="secondary-action" type="button">${escapeAttr(t('Test Connection'))}</button>
        <button id="submitButton" class="primary-action" type="submit">
          <span id="submitLabel">${escapeAttr(submitText)}</span>
        </button>
      </div>
    </footer>
  </form>
</main>`;

  return {
    body,
    data: {
      atGrafanaStrings: buildWebviewStrings({
        submit: existing ? 'Save Instance' : 'Add Instance',
        saving: 'Saving...',
        testConnection: 'Test Connection',
        testing: 'Testing connection...',
        unknownError: 'Something went wrong.'
      })
    }
  };
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
