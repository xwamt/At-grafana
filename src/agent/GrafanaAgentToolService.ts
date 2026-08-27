import type { z } from 'zod';
import type { GrafanaInstanceConfigManager } from '../config/GrafanaInstanceConfigManager';
import type { GrafanaCertTrustStore } from '../grafana/GrafanaCertTrustStore';
import { buildAlertStateIndex, correlateAlertState } from '../grafana/correlateAlertState';
import type { GrafanaApiClient } from '../grafana/GrafanaApiClient';
import { GrafanaApiError, type GrafanaCertVerifier } from '../grafana/GrafanaHttpClient';
import {
  buildResponseSizeTruncationEnvelope,
  buildTimeRangeTruncationEnvelope,
  DEFAULT_MAX_CONCURRENT_QUERIES,
  DEFAULT_MAX_LOKI_LIMIT,
  DEFAULT_MAX_QUERIES_PER_MINUTE,
  DEFAULT_MAX_QUERY_POINTS,
  DEFAULT_QUERY_TIMEOUT_MS,
  planQueryLimits,
  resolveMaxRangeMs,
  resolveMaxResponseBytes,
  type EffectiveQueryLimits
} from '../grafana/QueryLimits';
import { QueryRateLimiter, QueryThrottledError } from '../grafana/QueryRateLimiter';
import {
  buildLokiLabelNamesCall,
  buildLokiLabelValuesCall,
  buildPrometheusLabelValuesCall,
  buildPrometheusMetricNamesCall,
  projectDiscoveryValues
} from '../grafana/typedDatasourceDiscovery';
import { buildLokiProxyCall, buildPrometheusProxyCall } from '../grafana/typedDatasourceQueries';
import { formatError } from '../utils/errors';
import type { AtGrafanaLog } from '../utils/logger';
import { buildGrafanaDeeplink, buildOpenInIdeSearch } from '../grafana/grafanaDeeplink';
import {
  describeZodError,
  grafanaGetAlertHistorySchema,
  grafanaGetAlertRuleSchema,
  grafanaGetDashboardSchema,
  grafanaListAlertRulesSchema,
  grafanaListAnnotationsSchema,
  grafanaGenerateDeeplinkSchema,
  grafanaListDashboardsSchema,
  grafanaListDatasourcesSchema,
  grafanaListFoldersSchema,
  grafanaListInstancesSchema,
  grafanaListLokiLabelNamesSchema,
  grafanaListLokiLabelValuesSchema,
  grafanaListPrometheusLabelValuesSchema,
  grafanaListPrometheusMetricNamesSchema,
  grafanaQueryDatasourceSchema,
  grafanaQueryLokiSchema,
  grafanaQueryPrometheusSchema,
  type GrafanaQueryDatasourceInput
} from '../mcp/bridgeSchemas';
import { projectDashboard } from './projectDashboard';

/**
 * The subset of `GrafanaApiClient` every tool call needs (management +
 * monitoring-data families). Kept as a `Pick<...>` (same pattern as
 * `DashboardApiClient`/`AlertApiClient` in the tree providers) so tests can
 * pass a plain fake object instead of a real HTTP-backed client.
 */
export type GrafanaApiClientLike = Pick<
  GrafanaApiClient,
  | 'search'
  | 'getFolders'
  | 'getDashboardByUid'
  | 'listAlertRules'
  | 'getAlertRule'
  | 'listAlertRuleStates'
  | 'getAlertRuleHistory'
  | 'listDatasources'
  | 'listAnnotations'
  | 'proxyDatasourceRequest'
>;

/**
 * Builds the per-call `GrafanaApiClient` (or a test fake shaped like one).
 * `certVerifier` is threaded through explicitly (rather than baked into the
 * factory closure) so a single `GrafanaAgentToolService` instance can hand
 * each call a verifier built from its own injected `certTrustStore` -- see
 * the class doc's "TLS trust" section for why that verifier must be
 * non-interactive.
 */
export type GrafanaAgentClientFactory = (baseUrl: string, token: string, certVerifier: GrafanaCertVerifier) => GrafanaApiClientLike;

/**
 * `UNAVAILABLE` is the transient one: the call was well-formed and
 * authorized, and repeating it later will work. It is deliberately distinct
 * from `VALIDATION_ERROR`, which is what an authorization refusal uses here
 * -- see `queryDatasource` and INV-5.
 */
