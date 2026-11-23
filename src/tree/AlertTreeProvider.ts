import * as vscode from 'vscode';
import type { GrafanaInstanceConfigManager } from '../config/GrafanaInstanceConfigManager';
import type { GrafanaInstanceConfig } from '../config/schema';
import { ALERT_STATE_RANK, buildAlertStateIndex, correlateAlertState, type NormalizedAlertState } from '../grafana/correlateAlertState';
import type { GrafanaApiClient } from '../grafana/GrafanaApiClient';
import { formatError } from '../utils/errors';
import { t } from '../i18n/t';
import {
  AlertGroupTreeItem,
  AlertRuleTreeItem,
  ErrorTreeItem,
  InstanceTreeItem,
  MessageTreeItem,
  describeTreeError,
  type AlertRuleWithState,
  type GrafanaTreeItem
} from './GrafanaTreeItems';
import { SharedGrafanaReads } from './sharedGrafanaReads';
import type { FilterMemento } from './DashboardTreeProvider';

/** `getAllFolders` rather than `getFolders` for the same reason as the dashboard tree; see DashboardTreeProvider. */
export type AlertApiClient = Pick<GrafanaApiClient, 'listAlertRules' | 'listAlertRuleStates' | 'getAllFolders'>;
export type AlertClientFactory = (instance: GrafanaInstanceConfig) => Promise<AlertApiClient>;

export interface AlertTreeProviderOptions {
  /** `context.workspaceState`; when set, the alert filters survive a window reload. */
  workspaceState?: FilterMemento;
  /** Folders promise cache shared with DashboardTreeProvider (PERF-04). */
  sharedReads?: SharedGrafanaReads;
  /**
   * `atGrafana.alerts.refreshIntervalSeconds`, read live on every (re)schedule
   * so a settings change takes effect on the next refresh without a listener.
   * `0` (the default) disables auto-refresh (UX-11).
   */
  getRefreshIntervalSeconds?: () => number;
}

export const ALERT_FILTER_STATE_KEY = 'atGrafana.alertFilter';
export const ALERT_STATE_FILTER_STATE_KEY = 'atGrafana.alertStateFilter';
const ALERT_FILTER_ACTIVE_CONTEXT_KEY = 'atGrafana.alertFilterActive';

const NORMALIZED_ALERT_STATES: readonly NormalizedAlertState[] = ['firing', 'pending', 'normal', 'unknown'];

/**
 * The values the alert-state filter accepts. `paused` is a UI-level filter
 * dimension, not a normalized alert state: paused rules are normalized to
 * `normal` for ranking (Grafana excludes them from live state), so matching
 * them requires the rule's `isPaused` flag -- see `applyFilters`.
 */
export type AlertStateFilter = NormalizedAlertState | 'paused';

const ALERT_STATE_FILTERS: readonly AlertStateFilter[] = [...NORMALIZED_ALERT_STATES, 'paused'];

function isAlertStateFilter(value: unknown): value is AlertStateFilter {
  return typeof value === 'string' && (ALERT_STATE_FILTERS as readonly string[]).includes(value);
}

interface InstanceAlertGroup {
  folderUid: string;
  ruleGroup: string;
  label: string;
  worstState: NormalizedAlertState;
  rules: AlertRuleWithState[];
}

/**
 * Rule *definitions* (`listAlertRules`) and live *state* (`listAlertRuleStates`)
 * are separate Grafana endpoints (see GrafanaAlertsApi.ts) correlated here by
 * `uid`; a definition with no matching state entry is treated as `unknown`
 * rather than thrown away, per UI2 -- unless the definition says `isPaused`,
 * in which case the absence of live state is expected and the rule renders as
 * paused (UX-18). Groups and rules are both sorted firing-first
 * (ALERT_STATE_RANK) within a single instance's subtree.
 */
