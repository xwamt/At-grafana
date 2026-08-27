import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
  EMBED_PROXY_IDLE_DISPOSE_DELAY_MS,
  disposeOpenPanels,
  revealOpenPanel,
  setEmbedProxyIdleDisposeTarget,
  trackOpenPanel
} from '../../src/webview/openPanels';

interface FakePanel {
  panel: vscode.WebviewPanel;
  disposeCalls: () => number;
  revealCalls: () => number;
  close: () => void;
}

/**
 * Deliberately counts every `dispose()` call rather than making the second
 * one a no-op the way a real WebviewPanel does: a double dispose is exactly
 * what these tests have to be able to see.
 */
function fakePanel(): FakePanel {
  const disposeListeners: Array<() => void> = [];
  let disposeCalls = 0;
  let revealCalls = 0;
  const panel = {
    reveal: () => {
      revealCalls++;
    },
    dispose: () => {
      disposeCalls++;
      for (const listener of [...disposeListeners]) {
        listener();
      }
    },
    onDidDispose: (listener: () => void) => {
      disposeListeners.push(listener);
      return { dispose: () => undefined };
    }
  };
  return {
    panel: panel as unknown as vscode.WebviewPanel,
    disposeCalls: () => disposeCalls,
    revealCalls: () => revealCalls,
    close: () => panel.dispose()
  };
}

describe('open panel registry', () => {
  beforeEach(() => {
    disposeOpenPanels();
    vi.restoreAllMocks();
  });

  it('reports that nothing is open for an untracked key', () => {
    expect(revealOpenPanel('dashboard:nope')).toBe(false);
  });

  it('reveals the panel tracked under a key', () => {
    const tracked = fakePanel();
    trackOpenPanel('dashboard:a', tracked.panel);

    expect(revealOpenPanel('dashboard:a')).toBe(true);
    expect(tracked.revealCalls()).toBe(1);
  });

  it('forgets a panel that closed itself, so the next open creates a fresh one', () => {
    const tracked = fakePanel();
    trackOpenPanel('dashboard:b', tracked.panel);

    tracked.close();

    expect(revealOpenPanel('dashboard:b')).toBe(false);
  });

  it('disposes every panel it is still tracking, exactly once each', () => {
    const first = fakePanel();
    const second = fakePanel();
    trackOpenPanel('dashboard:c', first.panel);
    trackOpenPanel('alert:c', second.panel);

    disposeOpenPanels();

    expect(first.disposeCalls()).toBe(1);
    expect(second.disposeCalls()).toBe(1);
  });

  it('does not dispose a panel the user already closed', () => {
    const closed = fakePanel();
    const open = fakePanel();
    trackOpenPanel('dashboard:d', closed.panel);
    trackOpenPanel('dashboard:e', open.panel);
    closed.close();

    disposeOpenPanels();

    expect(closed.disposeCalls()).toBe(1);
    expect(open.disposeCalls()).toBe(1);
  });

  it('holds nothing after disposing, so a second deactivate is a no-op', () => {
    const tracked = fakePanel();
    trackOpenPanel('dashboard:f', tracked.panel);

    disposeOpenPanels();
    disposeOpenPanels();

    expect(tracked.disposeCalls()).toBe(1);
    expect(revealOpenPanel('dashboard:f')).toBe(false);
  });
});

/**
 * PERF-11: once the last embed panel closes, the registered proxy is shut
 * down after EMBED_PROXY_IDLE_DISPOSE_DELAY_MS. `GrafanaEmbedProxy.start()`
 * is idempotent, so the next panel open simply restarts it.
 */
describe('embed proxy idle dispose', () => {
  let proxyDisposeCalls = 0;

  beforeEach(() => {
    disposeOpenPanels();
    proxyDisposeCalls = 0;
    setEmbedProxyIdleDisposeTarget({
      dispose: () => {
        proxyDisposeCalls++;
      }
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    disposeOpenPanels();
    setEmbedProxyIdleDisposeTarget(undefined);
    vi.useRealTimers();
  });

  it('disposes the registered proxy once the last panel has been closed for the idle delay', () => {
    const tracked = fakePanel();
    trackOpenPanel('dashboard:idle', tracked.panel);

    tracked.close();
    vi.advanceTimersByTime(EMBED_PROXY_IDLE_DISPOSE_DELAY_MS - 1);
    expect(proxyDisposeCalls).toBe(0);

    vi.advanceTimersByTime(1);
    expect(proxyDisposeCalls).toBe(1);
  });

  it('does not schedule a dispose while another panel is still open', () => {
    const first = fakePanel();
    const second = fakePanel();
    trackOpenPanel('dashboard:one', first.panel);
    trackOpenPanel('alert:two', second.panel);

    first.close();
    vi.advanceTimersByTime(EMBED_PROXY_IDLE_DISPOSE_DELAY_MS * 2);

    expect(proxyDisposeCalls).toBe(0);
  });

  it('cancels the pending dispose when a new panel opens within the delay', () => {
    const closed = fakePanel();
    trackOpenPanel('dashboard:reopen', closed.panel);
    closed.close();

    vi.advanceTimersByTime(EMBED_PROXY_IDLE_DISPOSE_DELAY_MS / 2);
    const reopened = fakePanel();
    trackOpenPanel('dashboard:reopen', reopened.panel);
    vi.advanceTimersByTime(EMBED_PROXY_IDLE_DISPOSE_DELAY_MS * 2);

    expect(proxyDisposeCalls).toBe(0);
  });

  it('is a no-op when no proxy is registered', () => {
    setEmbedProxyIdleDisposeTarget(undefined);
    const tracked = fakePanel();
    trackOpenPanel('dashboard:no-target', tracked.panel);

    tracked.close();
    vi.advanceTimersByTime(EMBED_PROXY_IDLE_DISPOSE_DELAY_MS * 2);

    expect(proxyDisposeCalls).toBe(0);
  });

  it('deactivate (disposeOpenPanels) cancels the pending idle timer instead of firing it later', () => {
    const tracked = fakePanel();
    trackOpenPanel('dashboard:deactivate', tracked.panel);

    disposeOpenPanels();
    vi.advanceTimersByTime(EMBED_PROXY_IDLE_DISPOSE_DELAY_MS * 2);

    expect(proxyDisposeCalls).toBe(0);
  });
});
