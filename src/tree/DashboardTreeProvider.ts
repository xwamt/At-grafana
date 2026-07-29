import * as vscode from 'vscode';
import type { GrafanaInstanceConfigManager } from '../config/GrafanaInstanceConfigManager';
import type { GrafanaInstanceConfig } from '../config/schema';
import type { GrafanaApiClient, GrafanaFolder, GrafanaSearchResult } from '../grafana/GrafanaApiClient';
import { formatError } from '../utils/errors';
import {
  DashboardTreeItem,
  ErrorTreeItem,
  FolderTreeItem,
  InstanceTreeItem,
  MessageTreeItem,
  type GrafanaTreeItem
} from './GrafanaTreeItems';

export type DashboardApiClient = Pick<GrafanaApiClient, 'search' | 'getFolders'>;
export type DashboardClientFactory = (instance: GrafanaInstanceConfig) => Promise<DashboardApiClient>;

const GENERAL_FOLDER_TITLE = 'General';

interface InstanceDashboardData {
  folders: GrafanaFolder[];
  dashboards: GrafanaSearchResult[];
}

/**
 * `GrafanaDashboardsApi.search()` has no server-side folder filter (see
 * GrafanaDashboardsApi.ts's `GrafanaDashboardSearchQuery`), so every
 * instance's dashboards are fetched once (`fetchInstanceData`) and grouped
 * by `folderUid` client-side; folder-level `getChildren` calls re-slice the
 * same cached list instead of re-querying Grafana per folder.
 */
export class DashboardTreeProvider implements vscode.TreeDataProvider<GrafanaTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<GrafanaTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly instanceDataCache = new Map<string, Promise<InstanceDashboardData>>();
  private filterText: string | undefined;
  private treeView: Pick<vscode.TreeView<GrafanaTreeItem>, 'message'> | undefined;

  constructor(
    private readonly configManager: Pick<GrafanaInstanceConfigManager, 'listInstances'>,
    private readonly createClient: DashboardClientFactory
  ) {}

  attachTreeView(treeView: Pick<vscode.TreeView<GrafanaTreeItem>, 'message'>): void {
    this.treeView = treeView;
    this.updateTreeViewMessage();
  }

  refresh(): void {
    this.instanceDataCache.clear();
    this.onDidChangeTreeDataEmitter.fire();
  }

  setFilter(text: string): void {
    const trimmed = text.trim();
    this.filterText = trimmed.length > 0 ? trimmed : undefined;
    this.updateTreeViewMessage();
    this.onDidChangeTreeDataEmitter.fire();
  }

  clearFilter(): void {
    if (this.filterText === undefined) {
      return;
    }
    this.filterText = undefined;
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
      return [new ErrorTreeItem(formatError(error))];
    }

    const items: GrafanaTreeItem[] = data.folders.map((folder) => new FolderTreeItem(instance, folder.uid, folder.title));
    const hasFolderlessDashboards = data.dashboards.some((dashboard) => !dashboard.folderUid);
    if (hasFolderlessDashboards || data.folders.length === 0) {
      items.push(new FolderTreeItem(instance, undefined, GENERAL_FOLDER_TITLE));
    }
    if (items.length === 0) {
      return [new MessageTreeItem('No dashboards found.')];
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
      return [new ErrorTreeItem(formatError(error))];
    }

    const inFolder = data.dashboards.filter((dashboard) => dashboard.folderUid === folderUid);
    const filtered = this.applyFilter(inFolder);
    if (filtered.length === 0) {
      return [
        new MessageTreeItem(this.filterText ? 'No dashboards match the current filter.' : 'No dashboards in this folder.')
      ];
    }
    return filtered.map((dashboard) => new DashboardTreeItem(instance, dashboard.uid, dashboard.title, dashboard.url));
  }

  private applyFilter(dashboards: GrafanaSearchResult[]): GrafanaSearchResult[] {
    if (!this.filterText) {
      return dashboards;
    }
    const needle = this.filterText.toLowerCase();
    return dashboards.filter((dashboard) => dashboard.title.toLowerCase().includes(needle));
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
    const [folders, dashboards] = await Promise.all([client.getFolders(), client.search({ type: 'dash-db' })]);
    return { folders, dashboards };
  }

  private updateTreeViewMessage(): void {
    if (!this.treeView) {
      return;
    }
    this.treeView.message = this.filterText ? `Filter: "${this.filterText}"` : undefined;
  }
}
