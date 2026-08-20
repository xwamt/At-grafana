/**
 * Query-limits enforcement for `grafana_query_datasource` (Task 6.1,
 * docs/requirements.md §5.2/MON3, ADR-004 "Safety constraints on
 * grafana_query_datasource", plan's Open Question 2).
 *
 * Deliberately vscode-import-free (like the rest of `src/grafana/**`) so it
 * stays unit-testable without a VS Code host. The actual
 * `vscode.workspace.getConfiguration('atGrafana')` read that produces the
 * raw numbers passed into `resolveMaxRangeMs`/`resolveMaxResponseBytes`
 * lives in `src/extension.ts`; `GrafanaAgentToolService` wires the two
 * together per call (see its `getQueryLimitsConfig` dependency).
 *
 * ## Two independent caps, one shared "truncate, don't fail" envelope
 *
 * - Time range: `clampQueryTimeRange` is a best-effort, Prometheus/Loki
 *   `start`/`end`-shaped heuristic over the pass-through `query` object.
 *   Per D8 (generic-proxy design), this plugin cannot know what a given
 *   datasource's query API expects, so it can only clamp what it can
 *   recognize -- see `parseTimestamp`'s doc comment for the exact supported
 *   formats and the explicitly-unsupported ones.
 * - Response size: enforced upstream of this module, via
 *   `GrafanaHttpClient`'s `maxResponseBytes` early-abort (approach (a) from
 *   the Task 6.1 brief: abort the response stream as soon as it's known to
 *   be oversized, rather than fully buffering it first just to discard it).
 *   This module only builds the resulting truncation envelope.
 *
 * ## Proposed defaults -- PENDING REAL PROMETHEUS/LOKI CALIBRATION
 *
 * `DEFAULT_MAX_RANGE_MS` and `DEFAULT_MAX_RESPONSE_BYTES` are informed
 * guesses, not measurements: this environment has no real Prometheus/Loki
 * instance to calibrate against (see each constant's doc comment for the
 * reasoning). Both are exposed as `atGrafana.queryLimits.*` VS Code settings
 * (package.json `contributes.configuration`) precisely so they can be
 * adjusted without a code change once real usage data exists. Flagged for
 * human review per the plan's Open Question 2.
 */

/**
 * Default/effective cap (milliseconds) for the Prometheus/Loki `start`..
 * `end` query time range that `clampQueryTimeRange` enforces. 12 hours.
 *
 * Reasoning (no real Prometheus/Loki instance available to calibrate
 * against):
 * - Long enough to cover "what happened overnight" / "since yesterday's
 *   deploy" style Agent-driven investigations (S4) without the Agent
 *   needing to page through multiple narrower queries for the common case.
 * - Short enough to bound the worst case: a `query_range` at a small `step`
 *   across a high-cardinality selector run over a full day (or longer) can
 *   return a very large result matrix; 12h keeps that risk roughly in check
 *   without this plugin knowing anything about a given datasource's actual
 *   series cardinality.
 * - A single global cap (not per-datasource-type), consistent with D8's
 *   generic-proxy design -- Prometheus and Loki share it even though their
 *   typical query shapes differ.
 */
export const DEFAULT_MAX_RANGE_MS = 12 * 60 * 60 * 1000;

/**
 * Default/effective cap (bytes) for a single `grafana_query_datasource`
 * response body. 5 MiB.
 *
 * Reasoning (same calibration caveat as DEFAULT_MAX_RANGE_MS):
 * - Large enough for legitimate PromQL/LogQL result sets with a moderate
 *   number of series/streams and points -- typical `query_range` JSON
 *   responses for a handful of series over a few hours are low hundreds of
 *   KB in practice.
 * - Small enough to bound worst-case memory use in the extension host
 *   process (the response is buffered in memory up to this cap -- see
 *   `GrafanaHttpClient`'s `maxResponseBytes` early-abort) and to bound what
 *   a downstream Agent model actually has to read in a single tool result.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function resolvePositiveNumberSetting(configured: number | undefined, fallback: number): number {
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? configured : fallback;
}

/** Applies DEFAULT_MAX_RANGE_MS as the fallback for a missing/invalid `atGrafana.queryLimits.maxRangeMs` setting. */
export function resolveMaxRangeMs(configuredMaxRangeMs: number | undefined): number {
  return resolvePositiveNumberSetting(configuredMaxRangeMs, DEFAULT_MAX_RANGE_MS);
}

