type VsCodeApi = { postMessage(message: unknown): void };

declare const acquireVsCodeApi: () => VsCodeApi;

interface FormStrings {
  submit: string;
  saving: string;
  testConnection: string;
  testing: string;
  unknownError: string;
}

const FALLBACK_STRINGS: FormStrings = {
  submit: 'Add Instance',
  saving: 'Saving...',
  testConnection: 'Test Connection',
  testing: 'Testing connection...',
  unknownError: 'Something went wrong.'
};

const vscode = acquireVsCodeApi();
const strings = readStrings();
const form = document.querySelector<HTMLFormElement>('#instance-form');
const error = document.querySelector<HTMLElement>('#form-error');
const testStatus = document.querySelector<HTMLElement>('#testStatus');
const testConnectionButton = document.querySelector<HTMLButtonElement>('#testConnectionButton');
const submitButton = document.querySelector<HTMLButtonElement>('#submitButton');
const submitLabel = document.querySelector<HTMLElement>('#submitLabel');
const defaultSubmitLabel = submitLabel?.textContent ?? strings.submit;

function readStrings(): FormStrings {
  const block = document.getElementById('atGrafanaStrings');
  if (!block?.textContent) {
    return FALLBACK_STRINGS;
  }
  try {
    return { ...FALLBACK_STRINGS, ...(JSON.parse(block.textContent) as Partial<FormStrings>) };
  } catch {
    return FALLBACK_STRINGS;
  }
}

function field(name: string): HTMLInputElement | null {
  const element = form?.elements.namedItem(name);
  return element instanceof HTMLInputElement ? element : null;
}

function setError(message: string): void {
  if (error) {
    error.textContent = message;
  }
}

function clearError(): void {
  setError('');
}

function setTestStatus(message: string, state?: 'success' | 'error'): void {
  if (!testStatus) {
    return;
  }
  testStatus.textContent = message;
  testStatus.classList.toggle('is-success', state === 'success');
  testStatus.classList.toggle('is-error', state === 'error');
}

function setSaving(isSaving: boolean): void {
  submitButton?.toggleAttribute('disabled', isSaving);
  if (submitLabel) {
    submitLabel.textContent = isSaving ? strings.saving : defaultSubmitLabel;
  }
}

function setTesting(isTesting: boolean): void {
  testConnectionButton?.toggleAttribute('disabled', isTesting);
  if (testConnectionButton) {
    testConnectionButton.textContent = isTesting ? strings.testing : strings.testConnection;
  }
}


function payloadFromForm(): Record<string, unknown> {
  return {
    label: field('label')?.value ?? '',
    url: field('url')?.value ?? '',
    token: field('token')?.value ?? '',
    allowBackgroundAccess: Boolean(document.getElementById('allowBackgroundAccess') && (document.getElementById('allowBackgroundAccess') as HTMLInputElement).checked)
  };
}

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  clearError();
  setSaving(true);
  vscode.postMessage({ type: 'submit', payload: payloadFromForm() });
});

testConnectionButton?.addEventListener('click', () => {
  clearError();
  setTestStatus(strings.testing);
  setTesting(true);
  vscode.postMessage({ type: 'testConnection', payload: payloadFromForm() });
});

window.addEventListener('message', (event: MessageEvent<{ type?: string; payload?: unknown }>) => {
  const message = event.data;
  if (message.type === 'error') {
    setSaving(false);
    setError(typeof message.payload === 'string' ? message.payload : strings.unknownError);
    return;
  }
  if (message.type === 'connectionTestResult') {
    setTesting(false);
    const payload = message.payload as { ok: boolean; message: string };
    setTestStatus(payload.message, payload.ok ? 'success' : 'error');
  }
});