export type ToolInvokeErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'INTERNAL_ERROR' | 'UNAVAILABLE';

export interface ToolInvokeSuccess {
  ok: true;
  result: unknown;
}

export interface ToolInvokeFailure {
  ok: false;
  code: ToolInvokeErrorCode;
  message: string;
}

export type ToolInvokeResult = ToolInvokeSuccess | ToolInvokeFailure;

export interface GrafanaAgentToolServiceDependencies {
  configManager: Pick<GrafanaInstanceConfigManager, 'listInstances' | 'getInstance' | 'getToken'>;
  certTrustStore: GrafanaCertTrustStore;
  createClient: GrafanaAgentClientFactory;
  /**
   * Reads the currently effective `atGrafana.queryLimits.*` VS Code settings
   * (Task 6.1, requirements §5.2) at call time -- not once at construction
   * -- so a user editing them mid-session takes effect on the very next
   * `grafana_query_datasource` call. Kept as a plain function returning raw
   * numbers (rather than a `vscode.workspace.getConfiguration` import here)
   * so this class stays testable without a VS Code host; `src/extension.ts`
   * supplies the actual reader. Omitted entirely (e.g. in tests that don't
   * care about limits) falls back to QueryLimits.ts's proposed defaults.
   */
  getQueryLimitsConfig?: () => RawQueryLimitsConfig;
  /**
   * Injectable so tests can drive the bucket from a fake clock instead of
   * sleeping. Omitted in real usage, which builds one from the defaults.
   */
  queryRateLimiter?: QueryRateLimiter;
  /**
   * Handed to the `QueryRateLimiter` this class builds when none is injected,
   * so a shed query says which instance ran out of budget. Ignored when
   * `queryRateLimiter` is supplied -- that limiter carries its own.
   */
  log?: AtGrafanaLog;
  /**
   * Optional IDE opener for `grafana_generate_deeplink` with `openInIde: true`.
   * Injected by `src/extension.ts` so this class stays vscode-free.
   */
  openDashboardInIde?: (args: {
    instanceId: string;
    uid: string;
    title?: string;
    search?: string;
  }) => Promise<void>;
}

/** Raw, unresolved `atGrafana.queryLimits.*` values; `undefined` means "not configured," resolved via QueryLimits.ts. */
export interface RawQueryLimitsConfig {
  maxRangeMs?: number;
  maxResponseBytes?: number;
}

/**
 * Identical rejection message whether `instanceId` doesn't exist at all or
 * exists but has `allowBackgroundAccess=false`.
 *
 * ADR-004's Decision section is explicit that the toggle is enforced "must
 * still be rejected" for an agent that already knows an instanceId, and its
 * Consequences section frames the toggle as the *only* authorization gate --
 * but the ADR text does not literally spell out whether the two rejection
 * cases must be textually indistinguishable. This implementation chooses to
 * make them indistinguishable anyway: giving different messages for
 * "unknown id" vs "known id, access disabled" would let a caller that has no
 * business touching a given instance enumerate which instanceId values are
 * valid, simply by noticing which error message it gets back. That is
 * exactly the kind of oracle an authorization boundary should not expose,
 * even though nothing in this V1 catalog leaks secrets beyond the id/label/
 * url already visible via `grafana_list_instances` for *authorized*
 * instances. See GrafanaAgentToolService.test.ts.
 */
const UNAUTHORIZED_INSTANCE_MESSAGE =
  'Unknown Grafana instance, or this instance does not have Agent background access enabled.';

/**
 * UX-15: one hint for both empty cases ("no instances configured at all" and
 * "instances exist but every gate is off") — distinguishing them would hand
 * an unauthorized caller the same enumeration oracle
 * UNAUTHORIZED_INSTANCE_MESSAGE exists to close.
 */
const EMPTY_INSTANCES_HINT =
  "No instances have 'Allow background Agent access' enabled. Ask the user to enable it per instance in the AT Grafana extension.";

/**
 * UX-08: appended to a `tls`-kind failure so a headless Agent (which can
 * never answer the Trust-On-First-Use prompt itself — see the class doc)
 * relays an actionable recovery path instead of a dead-end certificate error.
 */
const TLS_TRUST_RECOVERY_HINT =
  ' The user must open this instance once in the AT Grafana sidebar to confirm its TLS fingerprint (Trust-On-First-Use).';

