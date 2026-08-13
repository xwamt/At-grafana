/**
 * Per-instance resource metering for the Agent query path
 * (`grafana_query_datasource`).
 *
 * ## This is not an authorization boundary
 *
 * Nothing here decides *whether* a caller may use a tool -- that is
 * `allowBackgroundAccess`, enforced in `GrafanaAgentToolService`, and it stays
 * the only gate. This meters *how fast* an already-authorized caller may
 * spend a Grafana instance's capacity, and every rejection is transient: it
 * carries a delay after which the identical call succeeds, and it is a
 * function of recent request volume alone -- never of which tools the Hub has
 * surfaced, which instance is involved, or who is asking. A permanent denial
 * would make this an ACL, which it must not become.
 *
 * ## Why per-instance
 *
 * The thing being protected is a single Grafana (and the Prometheus or Loki
 * behind it), so the budget belongs to the instance. Metering globally would
 * let one busy instance starve queries to an idle one; metering per tool call
 * would meter nothing at all.
 *
 * ## Why a token bucket rather than a fixed window
 *
 * A fixed window lets an agent spend the whole budget in the last instant of
 * one window and the whole next budget in the first instant of the next,
 * producing a burst of twice the nominal rate at the seam -- exactly the
 * shape a retry loop generates. A bucket refills continuously, so the
 * sustained rate holds across window boundaries while still permitting one
 * full-size burst from idle, which is what an agent doing a legitimate
 * multi-query investigation actually needs.
 */

export interface QueryRateLimiterOptions {
  /** Bucket capacity, and the number of tokens replenished over one window. */
  maxRequestsPerWindow: number;
  windowMs: number;
  /** Ceiling on queries in flight simultaneously against one instance. */
  maxConcurrent: number;
  /** Injectable clock; tests advance it by hand instead of sleeping. */
  now?: () => number;
}

export type QueryRateLimitReason = 'rate' | 'concurrency';

export interface QueryRateLimiterLease {
  release(): void;
}

export interface QueryRateLimiterRejection {
  reason: QueryRateLimitReason;
  retryAfterMs: number;
}

export type QueryRateLimiterDecision =
  | { allowed: true; lease: QueryRateLimiterLease }
  | { allowed: false; rejection: QueryRateLimiterRejection };

/**
 * Retry hint for a concurrency rejection. Unlike the rate case there is no
 * arithmetic that predicts when a slot frees -- it depends on how long the
 * queries already running take -- so this is a deliberately short nudge to
 * retry rather than a promise.
 */
const CONCURRENCY_RETRY_HINT_MS = 250;

/**
 * Raised when a query is shed. The wording matters as much as the type: it
 * has to read to an agent (and to whoever debugs the transcript) as "wait,
 * then repeat this exact call," never as "you are not allowed to do this."
 * `GrafanaAgentToolService` maps it to `UNAVAILABLE`/503 for the same reason
 * -- a 403 would be a lie about what happened.
 */
export class QueryThrottledError extends Error {
  constructor(
    public readonly reason: QueryRateLimitReason,
    public readonly retryAfterMs: number,
    limits: Pick<QueryRateLimiterOptions, 'maxRequestsPerWindow' | 'maxConcurrent'>
  ) {
    super(
      (reason === 'rate'
        ? `This Grafana instance is over its query budget of ${limits.maxRequestsPerWindow} queries per minute.`
        : `This Grafana instance already has ${limits.maxConcurrent} queries in flight.`) +
        ` This is a temporary resource limit, not an access restriction: retry the same call in ${retryAfterMs}ms.`
    );
    this.name = 'QueryThrottledError';
  }
}

interface InstanceBudget {
  tokens: number;
  lastRefillAt: number;
  inFlight: number;
}

export class QueryRateLimiter {
  private readonly budgets = new Map<string, InstanceBudget>();
  private readonly now: () => number;

  constructor(private readonly options: QueryRateLimiterOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Admits or sheds one query. The caller must `release()` an admitted lease
   * in a `finally`, or the instance's concurrency budget leaks and the
   * instance eventually stops accepting queries entirely.
   */
  tryAcquire(instanceId: string): QueryRateLimiterDecision {
    const budget = this.budgetFor(instanceId);
    this.refill(budget);

    // Concurrency is checked first, and deliberately does not spend a token:
    // a request that never reached Grafana should not consume the budget for
    // one that would have.
    if (budget.inFlight >= this.options.maxConcurrent) {
      return { allowed: false, rejection: { reason: 'concurrency', retryAfterMs: CONCURRENCY_RETRY_HINT_MS } };
    }

    if (budget.tokens < 1) {
      return { allowed: false, rejection: { reason: 'rate', retryAfterMs: this.msUntilNextToken(budget) } };
    }

    budget.tokens -= 1;
    budget.inFlight += 1;

    let released = false;
    return {
      allowed: true,
      lease: {
        release: () => {
          if (released) {
            return;
          }
          released = true;
          budget.inFlight = Math.max(0, budget.inFlight - 1);
        }
      }
    };
  }

  private budgetFor(instanceId: string): InstanceBudget {
    const existing = this.budgets.get(instanceId);
    if (existing) {
      return existing;
    }
    const created: InstanceBudget = {
      tokens: this.options.maxRequestsPerWindow,
      lastRefillAt: this.now(),
      inFlight: 0
    };
    this.budgets.set(instanceId, created);
    return created;
  }

  private refill(budget: InstanceBudget): void {
    const now = this.now();
    const elapsed = now - budget.lastRefillAt;
    budget.lastRefillAt = now;
    if (elapsed <= 0) {
      return;
    }
    // Capped at capacity so an instance idle overnight wakes up with one
    // burst available, not an unbounded backlog of credit.
    budget.tokens = Math.min(this.options.maxRequestsPerWindow, budget.tokens + elapsed * this.tokensPerMs());
  }

  private tokensPerMs(): number {
    return this.options.maxRequestsPerWindow / this.options.windowMs;
  }

  private msUntilNextToken(budget: InstanceBudget): number {
    return Math.max(1, Math.ceil((1 - budget.tokens) / this.tokensPerMs()));
  }
}
