import * as vscode from 'vscode';
import type { GrafanaInstanceConfigManager } from '../config/GrafanaInstanceConfigManager';
import type { GrafanaInstanceConfig } from '../config/schema';
import type { GrafanaApiClient, GrafanaFolder, GrafanaSearchResult } from '../grafana/GrafanaApiClient';
import { formatError } from '../utils/errors';
import { t } from '../i18n/t';
import {
  DashboardTreeItem,
  ErrorTreeItem,
  FolderTreeItem,
  InstanceTreeItem,
  MessageTreeItem,
  describeTreeError,
  type GrafanaTreeItem
} from './GrafanaTreeItems';
import { SharedGrafanaReads } from './sharedGrafanaReads';

/**
 * The tree renders everything the instance has, so it takes the paginated
 * listings rather than `search`/`getFolders` -- those return one `/api/search`
 * page and are the Agent-facing pair, deliberately kept bounded. See
 * GrafanaDashboardsApi.searchAll.
 */
export type DashboardApiClient = Pick<GrafanaApiClient, 'searchAll' | 'getAllFolders'>;
export type DashboardClientFactory = (instance: GrafanaInstanceConfig) => Promise<DashboardApiClient>;

/** The slice of `vscode.Memento` the filter persistence needs (UX-09). */
export interface FilterMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface DashboardTreeProviderOptions {
  /** `context.workspaceState`; when set, the title filter survives a window reload. */
  workspaceState?: FilterMemento;
  /** Folders promise cache shared with AlertTreeProvider (PERF-04). */
  sharedReads?: SharedGrafanaReads;
}

export const DASHBOARD_FILTER_STATE_KEY = 'atGrafana.dashboardFilter';
const FILTER_ACTIVE_CONTEXT_KEY = 'atGrafana.dashboardFilterActive';

/** PERF-05: `titleLower` is computed once per fetch, not once per filter keystroke per folder expand. */
interface IndexedDashboard {
  dashboard: GrafanaSearchResult;
  titleLower: string;
}

interface InstanceDashboardData {
  folders: GrafanaFolder[];
  /** Folders with no `parentUid`, or whose parent is not in the listing (FUNC-03). */
  rootFolders: GrafanaFolder[];
  childFoldersByParent: Map<string, GrafanaFolder[]>;
  /** Keyed by `folderUid`; `undefined` is the synthetic General bucket. */
  dashboardsByFolder: Map<string | undefined, IndexedDashboard[]>;
  hasFolderlessDashboards: boolean;
}

/**
 * `GrafanaDashboardsApi.searchAll()` has no server-side folder filter (see
 * GrafanaDashboardsApi.ts's `GrafanaDashboardSearchQuery`), so every
 * instance's dashboards are fetched once (`fetchInstanceData`), grouped
 * by `folderUid` into a Map, and folders are assembled into a `parentUid`
 * tree (FUNC-03) -- folder-level `getChildren` calls read those prebuilt
 * indexes instead of re-filtering the flat list per folder (PERF-05).
 */