/** FUNC-04: `/api/v1/rules/history` only exists when Grafana's Loki-backed alerting state history backend is enabled. */
const ALERT_HISTORY_DISABLED_HINT =
  ' Alert state history may be disabled on this Grafana instance: /api/v1/rules/history requires the Loki-backed alerting state history backend to be enabled.';

/**
 * The ADR-004 authorization + dispatch authority for AT Grafana's MCP tools
 * (Task 5.1) -- analogous to `at-terminal-series`'s `AgentToolService`, but
 * built directly from ADR-004's spec since that file isn't available in this
 * repo. `BridgeServer` owns transport/validation/catalog-lookup only; this
 * class owns the actual "is this call allowed, and what does it return"
 * decision, so it is independently testable and independently the single
 * place ADR-004's authorization rule is enforced.
 *
 * ## TLS trust: non-interactive by design
 *
 * A Bridge `/invoke` call can be triggered by a background/headless Agent at
 * any time, with no user attention available to answer a Trust-On-First-Use
 * prompt -- unlike `GrafanaEmbedProxy`'s webview-driven requests or a future
 * "test connection" flow in the instance form, both of which run on a user
 * gesture. Popping `vscode.window.showWarningMessage` from here would be a
 * confusing UX surprise at best (a modal appearing with no visible trigger)
 * and a dangerous one at worst (a call silently blocking forever on input an
 * automated caller can never provide). So the `certVerifier` built here
 * (`createCertVerifier`) only ever consults `certTrustStore.check(...)` and
 * returns `true` for an already-`'trusted'` fingerprint -- exactly the same
 * non-interactive pattern `GrafanaEmbedProxy.defaultCertVerifier` uses for
 * the same reason. An instance whose certificate has never been trusted (or
 * whose fingerprint changed) simply fails the tool call with a clear error;
 * it never prompts.
 */
export class GrafanaAgentToolService {
  private readonly queryRateLimiter: QueryRateLimiter;

  constructor(private readonly deps: GrafanaAgentToolServiceDependencies) {
    this.queryRateLimiter =
      deps.queryRateLimiter ??
      new QueryRateLimiter({
        maxRequestsPerWindow: DEFAULT_MAX_QUERIES_PER_MINUTE,
        windowMs: 60_000,
        maxConcurrent: DEFAULT_MAX_CONCURRENT_QUERIES,
        log: deps.log
      });
  }