/** Applies DEFAULT_MAX_RESPONSE_BYTES as the fallback for a missing/invalid `atGrafana.queryLimits.maxResponseBytes` setting. */
export function resolveMaxResponseBytes(configuredMaxResponseBytes: number | undefined): number {
  return resolvePositiveNumberSetting(configuredMaxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
}

type TimestampFormat = 'rfc3339' | 'unix-seconds' | 'unix-ms' | 'unix-nanos';

interface ParsedTimestamp {
  epochMs: number;
  format: TimestampFormat;
}

/**
 * Threshold distinguishing Unix-seconds from Unix-milliseconds timestamps by
 * magnitude. Real epoch-seconds values are ~1.7-2.5e9 today; epoch-ms values
 * are ~1.7-2.5e12. 1e12 sits comfortably between the two for the next
 * several centuries, so no explicit unit hint is needed.
 */
const SECONDS_VS_MS_THRESHOLD = 1e12;

/**
 * Upper bound past which a numeric value is rejected outright rather than
 * treated as an implausibly-far-future millisecond timestamp. Real
 * epoch-ms values won't approach this for tens of thousands of years; Unix
 * **nanosecond** timestamps (as used by some Loki query parameters, ~1e18
 * today) comfortably exceed it, which is exactly the point -- see
 * parseTimestamp's doc for why nanoseconds are an explicitly unsupported
 * format rather than silently (mis)interpreted as milliseconds.
 */
const MAX_PLAUSIBLE_UNIX_MS = 1e15;

/**
 * The band in which a numeric timestamp is read as Unix **nanoseconds**, the
 * default unit for Loki's `query_range`. 1e17 ns is 1973 and 1e20 ns is the
 * year 5138, which covers every value a real Loki query carries.
 *
 * The gap between `MAX_PLAUSIBLE_UNIX_MS` (1e15) and this lower bound is left
 * deliberately unparseable rather than being folded into either neighbour: a
 * value there is either microseconds (which neither Prometheus nor Loki
 * accepts) or a millisecond value tens of thousands of years out, so there is
 * no reading of it that is more likely to be right than wrong.
 */
const MIN_PLAUSIBLE_UNIX_NANOS = 1e17;
const MAX_PLAUSIBLE_UNIX_NANOS = 1e20;

const NANOS_PER_MS = 1_000_000n;

const RFC3339_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}T/;
const NUMERIC_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Recognizes exactly three `start`/`end` value shapes, matching the formats
 * Prometheus's and Loki's query APIs commonly accept: RFC3339 timestamps
 * (`2026-07-29T00:00:00Z`), Unix seconds (`1690000000`, optionally
 * fractional per Prometheus's `<rfc3339 | unix_timestamp>` convention), and
 * Unix milliseconds (`1690000000000`).
 *
 * Unix **nanosecond** epochs (Loki's `query_range` default) are recognized
 * too. They used to be rejected on the theory that guessing wrong was worse
 * than not enforcing -- but since `clampQueryTimeRange` treats "can't parse"
 * as "leave it alone," that reasoning handed anyone querying Loki in
 * nanoseconds an unlimited time range. The ambiguity that motivated the
 * original rejection is confined to the band between `MAX_PLAUSIBLE_UNIX_MS`
 * and `MIN_PLAUSIBLE_UNIX_NANOS`, which stays unparseable.
 *
 * Explicitly NOT recognized -- a documented limitation of a generic,
 * datasource-agnostic proxy (D8), not a bug to fix here:
 * - Relative/duration-shaped values (e.g. `-1h`), which some datasource UIs
 *   display but neither Prometheus's nor Loki's HTTP query APIs accept as
 *   literal `start`/`end` query values.
 */
function parseTimestamp(raw: string): ParsedTimestamp | undefined {
  if (RFC3339_PREFIX_PATTERN.test(raw)) {
    const epochMs = Date.parse(raw);
    return Number.isNaN(epochMs) ? undefined : { epochMs, format: 'rfc3339' };
  }
  if (!NUMERIC_PATTERN.test(raw)) {
    return undefined;
  }
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  if (numeric < SECONDS_VS_MS_THRESHOLD) {
    return { epochMs: numeric * 1000, format: 'unix-seconds' };
  }
  if (numeric <= MAX_PLAUSIBLE_UNIX_MS) {
    return { epochMs: numeric, format: 'unix-ms' };
  }
  if (numeric >= MIN_PLAUSIBLE_UNIX_NANOS && numeric < MAX_PLAUSIBLE_UNIX_NANOS) {
    // Lossy by ~256ns at this magnitude (past the point where a double can
    // represent consecutive integers), which is irrelevant for deciding
    // whether a range exceeds hours. `formatTimestamp` reintroduces exactness
    // where it matters, on the way back out.
    return { epochMs: numeric / 1e6, format: 'unix-nanos' };
  }
  return undefined;
}

function formatTimestamp(epochMs: number, format: TimestampFormat): string {
  switch (format) {
    case 'rfc3339':
      return new Date(epochMs).toISOString();
    case 'unix-seconds':
      return String(Math.floor(epochMs / 1000));
    case 'unix-ms':
      return String(Math.round(epochMs));
    case 'unix-nanos':
      // Via BigInt so the result is an exact integer string: the millisecond
      // value is exactly representable as a double, the nanosecond one is not.
      return (BigInt(Math.round(epochMs)) * NANOS_PER_MS).toString();
  }
}

export interface QueryTimeRangeClampResult {
  query: Record<string, string> | undefined;
  clamped: boolean;
}

/**
 * Best-effort range clamp for `grafana_query_datasource`'s `query` object
 * (MON3/D9). See this module's doc comment and `parseTimestamp`'s doc for
 * exactly which `start`/`end` shapes are recognized.
 *
 * Deliberately conservative:
 * - Only ever narrows a range that both parses successfully AND exceeds
 *   `maxRangeMs` -- never expands a range the agent already specified
 *   narrower than the cap.
 * - Leaves `query` completely untouched (returns it as-is) when `start`/
 *   `end` are missing, unparseable, or don't form a forward-moving range
 *   (`end <= start`) -- an unparseable/malformed range is documented as
 *   "can't enforce what it can't parse," not silently coerced into
 *   something else.
 * - When clamping, only `start` moves (forward, toward `end`), so the
 *   effective range keeps the agent's originally requested end time.
 */
export function clampQueryTimeRange(
  query: Record<string, string> | undefined,
  maxRangeMs: number
): QueryTimeRangeClampResult {
  if (!query || query.start === undefined || query.end === undefined) {
    return { query, clamped: false };
  }
  const start = parseTimestamp(query.start);
  const end = parseTimestamp(query.end);
  if (!start || !end || end.epochMs <= start.epochMs) {
    return { query, clamped: false };
  }
  if (end.epochMs - start.epochMs <= maxRangeMs) {
    return { query, clamped: false };
  }
  const clampedStart = formatTimestamp(end.epochMs - maxRangeMs, start.format);
  return { query: { ...query, start: clampedStart }, clamped: true };
}

/**
 * Default ceiling on evaluated points per `query_range` call
 * (range / step). Prometheus's own server-side ceiling is 11000; this is far
 * lower because the consumer is an LLM context window, not a chart. 1000
 * points across a handful of series is already tens of KB of JSON, and an
 * agent that genuinely needs finer resolution can ask for a shorter range and
 * get it at full fidelity.
 */
export const DEFAULT_MAX_QUERY_POINTS = 1000;

/** Default ceiling on Loki's `limit` (log lines returned). Loki's own default is 100. */
export const DEFAULT_MAX_LOKI_LIMIT = 1000;

/**
 * Default query timeout handed *to Prometheus*, distinct from the socket
 * timeout in `GrafanaHttpClient`. The socket timeout stops us waiting; this
 * one stops Prometheus computing, which is the half that actually protects
 * the monitoring system rather than just the editor.
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

/** Default sustained query budget per instance, and the size of one burst from idle. */
export const DEFAULT_MAX_QUERIES_PER_MINUTE = 60;

/** Default ceiling on queries in flight against one instance at once. */
export const DEFAULT_MAX_CONCURRENT_QUERIES = 4;

export interface EffectiveQueryLimits {
  maxRangeMs: number;
  maxResponseBytes: number;
  maxPoints: number;
  maxLokiLimit: number;
  queryTimeoutMs: number;
}

/**
 * The query endpoints this module knows the cost model of. Everything else
 * stays a pure pass-through, per D8: recognizing a path is what licenses
 * rewriting its parameters, and we only recognize the two datasources whose
 * query APIs are actually documented here.
 */
export type QueryEndpointKind = 'prometheus-range' | 'prometheus-instant' | 'loki-range' | 'loki-instant';

const QUERY_ENDPOINTS = new Map<string, QueryEndpointKind>([
  ['api/v1/query_range', 'prometheus-range'],
  ['api/v1/query', 'prometheus-instant'],
  ['loki/api/v1/query_range', 'loki-range'],
  ['loki/api/v1/query', 'loki-instant']
]);

export function classifyQueryEndpoint(path: string): QueryEndpointKind | undefined {
  const normalized = (path.startsWith('/') ? path.slice(1) : path).split('?')[0] ?? '';
  return QUERY_ENDPOINTS.get(normalized);
}

export type QueryLimitAdjustment = 'time-range' | 'step' | 'loki-limit' | 'query-timeout';

export interface QueryLimitPlan {
  query: Record<string, string> | undefined;
  body: unknown;
  adjustments: QueryLimitAdjustment[];
}

export interface QueryLimitPlanInput {
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  limits: EffectiveQueryLimits;
  now: number;
}

/**
 * Applies every cost control this module knows how to apply to one
 * `grafana_query_datasource` call, and reports what it changed.
 *
 * `clampQueryTimeRange` alone only bites when `start` and `end` are both
 * present, both parseable, and forward-moving -- which left several ways to
 * reach Prometheus or Loki unmetered. This closes them:
 *
 * - **A missing bound.** Omitting `end` (Loki defaults it to now) or `start`
 *   left the condition unsatisfiable, so nothing was clamped. Both are now
 *   materialized from `now` before clamping, but only on an endpoint whose
 *   `start`/`end` semantics we actually know -- inventing bounds for an
 *   unrecognized datasource would be a guess about its API.
 * - **A cheap-looking range with a ruinous step.** `step=1s` over a compliant
 *   12h range is 43,200 evaluations per series. The step floor is derived
 *   from the range and a point budget rather than being a fixed minimum, so
 *   it bounds the actual work instead of a proxy for it, and a short range
 *   keeps its fine resolution.
 * - **An unbounded Loki `limit`.**
 * - **An instant query**, which has no range to clamp at all. Its cost is
 *   evaluation, so the only lever is telling Prometheus when to give up.
 * - **A range in the POST body.** The generic-proxy design never introspected
 *   `body`; on a recognized endpoint the same clamp now applies there.
 *
 * Note that Grafana's own `/api/ds/query` -- the usual way a time range
 * travels in a POST body -- is not reachable from this tool at all:
 * `buildDatasourceProxyPath` confines every path under
 * `/api/datasources/proxy/uid/:uid/`, and `/api/ds/query` lives outside it.
 */
export function planQueryLimits(input: QueryLimitPlanInput): QueryLimitPlan {
  const kind = classifyQueryEndpoint(input.path);
  if (!kind) {
    return { query: input.query, body: input.body, adjustments: [] };
  }

  const adjustments: QueryLimitAdjustment[] = [];
  let query = input.query ? { ...input.query } : undefined;
  let body = input.body;

  if (kind === 'prometheus-range' || kind === 'loki-range') {
    const ranged = applyRangeLimits(query ?? {}, input.limits, input.now, adjustments);
    query = ranged;
  }

  if (kind === 'loki-range' || kind === 'loki-instant') {
    query = applyLokiLimit(query ?? {}, input.limits.maxLokiLimit, adjustments);
  }

  if (kind === 'prometheus-range' || kind === 'prometheus-instant') {
    query = applyPrometheusTimeout(query ?? {}, input.limits.queryTimeoutMs, adjustments);
  }

  body = clampBodyTimeRange(body, input.limits.maxRangeMs, adjustments);

  return { query, body, adjustments };
}

/**
 * Materializes whichever bound is missing (or a rfc3339 `now-maxRangeMs`..`now`
 * window when both are missing), clamps the span, then floors the step against
 * what remains.
 *
 * A both-missing fill of exactly `maxRangeMs` is not truncation — do not
 * record `'time-range'` for it. One-bound-missing still records `'time-range'`.
 */
function applyRangeLimits(
  query: Record<string, string>,
  limits: EffectiveQueryLimits,
  now: number,
  adjustments: QueryLimitAdjustment[]
): Record<string, string> {
  let next = { ...query };

  const hasStart = next.start !== undefined && parseTimestamp(next.start) !== undefined;
  const hasEnd = next.end !== undefined && parseTimestamp(next.end) !== undefined;

  if (hasStart && !hasEnd) {
    const start = parseTimestamp(next.start ?? '');
    if (start) {
      next.end = formatTimestamp(now, start.format);
      adjustments.push('time-range');
    }
  } else if (!hasStart && hasEnd) {
    const end = parseTimestamp(next.end ?? '');
    if (end) {
      next.start = formatTimestamp(end.epochMs - limits.maxRangeMs, end.format);
      adjustments.push('time-range');
    }
  } else if (!hasStart && !hasEnd) {
    next.end = formatTimestamp(now, 'rfc3339');
    next.start = formatTimestamp(now - limits.maxRangeMs, 'rfc3339');
  }

  const clamped = clampQueryTimeRange(next, limits.maxRangeMs);
  if (clamped.clamped) {
    if (!adjustments.includes('time-range')) {
      adjustments.push('time-range');
    }
    next = clamped.query ?? next;
  }

  return applyStepFloor(next, limits.maxPoints, adjustments);
}

/**
 * Raises `step` until `range / step` fits the point budget.
 *
 * An unparseable step is replaced rather than left alone: "cannot parse, so
 * allow" is precisely the reasoning that made the original clamp bypassable,
 * and on an endpoint we have positively recognized the step format is
 * documented, so an unrecognizable one is malformed rather than exotic.
 */
function applyStepFloor(
  query: Record<string, string>,
  maxPoints: number,
  adjustments: QueryLimitAdjustment[]
): Record<string, string> {
  const start = query.start === undefined ? undefined : parseTimestamp(query.start);
  const end = query.end === undefined ? undefined : parseTimestamp(query.end);
  if (!start || !end || end.epochMs <= start.epochMs) {
    return query;
  }

  const rangeSeconds = (end.epochMs - start.epochMs) / 1000;
  const minStepSeconds = Math.max(1, Math.ceil(rangeSeconds / maxPoints));
  const currentStepSeconds = query.step === undefined ? undefined : parseDurationSeconds(query.step);

  if (currentStepSeconds !== undefined && currentStepSeconds >= minStepSeconds) {
    return query;
  }

  adjustments.push('step');
  return { ...query, step: `${minStepSeconds}s` };
}

function applyLokiLimit(
  query: Record<string, string>,
  maxLokiLimit: number,
  adjustments: QueryLimitAdjustment[]
): Record<string, string> {
  if (query.limit === undefined) {
    return query;
  }
  const requested = Number(query.limit);
  if (Number.isFinite(requested) && requested > 0 && requested <= maxLokiLimit) {
    return query;
  }
  adjustments.push('loki-limit');
  return { ...query, limit: String(maxLokiLimit) };
}

function applyPrometheusTimeout(
  query: Record<string, string>,
  queryTimeoutMs: number,
  adjustments: QueryLimitAdjustment[]
): Record<string, string> {
  const capSeconds = Math.max(1, Math.round(queryTimeoutMs / 1000));
  const requested = query.timeout === undefined ? undefined : parseDurationSeconds(query.timeout);
  if (requested !== undefined && requested <= capSeconds) {
    return query;
  }
  adjustments.push('query-timeout');
  return { ...query, timeout: `${capSeconds}s` };
}

/**
 * Applies the range clamp to a flat `{ start, end }` JSON body on a
 * recognized query endpoint.
 *
 * Narrow on purpose: it only touches string `start`/`end` at the top level of
 * a plain object, because that is the only body shape whose meaning we can be
 * sure of. A body it does not recognize passes through untouched rather than
 * being rewritten on a guess.
 */
function clampBodyTimeRange(body: unknown, maxRangeMs: number, adjustments: QueryLimitAdjustment[]): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return body;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.start !== 'string' || typeof record.end !== 'string') {
    return body;
  }

  const clamped = clampQueryTimeRange({ start: record.start, end: record.end }, maxRangeMs);
  if (!clamped.clamped || !clamped.query) {
    return body;
  }
  if (!adjustments.includes('time-range')) {
    adjustments.push('time-range');
  }
  return { ...record, start: clamped.query.start };
}

