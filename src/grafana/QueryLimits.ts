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

type TimestampFormat = 'rfc3339' | 'unix-seconds' | 'unix-ms';

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

const RFC3339_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}T/;
const NUMERIC_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Recognizes exactly three `start`/`end` value shapes, matching the formats
 * Prometheus's and Loki's query APIs commonly accept: RFC3339 timestamps
 * (`2026-07-29T00:00:00Z`), Unix seconds (`1690000000`, optionally
 * fractional per Prometheus's `<rfc3339 | unix_timestamp>` convention), and
 * Unix milliseconds (`1690000000000`).
 *
 * Explicitly NOT recognized -- a documented limitation of a generic,
 * datasource-agnostic proxy (D8), not a bug to fix here:
 * - Unix **nanosecond** epoch timestamps, which Loki's `query_range` also
 *   accepts by default. A 19-digit nanosecond value would otherwise be
 *   misread as an implausibly large millisecond value; rather than guess
 *   wrong, this function returns `undefined` for it, and
 *   `clampQueryTimeRange` treats "can't parse" as "leave it alone."
 * - Relative/duration-shaped values (e.g. `-1h`), which some datasource UIs
 *   display but neither Prometheus's nor Loki's HTTP query APIs accept as
 *   literal `start`/`end` query values.
 * - Any time-range information embedded outside the flat `query` params
 *   object -- e.g. inside a POST `body` for some hypothetical exotic
 *   datasource -- since the generic-proxy design never introspects `body`.
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
  if (numeric > MAX_PLAUSIBLE_UNIX_MS) {
    return undefined;
  }
  return { epochMs: numeric, format: 'unix-ms' };
}

function formatTimestamp(epochMs: number, format: TimestampFormat): string {
  switch (format) {
    case 'rfc3339':
      return new Date(epochMs).toISOString();
    case 'unix-seconds':
      return String(Math.floor(epochMs / 1000));
    case 'unix-ms':
      return String(Math.round(epochMs));
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
