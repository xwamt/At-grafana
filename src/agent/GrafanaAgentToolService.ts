import type { z } from 'zod';
import type { GrafanaInstanceConfigManager } from '../config/GrafanaInstanceConfigManager';
import type { GrafanaCertTrustStore } from '../grafana/GrafanaCertTrustStore';
import { buildAlertStateIndex, correlateAlertState } from '../grafana/correlateAlertState';
import type { GrafanaApiClient } from '../grafana/GrafanaApiClient';
import { GrafanaApiError, type GrafanaCertVerifier } from '../grafana/GrafanaHttpClient';
import { formatError } from '../utils/errors';
import {
  describeZodError,
  grafanaGetAlertHistorySchema,
  grafanaGetAlertRuleSchema,
  grafanaGetDashboardSchema,
  grafanaListAlertRulesSchema,
  grafanaListDashboardsSchema,
  grafanaListFoldersSchema,
  grafanaListInstancesSchema
} from '../mcp/bridgeSchemas';

/**
 * The subset of `GrafanaApiClient` every management tool call needs. Kept as
 * a `Pick<...>` (same pattern as `DashboardApiClient`/`AlertApiClient` in the
 * tree providers) so tests can pass a plain fake object instead of a real
 * HTTP-backed client.
 */
export type GrafanaApiClientLike = Pick<
  GrafanaApiClient,
  'search' | 'getFolders' | 'getDashboardByUid' | 'listAlertRules' | 'listAlertRuleStates' | 'getAlertRuleHistory'
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

export type ToolInvokeErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'INTERNAL_ERROR';

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
  constructor(private readonly deps: GrafanaAgentToolServiceDependencies) {}

  async invoke(name: string, args: unknown): Promise<ToolInvokeResult> {
    try {
      switch (name) {
        case 'grafana_list_instances':
          return await this.listInstances(args);
        case 'grafana_list_dashboards':
          return await this.withAuthorizedClient(grafanaListDashboardsSchema, args, (client) => this.listDashboards(client));
        case 'grafana_get_dashboard':
          return await this.withAuthorizedClient(grafanaGetDashboardSchema, args, (client, parsed) =>
            client.getDashboardByUid(parsed.uid)
          );
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

  private toFailure(error: unknown): ToolInvokeFailure {
    // formatError/redactSensitiveText scrub anything password/private-key
    // shaped; GrafanaApiError/GrafanaHttpClient additionally never put the
    // Grafana token into a message in the first place (see
    // GrafanaHttpClient.ts's class doc), so nothing token-shaped can reach
    // this tool result either way.
    if (error instanceof GrafanaApiError && error.kind === 'api-error' && error.status === 404) {
      return { ok: false, code: 'NOT_FOUND', message: formatError(error) };
    }
    return { ok: false, code: 'INTERNAL_ERROR', message: formatError(error) };
  }
}
