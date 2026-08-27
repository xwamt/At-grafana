import { GrafanaApiError, type GrafanaHttpClient } from './GrafanaHttpClient';
import { isRecord, readUidOrLegacyId, toStringRecord } from './jsonGuards';
import { MANAGEMENT_MAX_RESPONSE_BYTES } from './QueryLimits';

export interface GrafanaAlertRule {
  uid: string;
  title: string;
  folderUid: string;
  ruleGroup: string;
  condition: string;
  for: string;
  noDataState?: string;
  execErrState?: string;
  isPaused?: boolean;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  /**
   * The provisioning API's `data: AlertQuery[]` — the actual query
   * definitions (PromQL/LogQL + relative time ranges + expression pipeline)
   * behind `condition`'s bare refId. Passed through as `unknown` on purpose:
   * the AlertQuery shape varies by datasource and Grafana version, and the
   * consumers (Agent tools, MGT6/S6) want the raw definition, not a lossy
   * re-parse.
   */
  data?: unknown;
  /** The provisioning API's `notification_settings` (contact point / mute timing references), passed through as-is when present. */
  notificationSettings?: unknown;
}

/** Optional window/limit forwarded to Grafana's state-history endpoint (`from`/`to` are Unix epoch seconds). */
export interface GrafanaAlertHistoryQuery {
  from?: number;
  to?: number;
  limit?: number;
}

export interface GrafanaAlertRuleState {
  uid: string;
  name: string;
  /** e.g. `firing` / `pending` / `inactive` / `normal` per Grafana's ruler API. */
  state: string;
  health?: string;
  folderUid?: string;
  group: string;
  labels?: Record<string, string>;
  activeAt?: string;
}

export interface GrafanaAlertHistoryEntry {
  time: number;
  state?: string;
  labels?: Record<string, string>;
}

export class GrafanaAlertsApi {
  constructor(private readonly http: GrafanaHttpClient) {}

  /**
   * Rule *definitions* (folder/group/condition/labels/annotations) come from
   * the provisioning API, which is stable across Grafana 9.1+ and does NOT
   * report live evaluation state. Live rule *state* (firing/pending/...)
   * is a deliberately separate call — see listAlertRuleStates — because no
   * single Unified Alerting endpoint returns both; a later tree-UI task
   * must correlate the two lists by `uid` (see requirements UI2, "Firing
   * sorted first").
   */
  async listAlertRules(): Promise<GrafanaAlertRule[]> {
    const raw = await this.http.requestJson<unknown>('GET', '/api/v1/provisioning/alert-rules');
    if (!Array.isArray(raw)) {
      throw new GrafanaApiError('invalid-response', 'Grafana /api/v1/provisioning/alert-rules did not return an array.');
    }
    return raw.map(toAlertRule);
  }

  /**
   * Grafana's own Prometheus-compatible ruler endpoint. Returns
   * `groups[].rules[]`, each with a `state` field — this is the only stable
   * way to get current firing/pending/inactive state per rule in Unified
   * Alerting (the provisioning API above has no state field at all).
   */
  async listAlertRuleStates(): Promise<GrafanaAlertRuleState[]> {
    const raw = await this.http.requestJson<unknown>('GET', '/api/prometheus/grafana/api/v1/rules');
    if (!isRecord(raw) || !isRecord(raw.data) || !Array.isArray(raw.data.groups)) {
      throw new GrafanaApiError('invalid-response', 'Grafana /api/prometheus/grafana/api/v1/rules returned an unexpected shape.');
    }
    const states: GrafanaAlertRuleState[] = [];
    for (const group of raw.data.groups) {
      if (!isRecord(group) || !Array.isArray(group.rules)) {
        continue;
      }
      const groupName = typeof group.name === 'string' ? group.name : '';
      // `folderUid` only appears on newer Grafana; older builds of this same
      // ruler endpoint carry the folder as a numeric id.
      const folderUid = readUidOrLegacyId(group.folderUid, group.folderId);
      for (const rule of group.rules) {
        if (!isRecord(rule) || typeof rule.uid !== 'string' || typeof rule.state !== 'string') {
          continue;
        }
        states.push({
          uid: rule.uid,
          name: typeof rule.name === 'string' ? rule.name : '',
          state: rule.state,
          health: typeof rule.health === 'string' ? rule.health : undefined,
          folderUid,
          group: groupName,
          labels: toStringRecord(rule.labels),
          activeAt: typeof rule.activeAt === 'string' ? rule.activeAt : undefined
        });
      }
    }
    return states;
  }

