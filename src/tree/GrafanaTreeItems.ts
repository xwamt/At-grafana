import * as vscode from 'vscode';
import type { GrafanaInstanceConfig } from '../config/schema';
import { t } from '../i18n/t';
import { GrafanaApiError } from '../grafana/GrafanaApiClient';
import { formatError } from '../utils/errors';
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

/**
 * UX-07: the tree renders failures as one red line, so the line has to say
 * what to *do*, not just what broke. Maps the classified
 * `GrafanaApiError.kind` to a localized, actionable message; anything
 * unclassified falls back to `formatError` (which stays the currency of the
 * log channel -- this mapping is presentation-only).
 */
export function describeTreeError(error: unknown): string {
  if (error instanceof GrafanaApiError) {
    switch (error.kind) {
      case 'auth':
        return t('Grafana rejected the token. Edit the instance to update the token.');
      case 'tls':
        return t('The TLS certificate is not trusted yet. Use Test Connection in the instance form or open the instance from the sidebar to confirm its fingerprint.');
      case 'network':
        return t('Grafana could not be reached. Check the instance URL and your network connection.');
      default:
        return formatError(error);
    }
  }
  return formatError(error);
}

export class InstanceTreeItem extends vscode.TreeItem {
  constructor(public readonly instance: GrafanaInstanceConfig) {
    super(instance.label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `atGrafana.instance:${instance.id}`;
    this.contextValue = 'atGrafana.instance';
    // UX-05: the per-instance Agent gate (ADR-004) used to be invisible until
    // you re-opened the edit form. Description + icon expose it at a glance;
    // `lock` when off keeps the "Agent cannot see this" state recognizable
    // without being alarming.
    const agentAccessLabel = instance.allowBackgroundAccess ? t('Agent access on') : t('Agent access off');
    this.iconPath = new vscode.ThemeIcon(instance.allowBackgroundAccess ? 'server-environment' : 'lock');
    this.description = agentAccessLabel;
    this.tooltip = `${instance.url}\n${agentAccessLabel}`;
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
  constructor(public readonly instance: GrafanaInstanceConfig, public readonly uid: string, title: string, url?: string) {
    super(title, vscode.TreeItemCollapsibleState.None);
    this.id = `atGrafana.dashboard:${instance.id}:${uid}`;
    this.contextValue = 'atGrafana.dashboard';
    this.iconPath = new vscode.ThemeIcon('dashboard');
    this.tooltip = url ?? title;
    this.command = {
      command: 'atGrafana.openDashboard',
      title: t('Open Dashboard'),
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

export interface ErrorTreeItemOptions {
  /**
   * When the failure belongs to one instance, clicking the error node opens
   * that instance's edit form (UX-07) -- the fix for auth/URL problems lives
   * there.
   */
  instanceId?: string;
  /** Raw `formatError` text, kept in the tooltip for diagnosis. */
  detail?: string;
}

export class ErrorTreeItem extends vscode.TreeItem {
  constructor(message: string, options: ErrorTreeItemOptions = {}) {
    super(t('Failed to load'), vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'atGrafana.error';
    this.iconPath = new vscode.ThemeIcon('error');
    this.description = message;
    this.tooltip = options.detail && options.detail !== message ? `${message}\n${options.detail}` : message;
    if (options.instanceId) {
      this.command = {
        command: 'atGrafana.editInstance',
        title: t('Edit Instance'),
        arguments: [{ instanceId: options.instanceId }]
      };
    }
  }
}

export interface AlertRuleWithState {
  uid: string;
  title: string;
  state: NormalizedAlertState;
  rawState?: string;
  activeAt?: string;
  /** From the provisioning definition; paused rules have no live state and must not render as "unknown" (UX-18). */
  isPaused?: boolean;
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
    const firingCount = rules.filter((rule) => rule.state === 'firing').length;
    if (firingCount > 0) {
      // UX-18: the firing-first sort is only visible if the count is; a group
      // header that says "3 rules · 1 firing" explains its own red icon.
      this.description =
        rules.length === 1
          ? t('{count} rule · {firing} firing', { count: rules.length, firing: firingCount })
          : t('{count} rules · {firing} firing', { count: rules.length, firing: firingCount });
    } else {
      this.description =
        rules.length === 1
          ? t('{count} rule', { count: rules.length })
          : t('{count} rules', { count: rules.length });
    }
  }
}

export class AlertRuleTreeItem extends vscode.TreeItem {
  constructor(public readonly instance: GrafanaInstanceConfig, public readonly rule: AlertRuleWithState) {
    super(rule.title, vscode.TreeItemCollapsibleState.None);
    this.id = `atGrafana.alertRule:${instance.id}:${rule.uid}`;
    this.contextValue = 'atGrafana.alertRule';
    if (rule.isPaused) {
      // UX-18: a paused rule is an explicit user decision in Grafana, not an
      // unknown state -- give it its own icon and label instead of the
      // "no state reported" rendering below.
      this.iconPath = new vscode.ThemeIcon('debug-pause');
      this.description = t('paused');
      this.tooltip = t('State: {state}', { state: t('paused') });
    } else {
      this.iconPath = alertStateIcon(rule.state);
      const stateLabel = rule.rawState ?? rule.state;
      this.description = stateLabel;
      this.tooltip = rule.activeAt
        ? t('State: {state}\nActive since: {time}', { state: stateLabel, time: rule.activeAt })
        : t('State: {state}', { state: stateLabel });
    }
    this.command = {
      command: 'atGrafana.openAlertRule',
      title: t('Open Alert Rule'),
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
