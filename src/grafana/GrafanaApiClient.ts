/**
 * Grafana REST client for AT-Grafana (Task 2.1, docs/plans/2026-07-29-at-grafana-v1-implementation-plan.md).
 *
 * Endpoint choices (Grafana 9.1+, Unified Alerting only per requirements §5.3/§6):
 * - health()              -> GET /api/health
 * - search()              -> GET /api/search
 * - getFolders()          -> GET /api/folders
 * - getDashboardByUid()   -> GET /api/dashboards/uid/:uid
 * - listAlertRules()      -> GET /api/v1/provisioning/alert-rules (rule *definitions*; stable, no live state)
 * - listAlertRuleStates() -> GET /api/prometheus/grafana/api/v1/rules (live *state* only; correlate by `uid`)
 * - getAlertRuleHistory() -> GET /api/v1/rules/history?ruleUID=:uid (best-effort; response shape unverified — see GrafanaAlertsApi.ts)
 * - listDatasources()     -> GET /api/datasources
 * - proxyDatasourceRequest() -> GET/POST /api/datasources/proxy/uid/:uid/:path (method allowlist enforced pre-network, ADR-004 MON4)
 *
 * This file only owns wiring + the one endpoint that doesn't belong to any
 * single domain (`health`); dashboards/alerts/datasources concerns live in
 * their own modules to stay under this project's ~300-line file guidance.
 */
import type { AtGrafanaLog } from '../utils/logger';
import { GrafanaAlertsApi } from './GrafanaAlertsApi';
import { GrafanaDashboardsApi } from './GrafanaDashboardsApi';
import { GrafanaDatasourcesApi } from './GrafanaDatasourcesApi';
import { GrafanaApiError, GrafanaHttpClient, type GrafanaCertVerifier } from './GrafanaHttpClient';
import { isRecord } from './jsonGuards';

export { GrafanaApiError, verifyCertFingerprint } from './GrafanaHttpClient';
export type { GrafanaApiErrorKind, GrafanaCertVerifier } from './GrafanaHttpClient';
export type { GrafanaDashboard, GrafanaDashboardSearchQuery, GrafanaFolder, GrafanaSearchResult } from './GrafanaDashboardsApi';
export type { GrafanaAlertHistoryEntry, GrafanaAlertRule, GrafanaAlertRuleState } from './GrafanaAlertsApi';
export type { GrafanaDatasource } from './GrafanaDatasourcesApi';

export interface GrafanaApiClientOptions {
  baseUrl: string;
  token: string;
  certVerifier?: GrafanaCertVerifier;
  timeoutMs?: number;
  /** Forwarded verbatim to `GrafanaHttpClient`; see its option doc. */
  log?: AtGrafanaLog;
}

export interface GrafanaHealth {
  ok: boolean;
  database?: string;
  version?: string;
}

export class GrafanaApiClient {
  private readonly http: GrafanaHttpClient;
  private readonly dashboardsApi: GrafanaDashboardsApi;
  private readonly alertsApi: GrafanaAlertsApi;
  private readonly datasourcesApi: GrafanaDatasourcesApi;

  constructor(options: GrafanaApiClientOptions) {
    this.http = new GrafanaHttpClient(options);
    this.dashboardsApi = new GrafanaDashboardsApi(this.http, options.log);
    this.alertsApi = new GrafanaAlertsApi(this.http);
    this.datasourcesApi = new GrafanaDatasourcesApi(this.http);
  }

  async health(): Promise<GrafanaHealth> {
    const raw = await this.http.requestJson<unknown>('GET', '/api/health');
    if (!isRecord(raw)) {
      throw new GrafanaApiError('invalid-response', 'Grafana /api/health did not return an object.');
    }
    return {
      ok: true,
      database: typeof raw.database === 'string' ? raw.database : undefined,
      version: typeof raw.version === 'string' ? raw.version : undefined
    };
  }

  search(...args: Parameters<GrafanaDashboardsApi['search']>): ReturnType<GrafanaDashboardsApi['search']> {
    return this.dashboardsApi.search(...args);
  }

  searchAll(...args: Parameters<GrafanaDashboardsApi['searchAll']>): ReturnType<GrafanaDashboardsApi['searchAll']> {
    return this.dashboardsApi.searchAll(...args);
  }

  getFolders(): ReturnType<GrafanaDashboardsApi['getFolders']> {
    return this.dashboardsApi.getFolders();
  }

  getAllFolders(
    ...args: Parameters<GrafanaDashboardsApi['getAllFolders']>
  ): ReturnType<GrafanaDashboardsApi['getAllFolders']> {
    return this.dashboardsApi.getAllFolders(...args);
  }

  getDashboardByUid(...args: Parameters<GrafanaDashboardsApi['getDashboardByUid']>): ReturnType<GrafanaDashboardsApi['getDashboardByUid']> {
    return this.dashboardsApi.getDashboardByUid(...args);
  }

  listAlertRules(): ReturnType<GrafanaAlertsApi['listAlertRules']> {
    return this.alertsApi.listAlertRules();
  }

  listAlertRuleStates(): ReturnType<GrafanaAlertsApi['listAlertRuleStates']> {
    return this.alertsApi.listAlertRuleStates();
  }

  getAlertRuleHistory(...args: Parameters<GrafanaAlertsApi['getAlertRuleHistory']>): ReturnType<GrafanaAlertsApi['getAlertRuleHistory']> {
    return this.alertsApi.getAlertRuleHistory(...args);
  }

  listDatasources(): ReturnType<GrafanaDatasourcesApi['listDatasources']> {
    return this.datasourcesApi.listDatasources();
  }

  proxyDatasourceRequest(
    ...args: Parameters<GrafanaDatasourcesApi['proxyDatasourceRequest']>
  ): ReturnType<GrafanaDatasourcesApi['proxyDatasourceRequest']> {
    return this.datasourcesApi.proxyDatasourceRequest(...args);
  }
}