const DURATION_COMPONENT_PATTERN = /(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)/g;
const DURATION_UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  y: 31536000
};

/**
 * Parses the two step/timeout shapes Prometheus and Loki accept: a bare float
 * count of seconds, or a Go-style duration, which may be multi-component
 * (`1h30m`). Returns undefined for anything else so the caller can decide --
 * here, to overwrite it.
 */
export function parseDurationSeconds(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (NUMERIC_PATTERN.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds : undefined;
  }

  DURATION_COMPONENT_PATTERN.lastIndex = 0;
  let total = 0;
  let consumed = 0;
  for (const match of trimmed.matchAll(DURATION_COMPONENT_PATTERN)) {
    const amount = Number(match[1]);
    const unitSeconds = DURATION_UNIT_SECONDS[match[2] ?? ''];
    if (!Number.isFinite(amount) || unitSeconds === undefined) {
      return undefined;
    }
    total += amount * unitSeconds;
    consumed += match[0].length;
  }
  // Every character has to belong to a component, so `12x` or `1h!` is
  // malformed rather than silently read as `1h`.
  return consumed === trimmed.length && consumed > 0 ? total : undefined;
}

export type QueryLimitsTruncationReason = 'time-range' | 'response-size';

/**
 * The query-limits truncation result envelope, used by
 * `grafana_query_datasource`'s implementation (`GrafanaAgentToolService`)
 * whenever either cap is applied. Always a plain, fully-formed
 * JSON-serializable object -- never a partially-written JSON string,
 * regardless of what shape `result` is or how large the discarded upstream
 * response was.
 */
