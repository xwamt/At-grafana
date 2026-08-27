import * as vscode from 'vscode';

export type TimedNotificationKind = 'info' | 'warning' | 'error';

export const TIMED_NOTIFICATION_MS = 3000;

/**
 * A button on a failure/warning notification. Exactly one of `command` or
 * `run` should be set: `command` executes a VS Code command by id (with
 * optional arguments), `run` invokes a closure -- used where the action has
 * no command id, e.g. revealing the extension's own output channel.
 */
export interface NotificationAction {
  title: string;
  command?: string;
  arguments?: readonly unknown[];
  run?: () => void;
}

/**
 * Shows a toast that dismisses itself. VS Code has no timeout on notifications, so the
 * duration is expressed by keeping a progress task alive - but that task belongs to the
 * notification, not to the caller. Returns as soon as the toast is posted.
 *
 * Only for informational messages: errors and warnings go through
 * `showFailureNotification` / `showWarningNotification` below, which persist
 * until dismissed and can carry recovery actions (UX-02).
 */
export function showTimedNotification(
  message: string,
  kind: TimedNotificationKind = 'info',
  durationMs = TIMED_NOTIFICATION_MS
): void {
  const icon = kind === 'error' ? '$(error)' : kind === 'warning' ? '$(warning)' : '$(info)';
  try {
    void vscode.window
      .withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `${icon} ${message}`,
          cancellable: false
        },
        async () => {
          await delay(durationMs);
        }
      )
      .then(undefined, () => undefined);
  } catch {
    // The notification host can already be gone during shutdown, and a toast is never worth
    // failing the operation that asked for it.
  }
}

/**
 * A native error notification (persists until dismissed) with optional action
 * buttons. Unlike `showTimedNotification`'s 3-second toast, the user can
 * actually read the message and act on it -- the whole point of UX-02.
 */
export function showFailureNotification(message: string, actions: readonly NotificationAction[] = []): void {
  void runNotification(vscode.window.showErrorMessage, message, actions);
}

/** Warning-severity counterpart of `showFailureNotification`. */
export function showWarningNotification(message: string, actions: readonly NotificationAction[] = []): void {
  void runNotification(vscode.window.showWarningMessage, message, actions);
}

async function runNotification(
  show: (message: string, ...items: string[]) => Thenable<string | undefined>,
  message: string,
  actions: readonly NotificationAction[]
): Promise<void> {
  try {
    const picked = await show(message, ...actions.map((action) => action.title));
    if (picked === undefined) {
      return;
    }
    const action = actions.find((candidate) => candidate.title === picked);
    if (!action) {
      return;
    }
    if (action.command) {
      await vscode.commands.executeCommand(action.command, ...(action.arguments ?? []));
    }
    action.run?.();
  } catch {
    // Same rationale as showTimedNotification: a notification failure must
    // never fail the operation that reported it.
  }
}

export function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
