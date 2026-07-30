import * as vscode from 'vscode';
import type { GrafanaInstanceConfig } from '../config/schema';
// NormalizedAlertState/ALERT_STATE_RANK/normalizeAlertState moved to
// src/grafana/correlateAlertState.ts (Task 5.1), shared with
// GrafanaAgentToolService; AlertTreeProvider now imports the rank/normalize
// helpers from there directly instead of through this module.
import type { NormalizedAlertState } from '../grafana/correlateAlertState';

function alertStateIcon(state: NormalizedAlertState): vscode.ThemeIcon {
  switch (state) {
    case 'firing':
      return new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('problemsErrorIcon.foreground'));
    case 'pending':
      return new vscode.ThemeIcon('bell', new vscode.ThemeColor('problemsWarningIcon.foreground'));
    case 'normal':
      return new vscode.ThemeIcon('check');
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

export function dashboardRouteFromUrl(url?: string): { slug?: string; search?: string } {
  if (!url) {
    return {};
  }
  try {
    const parsed = url.startsWith('/') ? new URL(url, 'http://grafana.invalid') : new URL(url);
    const slugMatch = /^\/d\/[^/]+\/([^/?#]+)/.exec(parsed.pathname);
    const slug = slugMatch?.[1] ? decodeURIComponent(slugMatch[1]) : undefined;
    const search = parsed.search || undefined;
    return { slug, search };
  } catch {
    return {};
  }
}

export class InstanceTreeItem extends vscode.TreeItem {
  constructor(public readonly instance: GrafanaInstanceConfig) {
    super(instance.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `atGrafana.instance:${instance.id}`;
    this.contextValue = 'atGrafana.instance';
    this.iconPath = new vscode.ThemeIcon('server-environment');
    this.tooltip = instance.url;
  }
}

export class FolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly instance: GrafanaInstanceConfig,
    public readonly folderUid: string | undefined,
    folderTitle: string
  ) {
    super(folderTitle, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `atGrafana.folder:${instance.id}:${folderUid ?? '__general__'}`;
    this.contextValue = 'atGrafana.folder';
    this.iconPath = new vscode.ThemeIcon('folder');
  }
}

export class DashboardTreeItem extends vscode.TreeItem {
  constructor(instance: GrafanaInstanceConfig, public readonly uid: string, title: string, url?: string) {
    super(title, vscode.TreeItemCollapsibleState.None);
    this.id = `atGrafana.dashboard:${instance.id}:${uid}`;
    this.contextValue = 'atGrafana.dashboard';
    this.iconPath = new vscode.ThemeIcon('dashboard');
    this.tooltip = url ?? title;
    // TODO(phase-4): replace with the real dashboard Webview panel command (Task 4.2).
    this.command = {
      command: 'atGrafana.openDashboard',
      title: 'Open Dashboard',
      arguments: [{ instanceId: instance.id, uid, title, ...dashboardRouteFromUrl(url) }]
    };
  }
}

export class MessageTreeItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'atGrafana.message';
    this.iconPath = new vscode.ThemeIcon('circle-outline');
  }
}

export class ErrorTreeItem extends vscode.TreeItem {
  constructor(message: string) {
    super('Failed to load', vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'atGrafana.error';
    this.iconPath = new vscode.ThemeIcon('error');
    this.description = message;
    this.tooltip = message;
  }
}

export interface AlertRuleWithState {
  uid: string;
  title: string;
  state: NormalizedAlertState;
  rawState?: string;
  activeAt?: string;
}

export class AlertGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly instance: GrafanaInstanceConfig,
    public readonly folderUid: string,
    public readonly ruleGroup: string,
    label: string,
    public readonly worstState: NormalizedAlertState,
    public readonly rules: AlertRuleWithState[]
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `atGrafana.alertGroup:${instance.id}:${folderUid}:${ruleGroup}`;
    this.contextValue = 'atGrafana.alertGroup';
    this.iconPath = alertStateIcon(worstState);
    this.description = `${rules.length} rule${rules.length === 1 ? '' : 's'}`;
  }
}

export class AlertRuleTreeItem extends vscode.TreeItem {
  constructor(instance: GrafanaInstanceConfig, public readonly rule: AlertRuleWithState) {
    super(rule.title, vscode.TreeItemCollapsibleState.None);
    this.id = `atGrafana.alertRule:${instance.id}:${rule.uid}`;
    this.contextValue = 'atGrafana.alertRule';
    this.iconPath = alertStateIcon(rule.state);
    const stateLabel = rule.rawState ?? rule.state;
    this.description = stateLabel;
    this.tooltip = rule.activeAt ? `State: ${stateLabel}\nActive since: ${rule.activeAt}` : `State: ${stateLabel}`;
    // TODO(phase-4): replace with the real alert-rule detail Webview panel command (Task 4.3).
    this.command = {
      command: 'atGrafana.openAlertRule',
      title: 'Open Alert Rule',
      arguments: [{ instanceId: instance.id, uid: rule.uid, title: rule.title }]
    };
  }
}

export type GrafanaTreeItem =
  | InstanceTreeItem
  | FolderTreeItem
  | DashboardTreeItem
  | AlertGroupTreeItem
  | AlertRuleTreeItem
  | MessageTreeItem
  | ErrorTreeItem;
