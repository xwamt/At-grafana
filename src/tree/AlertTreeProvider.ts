import * as vscode from 'vscode';
import type { GrafanaInstanceConfigManager } from '../config/GrafanaInstanceConfigManager';
import type { GrafanaInstanceConfig } from '../config/schema';
import type { GrafanaApiClient } from '../grafana/GrafanaApiClient';
import { formatError } from '../utils/errors';
import {
  ALERT_STATE_RANK,
  AlertGroupTreeItem,
  AlertRuleTreeItem,
  ErrorTreeItem,
  InstanceTreeItem,
  MessageTreeItem,
  normalizeAlertState,
  type AlertRuleWithState,
  type GrafanaTreeItem,
  type NormalizedAlertState
} from './GrafanaTreeItems';

export type AlertApiClient = Pick<GrafanaApiClient, 'listAlertRules' | 'listAlertRuleStates' | 'getFolders'>;
export type AlertClientFactory = (instance: GrafanaInstanceConfig) => Promise<AlertApiClient>;

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
 * rather than thrown away, per UI2. Groups and rules are both sorted
 * firing-first (ALERT_STATE_RANK) within a single instance's subtree.
 */
export class AlertTreeProvider implements vscode.TreeDataProvider<GrafanaTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<GrafanaTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly instanceGroupsCache = new Map<string, Promise<InstanceAlertGroup[]>>();

  constructor(
    private readonly configManager: Pick<GrafanaInstanceConfigManager, 'listInstances'>,
    private readonly createClient: AlertClientFactory
  ) {}

  refresh(): void {
    this.instanceGroupsCache.clear();
    this.onDidChangeTreeDataEmitter.fire();
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
        return [new MessageTreeItem('No Grafana instances configured. Run "AT Grafana: Add Instance" to get started.')];
      }
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
      return [new ErrorTreeItem(formatError(error))];
    }
    if (groups.length === 0) {
      return [new MessageTreeItem('No alert rules found.')];
    }
    return groups.map(
      (group) => new AlertGroupTreeItem(instance, group.folderUid, group.ruleGroup, group.label, group.worstState, group.rules)
    );
  }

  private getGroupChildren(element: AlertGroupTreeItem): GrafanaTreeItem[] {
    if (element.rules.length === 0) {
      return [new MessageTreeItem('No alert rules in this group.')];
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
      client.getFolders()
    ]);
    const stateByUid = new Map(states.map((state) => [state.uid, state]));
    const folderTitleByUid = new Map(folders.map((folder) => [folder.uid, folder.title]));

    const groups = new Map<string, InstanceAlertGroup>();
    for (const rule of rules) {
      const liveState = stateByUid.get(rule.uid);
      const normalized = normalizeAlertState(liveState?.state);
      const ruleWithState: AlertRuleWithState = {
        uid: rule.uid,
        title: rule.title,
        state: normalized,
        rawState: liveState?.state,
        activeAt: liveState?.activeAt
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

    const result = [...groups.values()];
    for (const group of result) {
      group.rules.sort((a, b) => ALERT_STATE_RANK[a.state] - ALERT_STATE_RANK[b.state] || a.title.localeCompare(b.title));
    }
    result.sort((a, b) => ALERT_STATE_RANK[a.worstState] - ALERT_STATE_RANK[b.worstState] || a.label.localeCompare(b.label));
    return result;
  }
}
