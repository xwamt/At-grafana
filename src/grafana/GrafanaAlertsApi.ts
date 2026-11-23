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
  /** Epoch milliseconds. */
  time: number;
  /** Current/new state of the transition when the backend reports one (`next`/`current`). */
  state?: string;
  /** Previous state of the transition (annotation state-history backend). */
  previous?: string;
  /** Raw annotation text (annotation state-history backend). */
  text?: string;
  /** Parsed annotation `data` JSON (annotation state-history backend). */
  data?: unknown;
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
    const raw = await this.http.requestJson<unknown>('GET', '/api/v1/provisioning/alert-rules', {
      maxResponseBytes: MANAGEMENT_MAX_RESPONSE_BYTES
    });
    if (!Array.isArray(raw)) {
      throw new GrafanaApiError('invalid-response', 'Grafana /api/v1/provisioning/alert-rules did not return an array.');
    }
    return raw.map(toAlertRule);
  }

  /**
   * Single-rule fetch via the same provisioning API as `listAlertRules`
   * (`GET /api/v1/provisioning/alert-rules/:uid`, one entry of the list
   * shape) — replaces the old list-then-find in `GrafanaAgentToolService`
   * (PERF-06). An unknown uid surfaces as the transport's
   * `GrafanaApiError` kind `api-error` with status 404.
   */
  async getAlertRule(uid: string): Promise<GrafanaAlertRule> {
    const raw = await this.http.requestJson<unknown>(
      'GET',
      `/api/v1/provisioning/alert-rules/${encodeURIComponent(uid)}`,
      { maxResponseBytes: MANAGEMENT_MAX_RESPONSE_BYTES }
    );
    return toAlertRule(raw);
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
   * Grafana's state-history query endpoint
   * (`GET /api/v1/rules/history?ruleUID=:uid`).
   *
   * Verified against Grafana `13.0.1+security-01` with the default
   * `annotations` state-history backend. That backend returns a DataFrame
   * with fields `time`, `text`, `prev`, `next`, `data`; the Loki backend
   * returns `time`, `line`, `labels`. Both envelopes (`{ results: <frame> }`
   * and a raw frame) are accepted.
   *
   * The annotation backend also passes annotation epoch milliseconds into
   * `time.Unix(..., 0)` (which expects seconds), so its serialized `time`
   * values are 1000x too large. `normalizeHistoryTime` corrects that to
   * epoch milliseconds, which is the documented shape of this method.
   * Unexpected shapes throw `invalid-response` rather than silently
   * returning wrong data.
   */
  async getAlertRuleHistory(uid: string, query: GrafanaAlertHistoryQuery = {}): Promise<GrafanaAlertHistoryEntry[]> {
    const raw = await this.http.requestJson<unknown>('GET', '/api/v1/rules/history', {
      query: {
        ruleUID: uid,
        from: query.from !== undefined ? String(query.from) : undefined,
        to: query.to !== undefined ? String(query.to) : undefined,
        limit: query.limit !== undefined ? String(query.limit) : undefined
      },
      maxResponseBytes: MANAGEMENT_MAX_RESPONSE_BYTES
    });
    const entries = parseHistoryFrame(raw);
    // Grafana's annotation state-history backend ignores `limit` in its
    // annotation query; enforce the caller's requested cap client-side.
    return query.limit !== undefined && query.limit > 0 ? entries.slice(0, query.limit) : entries;
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
    annotations: toStringRecord(entry.annotations),
    // FUNC-01: keep the query definitions and notification-policy references
    // instead of dropping them — grafana_get_alert_rule promises the full
    // definition. Left as unknown pass-throughs (see the interface docs).
    data: entry.data,
    notificationSettings: entry.notification_settings
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
      'Grafana /api/v1/rules/history returned an unrecognized shape.'
    );
  }
  const fieldNames = frame.schema.fields.map((field) => (isRecord(field) && typeof field.name === 'string' ? field.name.toLowerCase() : ''));
  const values = frame.data.values;
  const timeIndex = fieldNames.indexOf('time');
  if (timeIndex === -1 || !Array.isArray(values[timeIndex])) {
    throw new GrafanaApiError('invalid-response', 'Grafana /api/v1/rules/history frame is missing a time field.');
  }
  // `next` / `prev` are the annotation-backend field names; `current` /
  // `state` / `line` cover the Loki backend and older defensive shapes.
  const stateIndex = fieldNames.findIndex((name) => name === 'next' || name === 'current' || name === 'state' || name === 'line');
  const previousIndex = fieldNames.findIndex((name) => name === 'prev' || name === 'previous');
  const textIndex = fieldNames.indexOf('text');
  const dataIndex = fieldNames.indexOf('data');
  const labelsIndex = fieldNames.indexOf('labels');
  const timeColumn = values[timeIndex] as unknown[];
  const stateColumn = stateIndex >= 0 ? (values[stateIndex] as unknown[]) : undefined;
  const previousColumn = previousIndex >= 0 ? (values[previousIndex] as unknown[]) : undefined;
  const textColumn = textIndex >= 0 ? (values[textIndex] as unknown[]) : undefined;
  const dataColumn = dataIndex >= 0 ? (values[dataIndex] as unknown[]) : undefined;
  const labelsColumn = labelsIndex >= 0 ? (values[labelsIndex] as unknown[]) : undefined;
  const stateFieldName = stateIndex >= 0 ? fieldNames[stateIndex] : undefined;

  const entries: GrafanaAlertHistoryEntry[] = [];
  for (let row = 0; row < timeColumn.length; row++) {
    const rawTime = timeColumn[row];
    if (typeof rawTime !== 'number') {
      continue;
    }
    const entry: GrafanaAlertHistoryEntry = { time: normalizeHistoryTime(rawTime) };

    const rawState = stateColumn?.[row];
    if (typeof rawState === 'string') {
      if (stateFieldName === 'line') {
        // Loki backend: `line` is the full JSON transition record, not a
        // plain state string.
        const parsedLine = parseJsonValue(rawState);
        if (isRecord(parsedLine)) {
          if (typeof parsedLine.current === 'string') {
            entry.state = parsedLine.current;
          }
          if (typeof parsedLine.previous === 'string') {
            entry.previous = parsedLine.previous;
          }
          if (isRecord(parsedLine.labels)) {
            entry.labels = toStringRecord(parsedLine.labels);
          }
        } else {
          entry.state = rawState;
        }
      } else {
        entry.state = rawState;
      }
    }

    const rawPrevious = previousColumn?.[row];
    if (entry.previous === undefined && typeof rawPrevious === 'string') {
      entry.previous = rawPrevious;
    }
    const rawText = textColumn?.[row];
    if (typeof rawText === 'string') {
      entry.text = rawText;
    }
    const rawData = dataColumn?.[row];
    if (rawData !== undefined) {
      entry.data = typeof rawData === 'string' ? parseJsonValue(rawData) : rawData;
    }
    if (entry.labels === undefined) {
      entry.labels = toHistoryRecord(labelsColumn?.[row]);
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * Normalizes the various epoch magnitudes a state-history frame can carry
 * into epoch milliseconds. The annotation backend in Grafana 13 passes
 * millisecond annotation epochs to `time.Unix(..., 0)` (seconds), producing
 * values 1000x too large; a real microsecond/legacy value is handled the
 * same way. Nanosecond values are reduced to milliseconds as well.
 */
function normalizeHistoryTime(value: number): number {
  if (!Number.isFinite(value)) {
    return value;
  }
  if (value >= 1e17) {
    return Math.round(value / 1e6);
  }
  if (value >= 1e14) {
    return Math.round(value / 1e3);
  }
  return value;
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function toHistoryRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value === 'string') {
    return toStringRecord(parseJsonValue(value));
  }
  return toStringRecord(value);
}

function unwrapHistoryFrame(raw: unknown): unknown {
  return isRecord(raw) && isRecord(raw.results) ? raw.results : raw;
}
