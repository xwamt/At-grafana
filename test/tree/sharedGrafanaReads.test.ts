import { describe, expect, it, vi } from 'vitest';
import { SharedGrafanaReads } from '../../src/tree/sharedGrafanaReads';

describe('SharedGrafanaReads (PERF-04)', () => {
  it('fetches folders once per instance and shares the promise with later callers', async () => {
    const reads = new SharedGrafanaReads();
    const fetch = vi.fn(async () => [{ uid: 'f1', title: 'Infra' }]);

    const [first, second] = await Promise.all([
      reads.getFolders('inst-1', fetch),
      reads.getFolders('inst-1', fetch)
    ]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it('keeps instances separate', async () => {
    const reads = new SharedGrafanaReads();
    const fetchA = vi.fn(async () => []);
    const fetchB = vi.fn(async () => []);

    await reads.getFolders('inst-a', fetchA);
    await reads.getFolders('inst-b', fetchB);

    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
  });

  it('invalidateAll() causes the next call to re-fetch', async () => {
    const reads = new SharedGrafanaReads();
    const fetch = vi.fn(async () => []);

    await reads.getFolders('inst-1', fetch);
    reads.invalidateAll();
    await reads.getFolders('inst-1', fetch);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('invalidate(instanceId) only evicts that instance', async () => {
    const reads = new SharedGrafanaReads();
    const fetchA = vi.fn(async () => []);
    const fetchB = vi.fn(async () => []);
    await reads.getFolders('inst-a', fetchA);
    await reads.getFolders('inst-b', fetchB);

    reads.invalidate('inst-a');
    await reads.getFolders('inst-a', fetchA);
    await reads.getFolders('inst-b', fetchB);

    expect(fetchA).toHaveBeenCalledTimes(2);
    expect(fetchB).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed fetch: the next call retries', async () => {
    const reads = new SharedGrafanaReads();
    const fetch = vi
      .fn<() => Promise<{ uid: string; title: string }[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([]);

    await expect(reads.getFolders('inst-1', fetch)).rejects.toThrow('boom');
    await expect(reads.getFolders('inst-1', fetch)).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