export interface QueryLimitsTruncationEnvelope {
  truncated: true;
  reason: QueryLimitsTruncationReason;
  message: string;
  maxRangeMs?: number;
  maxBytes?: number;
  /**
   * Present (and complete -- never partial) when range-clamped, since the
   * clamped request already completed successfully and fits. Omitted
   * entirely when size-capped: see `buildResponseSizeTruncationEnvelope`.
   */
  result?: unknown;
}

/**
 * Envelope for a range-clamped `grafana_query_datasource` call. `result`
 * still holds the actual (now in-range) data -- the request already
 * completed successfully against Grafana with the clamped range, so there's
 * no reason to withhold it.
 */
export function buildTimeRangeTruncationEnvelope(maxRangeMs: number, result: unknown): QueryLimitsTruncationEnvelope {
  return {
    truncated: true,
    reason: 'time-range',
    message:
      `The requested time range exceeded the configured maximum of ${maxRangeMs}ms (atGrafana.queryLimits.maxRangeMs). ` +
      'The start time was automatically moved forward so the effective range ends at the originally requested end time ' +
      'and spans exactly the maximum. Retry with an explicitly narrower start/end if you need a different window.',
    maxRangeMs,
    result
  };
}

/**
 * Envelope for a size-capped `grafana_query_datasource` call, i.e. the
 * upstream response was aborted mid-read by `GrafanaHttpClient`'s
 * `maxResponseBytes` early-abort (surfaced as a `GrafanaApiError` with
 * `kind: 'response-too-large'`; see `GrafanaAgentToolService`).
 *
 * `result` is intentionally omitted rather than set to `null`/partial data:
 * per D8's generic-proxy design, this plugin has no per-datasource-type
 * knowledge of how to safely cut an arbitrary JSON body in half without
 * risking invalid or misleading partial data, so the only safe thing to
 * return is "we don't have it, narrow your query and retry."
 */
export function buildResponseSizeTruncationEnvelope(maxBytes: number): QueryLimitsTruncationEnvelope {
  return {
    truncated: true,
    reason: 'response-size',
    message:
      `The datasource response exceeded the configured maximum of ${maxBytes} bytes (atGrafana.queryLimits.maxResponseBytes) ` +
      'and was discarded rather than returned partially or truncated mid-structure. Narrow your query (smaller time range, ' +
      'fewer series/streams/labels, added filters) and retry.',
    maxBytes
  };
}
