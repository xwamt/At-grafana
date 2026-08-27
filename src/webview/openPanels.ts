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

/**
 * PERF-11: how long the embed proxy outlives the last open embed panel
 * before it is shut down. Long enough that "close a dashboard, immediately
 * open another" never pays a proxy restart (the restart also mints a new
 * embed token, invalidating the rewrite cache), short enough that an editor
 * with no Grafana panel open does not keep a listening socket around all day.
 */
export const EMBED_PROXY_IDLE_DISPOSE_DELAY_MS = 60_000;

/**
 * Registered by `GrafanaEmbedProxy.start()` (structural, so this module
 * never has to import the proxy — no cycle, and tests can hand in a spy).
 * `dispose()` is idempotent and `start()` restarts, so a late or doubled
 * idle disposal is harmless by construction.
 */
interface EmbedProxyIdleDisposeTarget {
  dispose(): Promise<void> | void;
}

let idleDisposeTarget: EmbedProxyIdleDisposeTarget | undefined;
let idleDisposeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Registers (or, with `undefined`, clears) the proxy the idle timer should
 * dispose once the last embed panel has been closed for
 * `EMBED_PROXY_IDLE_DISPOSE_DELAY_MS`.
 */
export function setEmbedProxyIdleDisposeTarget(target: EmbedProxyIdleDisposeTarget | undefined): void {
  idleDisposeTarget = target;
  if (!target) {
    cancelEmbedProxyIdleDispose();
  }
}

function cancelEmbedProxyIdleDispose(): void {
  if (idleDisposeTimer !== undefined) {
    clearTimeout(idleDisposeTimer);
    idleDisposeTimer = undefined;
  }
}

function scheduleEmbedProxyIdleDispose(): void {
  cancelEmbedProxyIdleDispose();
  if (!idleDisposeTarget) {
    return;
  }
  const timer = setTimeout(() => {
    idleDisposeTimer = undefined;
    // Re-checked at fire time: a panel that opened during the delay cancels
    // the timer, but this guard also covers any path that repopulated the
    // map without going through trackOpenPanel's cancel.
    if (openPanels.size === 0 && idleDisposeTarget) {
      void idleDisposeTarget.dispose();
    }
  }, EMBED_PROXY_IDLE_DISPOSE_DELAY_MS);
  // Never the reason the extension host process stays alive.
  timer.unref?.();
  idleDisposeTimer = timer;
}

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
  cancelEmbedProxyIdleDispose();
  openPanels.set(key, panel);
  panel.onDidDispose(() => {
    openPanels.delete(key);
    if (openPanels.size === 0) {
      scheduleEmbedProxyIdleDispose();
    }
  });
}

/**
 * Closes every still-open panel. Called from `deactivate`, and safe to call
 * again: the map is emptied, so a second call disposes nothing.
 *
 * Iterates a snapshot because each `dispose()` fires the `onDidDispose`
 * handler above, which mutates the map mid-loop.
 *
 * The pending idle-dispose timer (which the last panel's dispose just
 * scheduled) is cancelled too: at deactivate the extension owns the proxy's
 * shutdown directly, and a timer surviving into a disposed extension host
 * would be a leak, not a cleanup.
 */
export function disposeOpenPanels(): void {
  for (const panel of [...openPanels.values()]) {
    panel.dispose();
  }
  openPanels.clear();
  cancelEmbedProxyIdleDispose();
}