  /**
   * Best-effort against Grafana's state-history query endpoint
   * (`GET /api/v1/rules/history?ruleUID=:uid`), which requires the
   * built-in Loki-backed annotations/history backend. UNVERIFIED against a
   * live Grafana instance: the Go route declares the response as
   * `{ results: <data.Frame> }`, but Grafana's own frontend RTK client
   * queries the same path expecting a raw `DataFrameJSON`
   * (`{ schema: { fields }, data: { values } }`) with no `results`
   * wrapper. We defensively accept either envelope and look up `time` /
   * `current|state|line` / `labels` fields by name, but the exact field
   * names have NOT been confirmed against a running Grafana — flagged in
   * Task 2.1's final report as needing verification against a real
   * instance. Unexpected shapes throw `invalid-response` rather than
   * silently returning wrong data.
   */
  async getAlertRuleHistory(uid: string): Promise<GrafanaAlertHistoryEntry[]> {
    const raw = await this.http.requestJson<unknown>('GET', '/api/v1/rules/history', { query: { ruleUID: uid } });
    return parseHistoryFrame(raw);
  }
}

function toAlertRule(entry: unknown): GrafanaAlertRule {
  if (
    !isRecord(entry) ||
    typeof entry.uid !== 'string' ||
    typeof entry.title !== 'string' ||
    typeof entry.folderUID !== 'string' ||
    typeof entry.ruleGroup !== 'string' ||
    typeof entry.for !== 'string'
  ) {
    throw new GrafanaApiError('invalid-response', 'Grafana provisioning alert rule entry is missing required fields.');
  }
  return {
    uid: entry.uid,
    title: entry.title,
    folderUid: entry.folderUID,
    ruleGroup: entry.ruleGroup,
    condition: typeof entry.condition === 'string' ? entry.condition : '',
    for: entry.for,
    noDataState: typeof entry.noDataState === 'string' ? entry.noDataState : undefined,
    execErrState: typeof entry.execErrState === 'string' ? entry.execErrState : undefined,
    isPaused: typeof entry.isPaused === 'boolean' ? entry.isPaused : undefined,
    labels: toStringRecord(entry.labels),
    annotations: toStringRecord(entry.annotations)
  };
}

function parseHistoryFrame(raw: unknown): GrafanaAlertHistoryEntry[] {
  const frame = unwrapHistoryFrame(raw);
  if (
    !isRecord(frame) ||
    !isRecord(frame.schema) ||
    !Array.isArray(frame.schema.fields) ||
    !isRecord(frame.data) ||
    !Array.isArray(frame.data.values)
  ) {
    throw new GrafanaApiError(
      'invalid-response',
      'Grafana /api/v1/rules/history returned an unrecognized shape (this endpoint is unverified against a live instance).'
    );
  }
  const fieldNames = frame.schema.fields.map((field) => (isRecord(field) && typeof field.name === 'string' ? field.name.toLowerCase() : ''));
  const values = frame.data.values;
  const timeIndex = fieldNames.indexOf('time');
  if (timeIndex === -1 || !Array.isArray(values[timeIndex])) {
    throw new GrafanaApiError('invalid-response', 'Grafana /api/v1/rules/history frame is missing a time field.');
  }
  const stateIndex = fieldNames.findIndex((name) => name === 'current' || name === 'state' || name === 'line');
  const labelsIndex = fieldNames.indexOf('labels');
  const timeColumn = values[timeIndex] as unknown[];
  const stateColumn = stateIndex >= 0 ? (values[stateIndex] as unknown[]) : undefined;
  const labelsColumn = labelsIndex >= 0 ? (values[labelsIndex] as unknown[]) : undefined;

  const entries: GrafanaAlertHistoryEntry[] = [];
  for (let row = 0; row < timeColumn.length; row++) {
    const time = timeColumn[row];
    if (typeof time !== 'number') {
      continue;
    }
    const state = stateColumn?.[row];
    entries.push({
      time,
      state: typeof state === 'string' ? state : undefined,
      labels: toStringRecord(labelsColumn?.[row])
    });
  }
  return entries;
}

function unwrapHistoryFrame(raw: unknown): unknown {
  return isRecord(raw) && isRecord(raw.results) ? raw.results : raw;
}
