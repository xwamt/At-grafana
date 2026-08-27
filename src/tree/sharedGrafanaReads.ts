import type { GrafanaFolder } from '../grafana/GrafanaApiClient';

/**
 * PERF-04: one refresh of both tree views used to hit `/api/folders` twice
 * (DashboardTreeProvider and AlertTreeProvider each paged the full listing
 * for the same instance). This is a short-lived, per-instance promise cache
 * shared between the two providers: whichever expands first pays for the
 * fetch, the other reuses the in-flight (or settled) promise.
 *
 * Lifetime is bounded by the providers' own refresh cycle -- `refresh()` on
 * either tree calls `invalidateAll()`, so folders are never staler than the
 * tree data they are rendered next to. A failed fetch evicts itself so the
 * next expand retries instead of caching the error forever.
 */
export class SharedGrafanaReads {
  private readonly foldersByInstance = new Map<string, Promise<GrafanaFolder[]>>();

  getFolders(instanceId: string, fetch: () => Promise<GrafanaFolder[]>): Promise<GrafanaFolder[]> {
    const cached = this.foldersByInstance.get(instanceId);
    if (cached) {
      return cached;
    }
    const promise = fetch().catch((error: unknown) => {
      // Only self-evict if this promise is still the cached one; a refresh
      // may already have replaced it with a newer fetch.
      if (this.foldersByInstance.get(instanceId) === promise) {
        this.foldersByInstance.delete(instanceId);
      }
      throw error;
    });
    this.foldersByInstance.set(instanceId, promise);
    return promise;
  }

  invalidate(instanceId: string): void {
    this.foldersByInstance.delete(instanceId);
  }

  invalidateAll(): void {
    this.foldersByInstance.clear();
  }
}
