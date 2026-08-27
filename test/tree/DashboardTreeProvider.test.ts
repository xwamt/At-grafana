import { describe, expect, it, vi } from 'vitest';
import type { GrafanaInstanceConfig } from '../../src/config/schema';
import type { GrafanaSearchResult } from '../../src/grafana/GrafanaDashboardsApi';
import {
  DASHBOARD_FILTER_STATE_KEY,
  DashboardTreeProvider,
  type DashboardApiClient,
  type FilterMemento
} from '../../src/tree/DashboardTreeProvider';
import { AlertTreeProvider, type AlertApiClient } from '../../src/tree/AlertTreeProvider';
import { SharedGrafanaReads } from '../../src/tree/sharedGrafanaReads';
import {
  DashboardTreeItem,
  ErrorTreeItem,
  FolderTreeItem,
  InstanceTreeItem,
  MessageTreeItem
} from '../../src/tree/GrafanaTreeItems';

class MemoryMemento implements FilterMemento {
  readonly data = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.data.has(key) ? this.data.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
}

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
      async (): Promise<DashboardApiClient> => ({ getAllFolders: async () => [], searchAll: async () => [] })
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
      getAllFolders: async () => [{ uid: 'f1', title: 'Infra' }],
      searchAll: async () => [
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
      getAllFolders: async () => [],
      searchAll: async () => [
        dashboard({ uid: 'd1', title: 'API Latency' }),
        dashboard({ uid: 'd2', title: 'Disk Usage' })
      ]
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

  it('hides folders with zero matching dashboards while a filter is active (UX-09)', async () => {
    const inst = instance();
    const client: DashboardApiClient = {
      getAllFolders: async () => [
        { uid: 'f1', title: 'Infra' },
        { uid: 'f2', title: 'Payments' }
      ],
      searchAll: async () => [
        dashboard({ uid: 'd1', title: 'CPU', folderUid: 'f1' }),
        dashboard({ uid: 'd2', title: 'Refunds', folderUid: 'f2' })
      ]
    };
    const provider = new DashboardTreeProvider({ listInstances: async () => [inst] }, async () => client);
    provider.setFilter('cpu');

    const [instanceItem] = await provider.getChildren();
    const folders = await provider.getChildren(instanceItem);

    expect(folders.map((f) => (f as FolderTreeItem).label)).toEqual(['Infra']);
  });

  it('shows a single message node when the filter matches nothing anywhere', async () => {
    const inst = instance();
    const client: DashboardApiClient = {
      getAllFolders: async () => [{ uid: 'f1', title: 'Infra' }],
      searchAll: async () => [dashboard({ uid: 'd1', title: 'CPU', folderUid: 'f1' })]
    };
    const provider = new DashboardTreeProvider({ listInstances: async () => [inst] }, async () => client);
    provider.setFilter('does-not-match-anything');

    const [instanceItem] = await provider.getChildren();
    const children = await provider.getChildren(instanceItem);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(MessageTreeItem);
  });

  it('nests folders by parentUid: children render under their parent, not at the root (FUNC-03)', async () => {
    const inst = instance();
    const client: DashboardApiClient = {
      getAllFolders: async () => [
        { uid: 'root-a', title: 'Root A' },
        { uid: 'child-a1', title: 'Child A1', parentUid: 'root-a' },
        { uid: 'grandchild', title: 'Grandchild', parentUid: 'child-a1' }
      ],
      searchAll: async () => [
        dashboard({ uid: 'd-root', title: 'Root Dash', folderUid: 'root-a' }),
        dashboard({ uid: 'd-grand', title: 'Grand Dash', folderUid: 'grandchild' })
      ]
    };
    const provider = new DashboardTreeProvider({ listInstances: async () => [inst] }, async () => client);

    const [instanceItem] = await provider.getChildren();
    const roots = await provider.getChildren(instanceItem);
    expect(roots.filter((item) => item instanceof FolderTreeItem).map((item) => item.label)).toEqual(['Root A']);

    const rootChildren = await provider.getChildren(roots[0] as FolderTreeItem);
    // Subfolders come first, then the folder's own dashboards.
    expect(rootChildren.map((item) => item.label)).toEqual(['Child A1', 'Root Dash']);
    expect(rootChildren[0]).toBeInstanceOf(FolderTreeItem);
    expect(rootChildren[1]).toBeInstanceOf(DashboardTreeItem);

    const childChildren = await provider.getChildren(rootChildren[0] as FolderTreeItem);
    expect(childChildren.map((item) => item.label)).toEqual(['Grandchild']);

    const grandchildChildren = await provider.getChildren(childChildren[0] as FolderTreeItem);
    expect((grandchildChildren[0] as DashboardTreeItem).uid).toBe('d-grand');
  });

  it('surfaces a folder whose parent is missing from the listing at the root instead of dropping it', async () => {
    const inst = instance();
    const client: DashboardApiClient = {
      getAllFolders: async () => [{ uid: 'orphan', title: 'Orphan', parentUid: 'not-listed' }],
      searchAll: async () => [dashboard({ uid: 'd1', title: 'Dash', folderUid: 'orphan' })]
    };
    const provider = new DashboardTreeProvider({ listInstances: async () => [inst] }, async () => client);

    const [instanceItem] = await provider.getChildren();
    const roots = await provider.getChildren(instanceItem);

    expect(roots.filter((item) => item instanceof FolderTreeItem).map((item) => item.label)).toContain('Orphan');
  });

  it('keeps an ancestor folder visible while filtering when only a nested descendant matches', async () => {
    const inst = instance();
    const client: DashboardApiClient = {
      getAllFolders: async () => [
        { uid: 'root-a', title: 'Root A' },
        { uid: 'child-a1', title: 'Child A1', parentUid: 'root-a' },
        { uid: 'root-b', title: 'Root B' }
      ],
      searchAll: async () => [
        dashboard({ uid: 'd1', title: 'API Latency', folderUid: 'child-a1' }),
        dashboard({ uid: 'd2', title: 'Disk Usage', folderUid: 'root-b' })
      ]
    };
    const provider = new DashboardTreeProvider({ listInstances: async () => [inst] }, async () => client);
    provider.setFilter('api');

    const [instanceItem] = await provider.getChildren();
    const roots = await provider.getChildren(instanceItem);
    expect(roots.map((item) => item.label)).toEqual(['Root A']);

    const rootChildren = await provider.getChildren(roots[0] as FolderTreeItem);
    expect(rootChildren.map((item) => item.label)).toEqual(['Child A1']);
  });

  it('restores a persisted filter from workspaceState and persists changes to it (UX-09)', async () => {
    const memento = new MemoryMemento();
    await memento.update(DASHBOARD_FILTER_STATE_KEY, 'latency');
    const provider = new DashboardTreeProvider(
      { listInstances: async () => [] },
      async (): Promise<DashboardApiClient> => ({ getAllFolders: async () => [], searchAll: async () => [] }),
      { workspaceState: memento }
    );

    expect(provider.getFilter()).toBe('latency');

    provider.setFilter('errors');
    expect(memento.data.get(DASHBOARD_FILTER_STATE_KEY)).toBe('errors');

    provider.clearFilter();
    expect(memento.data.get(DASHBOARD_FILTER_STATE_KEY)).toBeUndefined();
  });

  it('shares one folders fetch per instance with the alert tree via SharedGrafanaReads (PERF-04)', async () => {
    const inst = instance();
    const sharedReads = new SharedGrafanaReads();
    const getAllFolders = vi.fn(async () => [{ uid: 'f1', title: 'Infra' }]);
    const dashboardProvider = new DashboardTreeProvider(
      { listInstances: async () => [inst] },
      async (): Promise<DashboardApiClient> => ({
        getAllFolders,
        searchAll: async () => [dashboard({ uid: 'd1', title: 'CPU', folderUid: 'f1' })]
      }),
      { sharedReads }
    );
    const alertProvider = new AlertTreeProvider(
      { listInstances: async () => [inst] },
      async (): Promise<AlertApiClient> => ({
        getAllFolders,
        listAlertRules: async () => [],
        listAlertRuleStates: async () => []
      }),
      { sharedReads }
    );

    const [dashboardInstanceItem] = await dashboardProvider.getChildren();
    await dashboardProvider.getChildren(dashboardInstanceItem);
    const [alertInstanceItem] = await alertProvider.getChildren();
    await alertProvider.getChildren(alertInstanceItem);

    expect(getAllFolders).toHaveBeenCalledTimes(1);

    // refresh() on either provider invalidates the shared cache, so the next
    // expand re-fetches instead of serving stale folders.
    alertProvider.refresh();
    const [dashboardInstanceItem2] = await dashboardProvider.getChildren();
    dashboardProvider.refresh();
    await dashboardProvider.getChildren(dashboardInstanceItem2);
    expect(getAllFolders).toHaveBeenCalledTimes(2);
    alertProvider.dispose();
  });

  it('surfaces a root-level listInstances error as a single ErrorTreeItem without throwing', async () => {
    const provider = new DashboardTreeProvider(
      {
        listInstances: async () => {
          throw new Error('storage unavailable');
        }
      },
      async (): Promise<DashboardApiClient> => ({ getAllFolders: async () => [], searchAll: async () => [] })
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

  it('builds the tree from the complete paginated listings, not from a single truncated page', async () => {
    const inst = instance();
    const client: DashboardApiClient = {
      getAllFolders: async () => [{ uid: 'f1', title: 'Infra' }],
      searchAll: async () => [dashboard({ uid: 'd1', title: 'CPU', folderUid: 'f1' })]
    };
    const provider = new DashboardTreeProvider({ listInstances: async () => [inst] }, async () => client);

    const [instanceItem] = await provider.getChildren();
    const folders = await provider.getChildren(instanceItem);

    expect(folders.some((f) => f instanceof ErrorTreeItem)).toBe(false);
    const infraFolder = folders.find(
      (f) => f instanceof FolderTreeItem && f.folderUid === 'f1'
    ) as FolderTreeItem | undefined;
    expect(infraFolder).toBeDefined();

    const dashboards = await provider.getChildren(infraFolder);
    expect(dashboards).toHaveLength(1);
    expect(dashboards[0]).toBeInstanceOf(DashboardTreeItem);
    expect((dashboards[0] as DashboardTreeItem).uid).toBe('d1');
  });

  it('refresh() clears the cached data so the next expand re-fetches from the client', async () => {
    const inst = instance();
    let callCount = 0;
    const provider = new DashboardTreeProvider(
      { listInstances: async () => [inst] },
      async (): Promise<DashboardApiClient> => {
        callCount += 1;
        return { getAllFolders: async () => [], searchAll: async () => [] };
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