export class DashboardTreeProvider implements vscode.TreeDataProvider<GrafanaTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<GrafanaTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly instanceDataCache = new Map<string, Promise<InstanceDashboardData>>();
  private readonly workspaceState: FilterMemento | undefined;
  private readonly sharedReads: SharedGrafanaReads;
  private filterText: string | undefined;
  private treeView: Pick<vscode.TreeView<GrafanaTreeItem>, 'message'> | undefined;

  constructor(
    private readonly configManager: Pick<GrafanaInstanceConfigManager, 'listInstances'>,
    private readonly createClient: DashboardClientFactory,
    options: DashboardTreeProviderOptions = {}
  ) {
    this.workspaceState = options.workspaceState;
    this.sharedReads = options.sharedReads ?? new SharedGrafanaReads();
    const persisted = this.workspaceState?.get<string | undefined>(DASHBOARD_FILTER_STATE_KEY, undefined);
    this.filterText = typeof persisted === 'string' && persisted.trim().length > 0 ? persisted.trim() : undefined;
    // Initialize the `when`-clause context even when no filter was restored,
    // so the Clear Filter button starts hidden rather than in a stale state
    // from a previous session.
    this.syncFilterContext();
  }

  attachTreeView(treeView: Pick<vscode.TreeView<GrafanaTreeItem>, 'message'>): void {
    this.treeView = treeView;
    this.updateTreeViewMessage();
  }

  refresh(): void {
    this.instanceDataCache.clear();
    this.sharedReads.invalidateAll();
    this.onDidChangeTreeDataEmitter.fire();
  }

  setFilter(text: string): void {
    const trimmed = text.trim();
    this.filterText = trimmed.length > 0 ? trimmed : undefined;
    this.persistFilter();
    this.syncFilterContext();
    this.updateTreeViewMessage();
    this.onDidChangeTreeDataEmitter.fire();
  }

  clearFilter(): void {
    if (this.filterText === undefined) {
      return;
    }
    this.filterText = undefined;
    this.persistFilter();
    this.syncFilterContext();
    this.updateTreeViewMessage();
    this.onDidChangeTreeDataEmitter.fire();
  }

  getFilter(): string | undefined {
    return this.filterText;
  }

  getTreeItem(element: GrafanaTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GrafanaTreeItem): Promise<GrafanaTreeItem[]> {
    if (!element) {
      return this.getRootChildren();
    }
    if (element instanceof InstanceTreeItem) {
      return this.getInstanceChildren(element.instance);
    }
    if (element instanceof FolderTreeItem) {
      return this.getFolderChildren(element.instance, element.folderUid);
    }
    return [];
  }

  private async getRootChildren(): Promise<GrafanaTreeItem[]> {
    try {
      const instances = await this.configManager.listInstances();
      if (instances.length === 0) {
        // Empty (not a MessageTreeItem) so VS Code's `viewsWelcome` contribution
        // for `atGrafana.dashboards` renders instead, with a clickable
        // "Add Instance" button -- a plain-text tree node here would suppress
        // that welcome view and leave no discoverable entry point in the UI.
        return [];
      }
      return instances.map((instance) => new InstanceTreeItem(instance));
    } catch (error) {
      return [new ErrorTreeItem(formatError(error))];
    }
  }

  private async getInstanceChildren(instance: GrafanaInstanceConfig): Promise<GrafanaTreeItem[]> {
    let data: InstanceDashboardData;
    try {
      data = await this.loadInstanceData(instance);
    } catch (error) {
      return [new ErrorTreeItem(describeTreeError(error), { instanceId: instance.id, detail: formatError(error) })];
    }

    const needle = this.filterText?.toLowerCase();
    const rootFolders = needle
      ? data.rootFolders.filter((folder) => this.folderSubtreeMatches(data, folder.uid, needle))
      : data.rootFolders;
    const items: GrafanaTreeItem[] = rootFolders.map((folder) => new FolderTreeItem(instance, folder.uid, folder.title));

    if (needle) {
      // While filtering, the General bucket (and any folder) only appears when
      // it actually holds a match -- an all-empty-folder result would just
      // restate "no matches" N times (UX-09).
      const folderlessMatches = (data.dashboardsByFolder.get(undefined) ?? []).some((entry) =>
        entry.titleLower.includes(needle)
      );
      if (folderlessMatches) {
        items.push(new FolderTreeItem(instance, undefined, t('General')));
      }
      if (items.length === 0) {
        return [new MessageTreeItem(t('No dashboards match the current filter.'))];
      }
      return items;
    }

    if (data.hasFolderlessDashboards || data.folders.length === 0) {
      items.push(new FolderTreeItem(instance, undefined, t('General')));
    }
    if (items.length === 0) {
      return [new MessageTreeItem(t('No dashboards found.'))];
    }
    return items;
  }

  private async getFolderChildren(
    instance: GrafanaInstanceConfig,
    folderUid: string | undefined
  ): Promise<GrafanaTreeItem[]> {
    let data: InstanceDashboardData;
    try {
      data = await this.loadInstanceData(instance);
    } catch (error) {
      return [new ErrorTreeItem(describeTreeError(error), { instanceId: instance.id, detail: formatError(error) })];
    }

    const needle = this.filterText?.toLowerCase();
    // The synthetic General bucket never has subfolders; real folders list
    // their child folders first, then their dashboards (FUNC-03).
    let childFolders = folderUid === undefined ? [] : data.childFoldersByParent.get(folderUid) ?? [];
    if (needle) {
      childFolders = childFolders.filter((folder) => this.folderSubtreeMatches(data, folder.uid, needle));
    }

    const indexed = data.dashboardsByFolder.get(folderUid) ?? [];
    const dashboards = needle ? indexed.filter((entry) => entry.titleLower.includes(needle)) : indexed;

    const items: GrafanaTreeItem[] = [
      ...childFolders.map((folder) => new FolderTreeItem(instance, folder.uid, folder.title)),
      ...dashboards.map(
        (entry) => new DashboardTreeItem(instance, entry.dashboard.uid, entry.dashboard.title, entry.dashboard.url)
      )
    ];
    if (items.length === 0) {
      return [
        new MessageTreeItem(this.filterText ? t('No dashboards match the current filter.') : t('No dashboards in this folder.'))
      ];
    }
    return items;
  }

  private folderSubtreeMatches(data: InstanceDashboardData, folderUid: string, needle: string): boolean {
    const dashboards = data.dashboardsByFolder.get(folderUid) ?? [];
    if (dashboards.some((entry) => entry.titleLower.includes(needle))) {
      return true;
    }
    const children = data.childFoldersByParent.get(folderUid) ?? [];
    return children.some((child) => this.folderSubtreeMatches(data, child.uid, needle));
  }

  private loadInstanceData(instance: GrafanaInstanceConfig): Promise<InstanceDashboardData> {
    const cached = this.instanceDataCache.get(instance.id);
    if (cached) {
      return cached;
    }
    const promise = this.fetchInstanceData(instance);
    this.instanceDataCache.set(instance.id, promise);
    return promise;
  }

  private async fetchInstanceData(instance: GrafanaInstanceConfig): Promise<InstanceDashboardData> {
    const client = await this.createClient(instance);
    const [folders, dashboards] = await Promise.all([
      this.sharedReads.getFolders(instance.id, () => client.getAllFolders()),
      client.searchAll({ type: 'dash-db' })
    ]);

    const folderUids = new Set(folders.map((folder) => folder.uid));
    const rootFolders: GrafanaFolder[] = [];
    const childFoldersByParent = new Map<string, GrafanaFolder[]>();
    for (const folder of folders) {
      const parentUid = folder.parentUid;
      // A folder whose parent is missing from the listing (permissions,
      // truncation) is surfaced at the root rather than dropped.
      if (parentUid !== undefined && parentUid !== folder.uid && folderUids.has(parentUid)) {
        const siblings = childFoldersByParent.get(parentUid);
        if (siblings) {
          siblings.push(folder);
        } else {
          childFoldersByParent.set(parentUid, [folder]);
        }
      } else {
        rootFolders.push(folder);
      }
    }

    const dashboardsByFolder = new Map<string | undefined, IndexedDashboard[]>();
    let hasFolderlessDashboards = false;
    for (const dashboard of dashboards) {
      const key = dashboard.folderUid || undefined;
      if (key === undefined) {
        hasFolderlessDashboards = true;
      }
      const entry: IndexedDashboard = { dashboard, titleLower: dashboard.title.toLowerCase() };
      const bucket = dashboardsByFolder.get(key);
      if (bucket) {
        bucket.push(entry);
      } else {
        dashboardsByFolder.set(key, [entry]);
      }
    }

    return { folders, rootFolders, childFoldersByParent, dashboardsByFolder, hasFolderlessDashboards };
  }

  private persistFilter(): void {
    void this.workspaceState?.update(DASHBOARD_FILTER_STATE_KEY, this.filterText);
  }

  private syncFilterContext(): void {
    // `setContext` is the only channel a `when` clause can read; drives the
    // Clear Filter button's visibility (UX-09).
    void vscode.commands.executeCommand('setContext', FILTER_ACTIVE_CONTEXT_KEY, this.filterText !== undefined);
  }

  private updateTreeViewMessage(): void {
    if (!this.treeView) {
      return;
    }
    this.treeView.message = this.filterText
      ? t('Filter: "{filterText}"', { filterText: this.filterText })
      : undefined;
  }
}