  async invoke(name: string, args: unknown): Promise<ToolInvokeResult> {
    try {
      switch (name) {
        case 'grafana_list_instances':
          return await this.listInstances(args);
        case 'grafana_list_dashboards':
          return await this.withAuthorizedClient(grafanaListDashboardsSchema, args, (client, parsed) =>
            this.listDashboards(client, parsed)
          );
        case 'grafana_get_dashboard':
          return await this.withAuthorizedClient(grafanaGetDashboardSchema, args, async (client, parsed) => {
            const dashboard = await client.getDashboardByUid(parsed.uid).catch((error: unknown) => {
              throw enrichOversizedDashboardError(error, parsed.uid);
            });
            return projectDashboard(dashboard, {
              fields: parsed.fields,
              panelIds: parsed.panelIds,
              titleContains: parsed.titleContains
            });
          });
        case 'grafana_list_folders':
          return await this.withAuthorizedClient(grafanaListFoldersSchema, args, (client) => client.getFolders());
        case 'grafana_list_alert_rules':
          return await this.withAuthorizedClient(grafanaListAlertRulesSchema, args, (client, parsed) =>
            this.listAlertRules(client, parsed)
          );
        case 'grafana_get_alert_rule':
          // Single provisioning GET (PERF-06) — returns the full definition
          // including `data` query definitions and notificationSettings
          // (FUNC-01); an unknown uid is the transport's api-error 404,
          // which toFailure maps to NOT_FOUND exactly like before.
          return await this.withAuthorizedClient(grafanaGetAlertRuleSchema, args, (client, parsed) =>
            client.getAlertRule(parsed.uid)
          );
        case 'grafana_get_alert_history':
          return await this.withAuthorizedClient(grafanaGetAlertHistorySchema, args, (client, parsed) =>
            this.getAlertRuleHistory(client, parsed)
          );
        case 'grafana_list_annotations':
          return await this.withAuthorizedClient(grafanaListAnnotationsSchema, args, (client, parsed) =>
            client.listAnnotations({
              from: parsed.from,
              to: parsed.to,
              dashboardUid: parsed.dashboardUid,
              tag: parsed.tag,
              limit: parsed.limit
            })
          );
        case 'grafana_generate_deeplink':
          return await this.withAuthorizedClient(grafanaGenerateDeeplinkSchema, args, async (_client, parsed) => {
            const instance = await this.deps.configManager.getInstance(parsed.instanceId);
            const grafanaUrl = buildGrafanaDeeplink(instance!.url, parsed);
            if (parsed.kind !== 'dashboard' || parsed.openInIde !== true) {
              return { grafanaUrl, openedInIde: false };
            }
            const opener = this.deps.openDashboardInIde;
            if (!opener) {
              return { grafanaUrl, openedInIde: false, message: 'IDE opener is not available.' };
            }
            try {
              await opener({
                instanceId: parsed.instanceId,
                uid: parsed.uid,
                title: parsed.title,
                search: buildOpenInIdeSearch(parsed) || undefined
              });
              return { grafanaUrl, openedInIde: true };
            } catch (error) {
              return { grafanaUrl, openedInIde: false, message: formatError(error) };
            }
          });
        case 'grafana_list_datasources':
          return await this.withAuthorizedClient(grafanaListDatasourcesSchema, args, (client) => this.listDatasources(client));
        case 'grafana_query_datasource':
          return await this.withAuthorizedClient(grafanaQueryDatasourceSchema, args, (client, parsed) =>
            this.queryDatasource(client, parsed)
          );
        case 'grafana_query_prometheus':
          return await this.withAuthorizedClient(grafanaQueryPrometheusSchema, args, (client, parsed) => {
            const proxy = buildPrometheusProxyCall(parsed);
            return this.queryDatasource(client, {
              instanceId: parsed.instanceId,
              datasourceUid: parsed.datasourceUid,
              method: proxy.method,
              path: proxy.path,
              query: proxy.query
            });
          });
        case 'grafana_query_loki':
          return await this.withAuthorizedClient(grafanaQueryLokiSchema, args, (client, parsed) => {
            const proxy = buildLokiProxyCall(parsed);
            return this.queryDatasource(client, {
              instanceId: parsed.instanceId,
              datasourceUid: parsed.datasourceUid,
              method: proxy.method,
              path: proxy.path,
              query: proxy.query
            });
          });
        case 'grafana_list_prometheus_metric_names':
          return await this.withAuthorizedClient(grafanaListPrometheusMetricNamesSchema, args, async (client, parsed) => {
            const proxy = buildPrometheusMetricNamesCall(parsed);
            const result = await this.queryDatasource(client, {
              instanceId: parsed.instanceId,
              datasourceUid: parsed.datasourceUid,
              method: proxy.method,
              path: proxy.path,
              query: proxy.query
            });
            return this.projectProxyDiscovery(result, parsed.regex);
          });
        case 'grafana_list_prometheus_label_values':
          return await this.withAuthorizedClient(grafanaListPrometheusLabelValuesSchema, args, async (client, parsed) => {
            const proxy = buildPrometheusLabelValuesCall(parsed);
            const result = await this.queryDatasource(client, {
              instanceId: parsed.instanceId,
              datasourceUid: parsed.datasourceUid,
              method: proxy.method,
              path: proxy.path,
              query: proxy.query
            });
            return this.projectProxyDiscovery(result, parsed.regex);
          });
        case 'grafana_list_loki_label_names':
          return await this.withAuthorizedClient(grafanaListLokiLabelNamesSchema, args, async (client, parsed) => {
            const proxy = buildLokiLabelNamesCall(parsed);
            const result = await this.queryDatasource(client, {
              instanceId: parsed.instanceId,
              datasourceUid: parsed.datasourceUid,
              method: proxy.method,
              path: proxy.path,
              query: proxy.query
            });
            return this.projectProxyDiscovery(result, parsed.regex);
          });
        case 'grafana_list_loki_label_values':
          return await this.withAuthorizedClient(grafanaListLokiLabelValuesSchema, args, async (client, parsed) => {
            const proxy = buildLokiLabelValuesCall(parsed);
            const result = await this.queryDatasource(client, {
              instanceId: parsed.instanceId,
              datasourceUid: parsed.datasourceUid,
              method: proxy.method,
              path: proxy.path,
              query: proxy.query
            });
            return this.projectProxyDiscovery(result, parsed.regex);
          });
        default:
          return { ok: false, code: 'NOT_FOUND', message: `Unknown AT Grafana tool: ${name}` };
      }
    } catch (error) {
      return this.toFailure(error);
    }
  }

