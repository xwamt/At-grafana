export type GrafanaDeeplinkKind = 'dashboard' | 'explore' | 'alertRule';

export interface GrafanaDashboardDeeplinkInput {
  kind: 'dashboard';
  uid: string;
  panelId?: number;
  from?: string;
  to?: string;
}

export interface GrafanaExploreDeeplinkInput {
  kind: 'explore';
  datasourceUid: string;
  /** Optional initial query expression written into `queries[0].expr` so Explore opens pre-populated. */
  expr?: string;
  from?: string;
  to?: string;
}

export interface GrafanaAlertRuleDeeplinkInput {
  kind: 'alertRule';
  uid: string;
}

export type GrafanaDeeplinkInput = GrafanaDashboardDeeplinkInput | GrafanaExploreDeeplinkInput | GrafanaAlertRuleDeeplinkInput;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function buildOpenInIdeSearch(input: { panelId?: number; from?: string; to?: string }): string {
  const params = new URLSearchParams();
  if (input.panelId !== undefined) {
    params.set('viewPanel', String(input.panelId));
  }
  if (input.from !== undefined) {
    params.set('from', input.from);
  }
  if (input.to !== undefined) {
    params.set('to', input.to);
  }
  return params.toString();
}

export function buildGrafanaDeeplink(instanceUrl: string, input: GrafanaDeeplinkInput): string {
  const origin = stripTrailingSlash(instanceUrl);
  if (input.kind === 'dashboard') {
    const search = buildOpenInIdeSearch(input);
    return search.length > 0
      ? `${origin}/d/${encodeURIComponent(input.uid)}?${search}`
      : `${origin}/d/${encodeURIComponent(input.uid)}`;
  }
  if (input.kind === 'alertRule') {
    // Grafana's native Unified Alerting rule view page — same route the
    // embed proxy mirrors (see GrafanaEmbedProxy's `/alerting/grafana/:uid/view`).
    return `${origin}/alerting/grafana/${encodeURIComponent(input.uid)}/view`;
  }
  const query: Record<string, unknown> = { refId: 'A', datasource: { uid: input.datasourceUid } };
  if (input.expr !== undefined) {
    query.expr = input.expr;
  }
  const left = {
    datasource: input.datasourceUid,
    queries: [query],
    range: { from: input.from ?? 'now-1h', to: input.to ?? 'now' }
  };
  return `${origin}/explore?left=${encodeURIComponent(JSON.stringify(left))}`;
}
