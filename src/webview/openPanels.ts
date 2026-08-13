import type * as vscode from 'vscode';

/**
 * The panels this extension currently has open, keyed by a caller-supplied
 * string that must namespace its own panel type (`dashboard:`/`alert:`) --
 * dashboard uids and alert-rule uids come from different Grafana namespaces
 * and can collide.
 *
 * ## Why this exists instead of `context.subscriptions.push(panel)`
 *
 * `context.subscriptions` is append-only. Pushing every panel into it meant a
 * long session that opens and closes the same dashboard fifty times left
 * fifty entries behind, each pinning a disposed panel object that could
 * otherwise have been collected. Removing an entry on `onDidDispose` looks
 * like the obvious fix, but at deactivate VS Code is *iterating* that array
 * to dispose it -- splicing from inside a dispose callback makes it skip the
 * next subscription. Owning the collection sidesteps the question: entries
 * leave when a panel closes, and `deactivate` disposes whatever is left.
 *
 * A panel that already closed is not in the map, so `disposeOpenPanels`
 * cannot dispose it a second time.
 */
const openPanels = new Map<string, vscode.WebviewPanel>();

/** Reveals the panel open under `key`, reporting whether there was one. */
export function revealOpenPanel(key: string): boolean {
  const existing = openPanels.get(key);
  if (!existing) {
    return false;
  }
  existing.reveal();
  return true;
}

/** Tracks `panel` under `key` until it is disposed, however that happens. */
export function trackOpenPanel(key: string, panel: vscode.WebviewPanel): void {
  openPanels.set(key, panel);
  panel.onDidDispose(() => {
    openPanels.delete(key);
  });
}

/**
 * Closes every still-open panel. Called from `deactivate`, and safe to call
 * again: the map is emptied, so a second call disposes nothing.
 *
 * Iterates a snapshot because each `dispose()` fires the `onDidDispose`
 * handler above, which mutates the map mid-loop.
 */
export function disposeOpenPanels(): void {
  for (const panel of [...openPanels.values()]) {
    panel.dispose();
  }
  openPanels.clear();
}