  private async listInstances(args: unknown): Promise<ToolInvokeResult> {
    const parsed = grafanaListInstancesSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, code: 'VALIDATION_ERROR', message: describeZodError(parsed.error) };
    }
    const instances = await this.deps.configManager.listInstances();
    // Per ADR-004/MGT1: id/label/url only, and only instances with
    // background access explicitly enabled -- never the token, never a
    // toggled-off instance.
    const authorized = instances
      .filter((instance) => instance.allowBackgroundAccess)
      .map((instance) => ({ id: instance.id, label: instance.label, url: instance.url }));
    // UX-15: an envelope instead of a bare array, so the empty case can
    // carry a recovery hint (see EMPTY_INSTANCES_HINT for why the hint never
    // distinguishes "nothing configured" from "every gate off").
    const result =
      authorized.length === 0 ? { instances: authorized, hint: EMPTY_INSTANCES_HINT } : { instances: authorized };
    return { ok: true, result };
  }

  private async withAuthorizedClient<Schema extends z.ZodType<{ instanceId: string }>>(
    schema: Schema,
    args: unknown,
    run: (client: GrafanaApiClientLike, parsed: z.infer<Schema>) => Promise<unknown>
  ): Promise<ToolInvokeResult> {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, code: 'VALIDATION_ERROR', message: describeZodError(parsed.error) };
    }

    const instance = await this.deps.configManager.getInstance(parsed.data.instanceId);
    if (!instance || !instance.allowBackgroundAccess) {
      return { ok: false, code: 'VALIDATION_ERROR', message: UNAUTHORIZED_INSTANCE_MESSAGE };
    }

    const token = await this.deps.configManager.getToken(instance.id);
    if (!token) {
      // Distinct from UNAUTHORIZED_INSTANCE_MESSAGE: the caller already
      // cleared the authorization check above (this instanceId is real and
      // opted into background access), so there is nothing left to hide by
      // being generic here -- this is a configuration problem, not an
      // authorization decision.
      return {
        ok: false,
        code: 'INTERNAL_ERROR',
        message: `No Service Account Token is configured for "${instance.label}".`
      };
    }

    const client = this.deps.createClient(instance.url, token, this.createCertVerifier());
    let result: unknown;
    try {
      result = await run(client, parsed.data);
    } catch (error) {
      throw appendTlsRecoveryHint(error);
    }
    return { ok: true, result };
  }

  private createCertVerifier(): GrafanaCertVerifier {
    const store = this.deps.certTrustStore;
    return {
      verify: async (host, port, fingerprint) => (await store.check(host, port, fingerprint)) === 'trusted'
    };
  }

  private async listDashboards(
    client: GrafanaApiClientLike,
    parsed: { query?: string; tag?: string; folderUid?: string }
  ): Promise<unknown> {
    // Near-duplicate of DashboardTreeProvider's folder grouping by design:
    // the tree provider groups into a UI-tree shape (folder nodes with
    // dashboard children, "General" bucket for folderless dashboards); this
    // needs a flat, JSON-serializable list instead, so sharing code would
    // mean threading a shape parameter through the tree provider's cache
    // just to satisfy this one other caller. See docs/plans Task 5.1.
    const [dashboards, folders] = await Promise.all([
      client.search({
        type: 'dash-db',
        query: parsed.query,
        tag: parsed.tag,
        folderUid: parsed.folderUid
      }),
      client.getFolders()
    ]);
    const folderTitleByUid = new Map(folders.map((folder) => [folder.uid, folder.title]));
    return dashboards.map((dashboard) => ({
      uid: dashboard.uid,
      title: dashboard.title,
      tags: dashboard.tags ?? [],
      folderUid: dashboard.folderUid,
      folderTitle: dashboard.folderUid ? folderTitleByUid.get(dashboard.folderUid) : undefined
    }));
  }

  private async listAlertRules(
    client: GrafanaApiClientLike,
    parsed: { states?: Array<'firing' | 'pending' | 'normal' | 'unknown'> }
  ): Promise<unknown> {
    const [rules, states] = await Promise.all([client.listAlertRules(), client.listAlertRuleStates()]);
    const stateIndex = buildAlertStateIndex(states);
    // Deliberately a *light* projection (FUNC-09): isPaused rides along so a
    // paused rule stops reading as state "unknown", but the heavyweight
    // definition fields (`data`, notificationSettings) stay exclusive to
    // grafana_get_alert_rule.
    const mapped = rules.map((rule) => {
      const correlated = correlateAlertState(rule.uid, stateIndex);
      return {
        uid: rule.uid,
        title: rule.title,
        folderUid: rule.folderUid,
        ruleGroup: rule.ruleGroup,
        state: correlated.state,
        rawState: correlated.rawState,
        activeAt: correlated.activeAt,
        isPaused: rule.isPaused
      };
    });
    if (parsed.states === undefined) {
      return mapped;
    }
    const allowed = new Set(parsed.states);
    return mapped.filter((rule) => allowed.has(rule.state));
  }

  /**
   * FUNC-04: forwards the optional window/limit and, on the failure shapes a
   * disabled state-history backend produces (404/501, or the endpoint's
   * documented-as-unverified `invalid-response`), enriches the message with
   * ALERT_HISTORY_DISABLED_HINT. Kind and status are preserved so
   * `toFailure`'s taxonomy (404 -> NOT_FOUND) is untouched.
   */
  private async getAlertRuleHistory(
    client: GrafanaApiClientLike,
    parsed: { uid: string; from?: number; to?: number; limit?: number }
  ): Promise<unknown> {
    try {
      return await client.getAlertRuleHistory(parsed.uid, { from: parsed.from, to: parsed.to, limit: parsed.limit });
    } catch (error) {
      if (
        error instanceof GrafanaApiError &&
        (error.status === 404 || error.status === 501 || error.kind === 'invalid-response')
      ) {
        throw new GrafanaApiError(error.kind, `${error.message}${ALERT_HISTORY_DISABLED_HINT}`, error.status);
      }
      throw error;
    }
  }

  private async listDatasources(client: GrafanaApiClientLike): Promise<unknown> {
    const datasources = await client.listDatasources();
    // MON1: uid/name/type/url only, never credentials. GrafanaDatasource has
    // no credential-shaped field today, but this enumerates fields
    // explicitly (rather than spreading the object) so a future field added
    // to GrafanaDatasource can't leak through this tool silently.
    return datasources.map((datasource) => ({
      uid: datasource.uid,
      name: datasource.name,
      type: datasource.type,
      url: datasource.url
    }));
  }

  private projectProxyDiscovery(result: unknown, regex?: string): unknown {
    if (
      typeof result === 'object' &&
      result !== null &&
      'truncated' in result &&
      (result as { truncated?: unknown }).truncated === true
    ) {
      return result;
    }
    return projectDiscoveryValues(result, regex);
  }

  /**
   * MON2/D8/D9: generic pass-through to `GrafanaApiClient.proxyDatasourceRequest`,
   * with the Task 6.1 query-limits caps applied around it -- see
   * src/grafana/QueryLimits.ts for the clamp heuristics and the truncation
   * envelope shape. The method allowlist itself is enforced earlier, at
   * schema validation (`grafanaQueryDatasourceSchema`'s `z.enum(['GET',
   * 'POST'])`) and again inside `proxyDatasourceRequest` itself (defense in
   * depth) -- nothing new to do here for that part.
   *
   * ## Why the metering lives here and nowhere else
   *
   * This is the only path on which an Agent can ask Grafana to *compute*
   * something. Everything else in this catalog reads configuration, and the
   * user's own dashboards go through `GrafanaEmbedProxy`, which shares no
   * code with this method -- so none of this can make interactive use feel
   * slower. That separation is the reason the budget can be tight enough to
   * be worth having.
   *
   * The rejection is transient by construction (INV-5): it is a function of
   * recent query volume alone, it carries a delay after which the identical
   * call succeeds, and it is reported as `UNAVAILABLE`, not as the
   * `VALIDATION_ERROR` this class uses for an actual authorization refusal.
   * Whether a tool may be called at all remains `allowBackgroundAccess`'s
   * decision, made before this method is reached.
   */
  private async queryDatasource(client: GrafanaApiClientLike, parsed: GrafanaQueryDatasourceInput): Promise<unknown> {
    const limits = this.effectiveQueryLimits();
    const decision = this.queryRateLimiter.tryAcquire(parsed.instanceId);
    if (!decision.allowed) {
      throw new QueryThrottledError(decision.rejection.reason, decision.rejection.retryAfterMs, {
        maxRequestsPerWindow: DEFAULT_MAX_QUERIES_PER_MINUTE,
        maxConcurrent: DEFAULT_MAX_CONCURRENT_QUERIES
      });
    }

    try {
      const plan = planQueryLimits({
        path: parsed.path,
        query: parsed.query,
        body: parsed.body,
        limits,
        now: Date.now()
      });
      const result = await client.proxyDatasourceRequest(
        parsed.datasourceUid,
        parsed.method,
        parsed.path,
        plan.query,
        plan.body,
        limits.maxResponseBytes
      );
      return plan.adjustments.includes('time-range')
        ? buildTimeRangeTruncationEnvelope(limits.maxRangeMs, result)
        : result;
    } catch (error) {
      if (error instanceof GrafanaApiError && error.kind === 'response-too-large') {
        return buildResponseSizeTruncationEnvelope(limits.maxResponseBytes);
      }
      throw error;
    } finally {
      // Must run on every path: a leaked slot permanently shrinks this
      // instance's concurrency budget until the window resets.
      decision.lease.release();
    }
  }

  /**
   * `maxRangeMs`/`maxResponseBytes` remain user-settable via
   * `atGrafana.queryLimits.*`. The three cost controls added alongside them
   * are constants for now: exposing a setting means contributing it in
   * package.json, and shipping a knob nobody has calibrated yet invites
   * someone to widen it past the point where it protects anything.
   */
  private effectiveQueryLimits(): EffectiveQueryLimits {
    const raw = this.deps.getQueryLimitsConfig?.() ?? {};
    return {
      maxRangeMs: resolveMaxRangeMs(raw.maxRangeMs),
      maxResponseBytes: resolveMaxResponseBytes(raw.maxResponseBytes),
      maxPoints: DEFAULT_MAX_QUERY_POINTS,
      maxLokiLimit: DEFAULT_MAX_LOKI_LIMIT,
      queryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS
    };
  }

  private toFailure(error: unknown): ToolInvokeFailure {
    // formatError/redactSensitiveText scrub anything password/private-key
    // shaped; GrafanaApiError/GrafanaHttpClient additionally never put the
    // Grafana token into a message in the first place (see
    // GrafanaHttpClient.ts's class doc), so nothing token-shaped can reach
    // this tool result either way.
    if (error instanceof QueryThrottledError) {
      return { ok: false, code: 'UNAVAILABLE', message: error.message };
    }
    if (error instanceof GrafanaApiError && error.kind === 'api-error' && error.status === 404) {
      return { ok: false, code: 'NOT_FOUND', message: formatError(error) };
    }
    return { ok: false, code: 'INTERNAL_ERROR', message: formatError(error) };
  }
}

/** UX-08: see TLS_TRUST_RECOVERY_HINT. Idempotent -- an error already carrying the hint passes through unchanged. */
function appendTlsRecoveryHint(error: unknown): unknown {
  if (error instanceof GrafanaApiError && error.kind === 'tls' && !error.message.includes(TLS_TRUST_RECOVERY_HINT.trim())) {
    return new GrafanaApiError('tls', `${error.message}${TLS_TRUST_RECOVERY_HINT}`, error.status);
  }
  return error;
}

/**
 * FUNC-17: a dashboard model past MANAGEMENT_MAX_RESPONSE_BYTES was aborted
 * mid-download, so the raw `response-too-large` message alone would leave
 * the Agent stuck. Point it at the narrower request shapes instead.
 */
function enrichOversizedDashboardError(error: unknown, uid: string): unknown {
  if (error instanceof GrafanaApiError && error.kind === 'response-too-large') {
    return new GrafanaApiError(
      'response-too-large',
      `The JSON model of dashboard "${uid}" exceeded the management response size cap and was not returned. ` +
        'Retry with fields "targets" or "summary" and narrow with panelIds/titleContains instead of fetching the full model.'
    );
  }
  return error;
}
