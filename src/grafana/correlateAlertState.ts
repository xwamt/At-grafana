import type { GrafanaAlertRuleState } from './GrafanaAlertsApi';

/**
 * Grafana's Unified Alerting ruler API reports lowercase state strings that
 * vary slightly by version (`firing` / `pending` / `inactive` / `normal`).
 * Collapsed to a fixed set here so sorting/icon/agent-tool logic doesn't have
 * to guess at every raw string Grafana might send (requirements UI2: Firing
 * sorted first, unmatched/absent state treated as unknown rather than
 * crashing).
 *
 * Shared by `AlertTreeProvider` (tree UI, Task 3.2) and
 * `GrafanaAgentToolService` (`grafana_list_alert_rules`, Task 5.1) so the two
 * surfaces never disagree about what "firing"/"unknown" mean for the same
 * rule -- see docs/plans Task 5.1 for why this was extracted rather than
 * duplicated a second time.
 */
export type NormalizedAlertState = 'firing' | 'pending' | 'normal' | 'unknown';

export const ALERT_STATE_RANK: Record<NormalizedAlertState, number> = {
  firing: 0,
  pending: 1,
  normal: 2,
  unknown: 3
};

export function normalizeAlertState(state: string | undefined): NormalizedAlertState {
  switch (state?.toLowerCase()) {
    case 'firing':
      return 'firing';
    case 'pending':
      return 'pending';
    case 'normal':
    case 'inactive':
      return 'normal';
    default:
      return 'unknown';
  }
}

export interface CorrelatedAlertState {
  state: NormalizedAlertState;
  rawState?: string;
  health?: string;
  activeAt?: string;
}

/** Indexes live rule state by `uid` once per fetch, so correlating N rule definitions against it is O(N) rather than O(N*M). */
export function buildAlertStateIndex(states: GrafanaAlertRuleState[]): Map<string, GrafanaAlertRuleState> {
  return new Map(states.map((state) => [state.uid, state]));
}

/**
 * Correlates one rule *definition* uid against the live *state* index built
 * by `buildAlertStateIndex` (see GrafanaAlertsApi.ts's class doc for why
 * definitions and state are two separate Grafana endpoints, correlated only
 * by `uid`). A rule with no matching state entry is treated as `unknown`
 * rather than dropped or thrown, per UI2 and mirrored in
 * `grafana_list_alert_rules`.
 */
export function correlateAlertState(uid: string, stateIndex: Map<string, GrafanaAlertRuleState>): CorrelatedAlertState {
  const liveState = stateIndex.get(uid);
  return {
    state: normalizeAlertState(liveState?.state),
    rawState: liveState?.state,
    health: liveState?.health,
    activeAt: liveState?.activeAt
  };
}
