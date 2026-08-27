import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  TIMED_NOTIFICATION_MS,
  showFailureNotification,
  showWarningNotification
} from '../../src/utils/notifications';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Lets the fire-and-forget notification promise chain inside the helpers settle. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('notifications', () => {
  it('keeps the 3s duration for informational toasts', () => {
    expect(TIMED_NOTIFICATION_MS).toBe(3000);
  });

  it('showFailureNotification uses the native error message with the action titles as buttons', async () => {
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

    showFailureNotification('hub sync failed', [
      { title: 'Repair MCP Config', command: 'atGrafana.installMcpConfig' },
      { title: 'Open Log', run: () => undefined }
    ]);
    await flushMicrotasks();

    expect(showErrorMessage).toHaveBeenCalledWith('hub sync failed', 'Repair MCP Config', 'Open Log');
  });

  it('executes the action command (with its arguments) when the user clicks that button', async () => {
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue('Repair MCP Config' as never);
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);

    showFailureNotification('hub sync failed', [
      { title: 'Repair MCP Config', command: 'atGrafana.installMcpConfig', arguments: ['because'] }
    ]);
    await flushMicrotasks();

    expect(executeCommand).toHaveBeenCalledWith('atGrafana.installMcpConfig', 'because');
  });

  it('invokes the action run() closure when the clicked action has no command', async () => {
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue('Open Log' as never);
    const run = vi.fn();

    showFailureNotification('bridge failed', [{ title: 'Open Log', run }]);
    await flushMicrotasks();

    expect(run).toHaveBeenCalledOnce();
  });

  it('does nothing when the notification is dismissed without picking an action', async () => {
    vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    const run = vi.fn();

    showFailureNotification('failed', [{ title: 'Open Log', run, command: 'noop' }]);
    await flushMicrotasks();

    expect(executeCommand).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('showWarningNotification goes through the native warning message', async () => {
    const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);

    showWarningNotification('config target missing');
    await flushMicrotasks();

    expect(showWarningMessage).toHaveBeenCalledWith('config target missing');
  });

  it('never rejects out of the caller even when the notification host throws', async () => {
    vi.spyOn(vscode.window, 'showErrorMessage').mockRejectedValue(new Error('host gone'));

    expect(() => showFailureNotification('failed')).not.toThrow();
    await flushMicrotasks();
  });
});