export class AlertTreeProvider implements vscode.TreeDataProvider<GrafanaTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<GrafanaTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  /** Fires with the new total firing count whenever a fetch changes it; drives the tree view badge (UX-11). */
  private readonly onDidChangeFiringCountEmitter = new vscode.EventEmitter<number>();
  readonly onDidChangeFiringCount = this.onDidChangeFiringCountEmitter.event;

  private readonly instanceGroupsCache = new Map<string, Promise<InstanceAlertGroup[]>>();
  private readonly firingCountByInstance = new Map<string, number>();
  private readonly sharedReads: SharedGrafanaReads;
  private readonly getRefreshIntervalSeconds: (() => number) | undefined;
  private readonly workspaceState: FilterMemento | undefined;
  private filterText: string | undefined;
  private stateFilter: Set<AlertStateFilter> | undefined;
  private treeView: Pick<vscode.TreeView<GrafanaTreeItem>, 'message'> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(
    private readonly configManager: Pick<GrafanaInstanceConfigManager, 'listInstances'>,
    private readonly createClient: AlertClientFactory,
    options: AlertTreeProviderOptions = {}
  ) {
    this.sharedReads = options.sharedReads ?? new SharedGrafanaReads();
    this.getRefreshIntervalSeconds = options.getRefreshIntervalSeconds;
    this.workspaceState = options.workspaceState;
    const persistedText = this.workspaceState?.get<string | undefined>(ALERT_FILTER_STATE_KEY, undefined);
    this.filterText = typeof persistedText === 'string' && persistedText.trim().length > 0 ? persistedText.trim() : undefined;
    const persistedStates = this.workspaceState?.get<unknown>(ALERT_STATE_FILTER_STATE_KEY, []);
    const states = Array.isArray(persistedStates) ? persistedStates.filter(isAlertStateFilter) : [];
    this.stateFilter = states.length > 0 ? new Set(states) : undefined;
    // Initialize the `when`-clause context even when no filter was restored,
    // so the Clear Filter button starts hidden rather than in a stale state
    // from a previous session.
    this.syncFilterContext();
    this.scheduleAutoRefresh();
  }

  attachTreeView(treeView: Pick<vscode.TreeView<GrafanaTreeItem>, 'message'>): void {
    this.treeView = treeView;
    this.updateTreeViewMessage();
  }

  /**
   * Clears the per-instance cache. With an `instanceId`, only that instance's
   * groups and shared folder reads are invalidated; the other instances'
   * settled promises stay cached, so a single-instance edit does not force
   * every other instance to re-fetch on the next expand.
   */
  refresh(instanceId?: string): void {
    if (instanceId !== undefined) {
      this.instanceGroupsCache.delete(instanceId);
      this.sharedReads.invalidate(instanceId);
    } else {
      this.instanceGroupsCache.clear();
      this.sharedReads.invalidateAll();
    }
    this.onDidChangeTreeDataEmitter.fire();
    // Re-read the interval setting on every refresh, so toggling it on/off
    // applies without a configuration-change listener.
    this.scheduleAutoRefresh();
  }

  setFilter(text: string): void {
    const trimmed = text.trim();
    this.filterText = trimmed.length > 0 ? trimmed : undefined;
    this.persistFilters();
    this.syncFilterContext();
    this.updateTreeViewMessage();
    this.onDidChangeTreeDataEmitter.fire();
  }

  setStateFilter(states?: AlertStateFilter[]): void {
    const unique = states ? [...new Set(states)].filter(isAlertStateFilter) : [];
    this.stateFilter = unique.length > 0 ? new Set(unique) : undefined;
    this.persistFilters();
    this.syncFilterContext();
    this.updateTreeViewMessage();
    this.onDidChangeTreeDataEmitter.fire();
  }

  clearFilter(): void {
    if (this.filterText === undefined && this.stateFilter === undefined) {
      return;
    }
    this.filterText = undefined;
    this.stateFilter = undefined;
    this.persistFilters();
    this.syncFilterContext();
    this.updateTreeViewMessage();
    this.onDidChangeTreeDataEmitter.fire();
  }

  getFilter(): string | undefined {
    return this.filterText;
  }

  getStateFilter(): AlertStateFilter[] | undefined {
    return this.stateFilter ? [...this.stateFilter] : undefined;
  }

  /** Sum of firing rules across every instance fetched so far. */
  getFiringCount(): number {
    let total = 0;
    for (const count of this.firingCountByInstance.values()) {
      total += count;
    }
    return total;
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.onDidChangeTreeDataEmitter.dispose();
    this.onDidChangeFiringCountEmitter.dispose();
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
    if (element instanceof AlertGroupTreeItem) {
      return this.getGroupChildren(element);
    }
    return [];
  }

  private async getRootChildren(): Promise<GrafanaTreeItem[]> {
    try {
      const instances = await this.configManager.listInstances();
      if (instances.length === 0) {
        // Empty (not a MessageTreeItem) so VS Code's `viewsWelcome` contribution
        // for `atGrafana.alerts` renders instead, with a clickable
        // "Add Instance" button -- see the identical rationale in
        // DashboardTreeProvider.getRootChildren().
        return [];
      }
      this.pruneFiringCounts(new Set(instances.map((instance) => instance.id)));
      return instances.map((instance) => new InstanceTreeItem(instance));
    } catch (error) {
      return [new ErrorTreeItem(formatError(error))];
    }
  }

  private async getInstanceChildren(instance: GrafanaInstanceConfig): Promise<GrafanaTreeItem[]> {
    let groups: InstanceAlertGroup[];
    try {
      groups = await this.loadInstanceGroups(instance);
    } catch (error) {
      return [new ErrorTreeItem(describeTreeError(error), { instanceId: instance.id, detail: formatError(error) })];
    }
    const visibleGroups = this.applyFilters(groups);
    if (visibleGroups.length === 0) {
      return [
        new MessageTreeItem(
          this.isFilterActive() ? t('No alert rules match the current filter.') : t('No alert rules found.')
        )
      ];
    }
    return visibleGroups.map(
      (group) => new AlertGroupTreeItem(instance, group.folderUid, group.ruleGroup, group.label, group.worstState, group.rules)
    );
  }

  private isFilterActive(): boolean {
    return this.filterText !== undefined || this.stateFilter !== undefined;
  }

  /**
   * Applies the title/state filters to an already-fetched, fully sorted group
   * list. Groups left with no matching rule are dropped. `worstState` is
   * recomputed for the visible subset so a filtered group's colour does not
   * claim a firing rule that the filter hid.
   */
  private applyFilters(groups: InstanceAlertGroup[]): InstanceAlertGroup[] {
    const needle = this.filterText?.toLowerCase();
    const states = this.stateFilter;
    if (needle === undefined && states === undefined) {
      return groups;
    }
    const filtered: InstanceAlertGroup[] = [];
    for (const group of groups) {
      const rules = group.rules.filter(
        (rule) =>
          (needle === undefined || rule.title.toLowerCase().includes(needle)) &&
          (states === undefined ||
            states.has(rule.state) ||
            (states.has('paused') && rule.isPaused === true))
      );
      if (rules.length === 0) {
        continue;
      }
      let worstState = rules[0]!.state;
      for (const rule of rules) {
        if (ALERT_STATE_RANK[rule.state] < ALERT_STATE_RANK[worstState]) {
          worstState = rule.state;
        }
      }
      filtered.push({ ...group, rules, worstState });
    }
    filtered.sort((a, b) => ALERT_STATE_RANK[a.worstState] - ALERT_STATE_RANK[b.worstState] || a.label.localeCompare(b.label));
    return filtered;
  }

  private getGroupChildren(element: AlertGroupTreeItem): GrafanaTreeItem[] {
    if (element.rules.length === 0) {
      return [new MessageTreeItem(t('No alert rules in this group.'))];
    }
    return element.rules.map((rule) => new AlertRuleTreeItem(element.instance, rule));
  }


  private loadInstanceGroups(instance: GrafanaInstanceConfig): Promise<InstanceAlertGroup[]> {
    const cached = this.instanceGroupsCache.get(instance.id);
    if (cached) {
      return cached;
    }
    const promise = this.fetchInstanceGroups(instance);
    this.instanceGroupsCache.set(instance.id, promise);
    return promise;
  }

  private async fetchInstanceGroups(instance: GrafanaInstanceConfig): Promise<InstanceAlertGroup[]> {
    const client = await this.createClient(instance);
    const [rules, states, folders] = await Promise.all([
      client.listAlertRules(),
      client.listAlertRuleStates(),
      this.sharedReads.getFolders(instance.id, () => client.getAllFolders())
    ]);
    const stateIndex = buildAlertStateIndex(states);
    const folderTitleByUid = new Map(folders.map((folder) => [folder.uid, folder.title]));

    const groups = new Map<string, InstanceAlertGroup>();
    let firingCount = 0;
    for (const rule of rules) {
      const correlated = correlateAlertState(rule.uid, stateIndex);
      // A paused rule is excluded from Grafana's live-state endpoint, so its
      // correlated state comes back `unknown`; that absence is expected, not a
      // data problem -- rank it as normal and let the tree item render it as
      // paused (UX-18).
      const normalized =
        rule.isPaused === true && correlated.state === 'unknown' ? 'normal' : correlated.state;
      if (normalized === 'firing') {
        firingCount += 1;
      }
      const ruleWithState: AlertRuleWithState = {
        uid: rule.uid,
        title: rule.title,
        state: normalized,
        rawState: correlated.rawState,
        activeAt: correlated.activeAt,
        isPaused: rule.isPaused
      };

      const key = `${rule.folderUid}::${rule.ruleGroup}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          folderUid: rule.folderUid,
          ruleGroup: rule.ruleGroup,
          label: `${folderTitleByUid.get(rule.folderUid) ?? rule.folderUid} / ${rule.ruleGroup}`,
          worstState: normalized,
          rules: []
        };
        groups.set(key, group);
      }
      group.rules.push(ruleWithState);
      if (ALERT_STATE_RANK[normalized] < ALERT_STATE_RANK[group.worstState]) {
        group.worstState = normalized;
      }
    }

    this.updateFiringCount(instance.id, firingCount);

    const result = [...groups.values()];
    for (const group of result) {
      group.rules.sort((a, b) => ALERT_STATE_RANK[a.state] - ALERT_STATE_RANK[b.state] || a.title.localeCompare(b.title));
    }
    result.sort((a, b) => ALERT_STATE_RANK[a.worstState] - ALERT_STATE_RANK[b.worstState] || a.label.localeCompare(b.label));
    return result;
  }

  private updateFiringCount(instanceId: string, count: number): void {
    if (this.firingCountByInstance.get(instanceId) === count) {
      return;
    }
    this.firingCountByInstance.set(instanceId, count);
    this.onDidChangeFiringCountEmitter.fire(this.getFiringCount());
  }

  private pruneFiringCounts(knownInstanceIds: Set<string>): void {
    let changed = false;
    for (const instanceId of [...this.firingCountByInstance.keys()]) {
      if (!knownInstanceIds.has(instanceId)) {
        this.firingCountByInstance.delete(instanceId);
        changed = true;
      }
    }
    if (changed) {
      this.onDidChangeFiringCountEmitter.fire(this.getFiringCount());
    }
  }

  private persistFilters(): void {
    void this.workspaceState?.update(ALERT_FILTER_STATE_KEY, this.filterText);
    void this.workspaceState?.update(ALERT_STATE_FILTER_STATE_KEY, this.stateFilter ? [...this.stateFilter] : []);
  }

  private syncFilterContext(): void {
    void vscode.commands.executeCommand('setContext', ALERT_FILTER_ACTIVE_CONTEXT_KEY, this.isFilterActive());
  }

  private updateTreeViewMessage(): void {
    if (!this.treeView) {
      return;
    }
    const parts: string[] = [];
    if (this.filterText !== undefined) {
      parts.push(t('Filter: "{filterText}"', { filterText: this.filterText }));
    }
    if (this.stateFilter !== undefined) {
      parts.push(t('States: {states}', { states: [...this.stateFilter].join(', ') }));
    }
    this.treeView.message = parts.length > 0 ? parts.join(' · ') : undefined;
  }

  private scheduleAutoRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.disposed) {
      return;
    }
    const seconds = this.getRefreshIntervalSeconds?.() ?? 0;
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return;
    }
    const timer = setInterval(() => this.refresh(), seconds * 1000);
    // Never keep the extension host process alive over a tree refresh.
    timer.unref?.();
    this.refreshTimer = timer;
  }
}
