import { describe, expect, it } from 'vitest';
import type { GrafanaInstanceConfig } from '../../src/config/schema';
import type { GrafanaSearchResult } from '../../src/grafana/GrafanaDashboardsApi';
import {
  DashboardTreeProvider,
  type DashboardApiClient
} from '../../src/tree/DashboardTreeProvider';
import {
  DashboardTreeItem,
  ErrorTreeItem,
  FolderTreeItem,
  InstanceTreeItem,
  MessageTreeItem
} from '../../src/tree/GrafanaTreeItems';

function instance(overrides: Partial<GrafanaInstanceConfig> = {}): GrafanaInstanceConfig {
  return {
    id: 'instance-1',
    label: 'Production',
    url: 'https://grafana.example.com',
    allowBackgroundAccess: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function dashboard(overrides: Partial<GrafanaSearchResult> = {}): GrafanaSearchResult {
  return {
    uid: 'd1',
    title: 'Dashboard',
    type: 'dash-db',
    ...overrides
  };
}

describe('DashboardTreeProvider', () => {
  it('returns no root children (not an error) when no instances are configured, so the viewsWelcome "Add Instance" button renders', async () => {
    const provider = new DashboardTreeProvider({ listInstances: async () => [] }, async () => {
      throw new Error('createClient should not be called with no instances');
    });

    const children = await provider.getChildren();

    expect(children).toEqual([]);
  });

  it('lists one node per configured instance at the root', async () => {
    const instances = [instance({ id: 'a', label: 'A' }), instance({ id: 'b', label: 'B' })];
    const provider = new DashboardTreeProvider(
      { listInstances: async () => instances },
      async (): Promise<DashboardApiClient> => ({ getFolders: async () => [], search: async () => [] })
    );

    const children = await provider.getChildren();

    expect(children).toHaveLength(2);
    expect(children.every((child) => child instanceof InstanceTreeItem)).toBe(true);
    expect((children[0] as InstanceTreeItem).instance.label).toBe('A');
    expect((children[1] as InstanceTreeItem).instance.label).toBe('B');
  });

  it('groups dashboards by folder, including a synthetic General bucket for folderless dashboards', async () => {
    const inst = instance();
    const client: DashboardApiClient = {
      getFolders: async () => [{ uid: 'f1', title: 'Infra' }],
      search: async () => [
        dashboard({ uid: 'd1', title: 'CPU', folderUid: 'f1' }),
        dashboard({ uid: 'd2', title: 'Loose Dashboard' })
      ]
    };
    const provider = new DashboardTreeProvider({ listInstances: async () => [inst] }, async () => client);

    const [instanceItem] = await provider.getChildren();
    const folders = await provider.getChildren(instanceItem);

    expect(folders).toHaveLength(2);
    const infraFolder = folders.find((f) => (f as FolderTreeItem).folderUid === 'f1') as FolderTreeItem;
    const generalFolder = folders.find((f) => (f as FolderTreeItem).folderUid === undefined) as FolderTreeItem;
    expect(infraFolder.label).toBe('Infra');
    expect(generalFolder.label).toBe('General');

    const infraDashboards = await provider.getChildren(infraFolder);
    expect(infraDashboards).toHaveLength(1);
    expect((infraDashboards[0] as DashboardTreeItem).uid).toBe('d1');

    const generalDashboards = await provider.getChildren(generalFolder);
    expect(generalDashboards).toHaveLength(1);
    expect((generalDashboards[0] as DashboardTreeItem).uid).toBe('d2');
  });

  it('filters dashboard leaves case-insensitively by title, and clearing the filter restores full results', async () => {
    const inst = instance();
    const client: DashboardApiClient = {
      getFolders: async () => [],
      search: async () => [dashboard({ uid: 'd1', title: 'API Latency' }), dashboard({ uid: 'd2', title: 'Disk Usage' })]
    };
    const provider = new DashboardTreeProvider({ listInstances: async () => [inst] }, async () => client);
    const [instanceItem] = await provider.getChildren();
    const [generalFolder] = await provider.getChildren(instanceItem);

    provider.setFilter('aPi');
    const filtered = await provider.getChildren(generalFolder);
    expect(filtered).toHaveLength(1);
    expect((filtered[0] as DashboardTreeItem).uid).toBe('d1');

    provider.clearFilter();
    const restored = await provider.getChildren(generalFolder);
    expect(restored).toHaveLength(2);
  });

  it('does not filter folder nodes themselves, only dashboard leaves', async () => {
    const inst = instance();
    const client: DashboardApiClient = {
      getFolders: async () => [{ uid: 'f1', title: 'Infra' }],
      search: async () => [dashboard({ uid: 'd1', title: 'CPU', folderUid: 'f1' })]
    };
    const provider = new DashboardTreeProvider({ listInstances: async () => [inst] }, async () => client);
    provider.setFilter('does-not-match-anything');

    const [instanceItem] = await provider.getChildren();
    const folders = await provider.getChildren(instanceItem);

    expect(folders.map((f) => (f as FolderTreeItem).label)).toContain('Infra');
  });

  it('surfaces a root-level listInstances error as a single ErrorTreeItem without throwing', async () => {
    const provider = new DashboardTreeProvider(
      {
        listInstances: async () => {
          throw new Error('storage unavailable');
        }
      },
      async (): Promise<DashboardApiClient> => ({ getFolders: async () => [], search: async () => [] })
    );

    const children = await provider.getChildren();

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorTreeItem);
  });

  it('surfaces an instance-level API error as a single ErrorTreeItem without throwing out of getChildren', async () => {
    const inst = instance();
    const provider = new DashboardTreeProvider({ listInstances: async () => [inst] }, async () => {
      throw new Error('network unreachable');
    });

    const [instanceItem] = await provider.getChildren();
    const children = await provider.getChildren(instanceItem);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorTreeItem);
    expect((children[0] as ErrorTreeItem).description).toContain('network unreachable');
  });

  it('refresh() clears the cached data so the next expand re-fetches from the client', async () => {
    const inst = instance();
    let callCount = 0;
    const provider = new DashboardTreeProvider(
      { listInstances: async () => [inst] },
      async (): Promise<DashboardApiClient> => {
        callCount += 1;
        return { getFolders: async () => [], search: async () => [] };
      }
    );

    const [instanceItem] = await provider.getChildren();
    await provider.getChildren(instanceItem);
    await provider.getChildren(instanceItem);
    expect(callCount).toBe(1);

    provider.refresh();
    await provider.getChildren(instanceItem);
    expect(callCount).toBe(2);
  });
});
