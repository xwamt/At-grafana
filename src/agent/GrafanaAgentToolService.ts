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
import { formatError } from '../utils/errors';
import {
  describeZodError,
  grafanaGetAlertHistorySchema,
  grafanaGetAlertRuleSchema,
  grafanaGetDashboardSchema,
  grafanaListAlertRulesSchema,
  grafanaListDashboardsSchema,
  grafanaListDatasourcesSchema,
  grafanaListFoldersSchema,
  grafanaListInstancesSchema,
  grafanaQueryDatasourceSchema,
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
  | 'listAlertRuleStates'
  | 'getAlertRuleHistory'
  | 'listDatasources'
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
        maxConcurrent: DEFAULT_MAX_CONCURRENT_QUERIES
      });
  }

  async invoke(name: string, args: unknown): Promise<ToolInvokeResult> {
    try {
      switch (name) {
        case 'grafana_list_instances':
          return await this.listInstances(args);
        case 'grafana_list_dashboards':
          return await this.withAuthorizedClient(grafanaListDashboardsSchema, args, (client) => this.listDashboards(client));
        case 'grafana_get_dashboard':
          return await this.withAuthorizedClient(grafanaGetDashboardSchema, args, async (client, parsed) => {
            const dashboard = await client.getDashboardByUid(parsed.uid);
            return projectDashboard(dashboard, {
              fields: parsed.fields,
              panelIds: parsed.panelIds,
              titleContains: parsed.titleContains
            });
          });
        case 'grafana_list_folders':
          return await this.withAuthorizedClient(grafanaListFoldersSchema, args, (client) => client.getFolders());
        case 'grafana_list_alert_rules':
          return await this.withAuthorizedClient(grafanaListAlertRulesSchema, args, (client) => this.listAlertRules(client));
        case 'grafana_get_alert_rule':
          return await this.withAuthorizedClient(grafanaGetAlertRuleSchema, args, (client, parsed) =>
            this.getAlertRule(client, parsed.uid)
          );
        case 'grafana_get_alert_history':
          return await this.withAuthorizedClient(grafanaGetAlertHistorySchema, args, (client, parsed) =>
            client.getAlertRuleHistory(parsed.uid)
          );
        case 'grafana_list_datasources':
          return await this.withAuthorizedClient(grafanaListDatasourcesSchema, args, (client) => this.listDatasources(client));
        case 'grafana_query_datasource':
          return await this.withAuthorizedClient(grafanaQueryDatasourceSchema, args, (client, parsed) =>
            this.queryDatasource(client, parsed)
          );
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
    const result = instances
      .filter((instance) => instance.allowBackgroundAccess)
      .map((instance) => ({ id: instance.id, label: instance.label, url: instance.url }));
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
    const result = await run(client, parsed.data);
    return { ok: true, result };
  }

  private createCertVerifier(): GrafanaCertVerifier {
    const store = this.deps.certTrustStore;
    return {
      verify: async (host, port, fingerprint) => (await store.check(host, port, fingerprint)) === 'trusted'
    };
  }

  private async listDashboards(client: GrafanaApiClientLike): Promise<unknown> {
    // Near-duplicate of DashboardTreeProvider's folder grouping by design:
    // the tree provider groups into a UI-tree shape (folder nodes with
    // dashboard children, "General" bucket for folderless dashboards); this
    // needs a flat, JSON-serializable list instead, so sharing code would
    // mean threading a shape parameter through the tree provider's cache
    // just to satisfy this one other caller. See docs/plans Task 5.1.
    const [dashboards, folders] = await Promise.all([client.search({ type: 'dash-db' }), client.getFolders()]);
    const folderTitleByUid = new Map(folders.map((folder) => [folder.uid, folder.title]));
    return dashboards.map((dashboard) => ({
      uid: dashboard.uid,
      title: dashboard.title,
      tags: dashboard.tags ?? [],
      folderUid: dashboard.folderUid,
      folderTitle: dashboard.folderUid ? folderTitleByUid.get(dashboard.folderUid) : undefined
    }));
  }

  private async listAlertRules(client: GrafanaApiClientLike): Promise<unknown> {
    const [rules, states] = await Promise.all([client.listAlertRules(), client.listAlertRuleStates()]);
    const stateIndex = buildAlertStateIndex(states);
    return rules.map((rule) => {
      const correlated = correlateAlertState(rule.uid, stateIndex);
      return {
        uid: rule.uid,
        title: rule.title,
        folderUid: rule.folderUid,
        ruleGroup: rule.ruleGroup,
        state: correlated.state,
        rawState: correlated.rawState,
        activeAt: correlated.activeAt
      };
    });
  }

  private async getAlertRule(client: GrafanaApiClientLike, uid: string): Promise<unknown> {
    // GrafanaAlertsApi has no dedicated single-rule fetch endpoint (Task 2.1
    // only added listAlertRules/listAlertRuleStates); filtering the full
    // list client-side is a minor, accepted V1 inefficiency rather than
    // adding a new client method for what is otherwise a rare Agent call.
    const rules = await client.listAlertRules();
    const rule = rules.find((candidate) => candidate.uid === uid);
    if (!rule) {
      throw new GrafanaApiError('api-error', `Alert rule not found: ${uid}`, 404);
    }
    return rule;
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
