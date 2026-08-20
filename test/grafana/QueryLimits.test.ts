import { describe, expect, it } from 'vitest';
import {
  buildResponseSizeTruncationEnvelope,
  buildTimeRangeTruncationEnvelope,
  clampQueryTimeRange,
  classifyQueryEndpoint,
  DEFAULT_MAX_RANGE_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  planQueryLimits,
  resolveMaxRangeMs,
  resolveMaxResponseBytes,
  type EffectiveQueryLimits
} from '../../src/grafana/QueryLimits';

describe('resolveMaxRangeMs / resolveMaxResponseBytes', () => {
  it('falls back to the proposed default when unset', () => {
    expect(resolveMaxRangeMs(undefined)).toBe(DEFAULT_MAX_RANGE_MS);
    expect(resolveMaxResponseBytes(undefined)).toBe(DEFAULT_MAX_RESPONSE_BYTES);
  });

  it('uses a valid configured value verbatim', () => {
    expect(resolveMaxRangeMs(1_000)).toBe(1_000);
    expect(resolveMaxResponseBytes(2_048)).toBe(2_048);
  });

  it('falls back to the default for a non-positive or non-finite configured value', () => {
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveMaxRangeMs(invalid)).toBe(DEFAULT_MAX_RANGE_MS);
      expect(resolveMaxResponseBytes(invalid)).toBe(DEFAULT_MAX_RESPONSE_BYTES);
    }
  });
});

describe('clampQueryTimeRange', () => {
  const maxRangeMs = 60 * 60 * 1000; // 1h

  it('does not touch a query with no start/end', () => {
    const query = { query: 'up' };
    expect(clampQueryTimeRange(query, maxRangeMs)).toEqual({ query, clamped: false });
    expect(clampQueryTimeRange(undefined, maxRangeMs)).toEqual({ query: undefined, clamped: false });
  });

  it('never expands a range the agent already narrowed below the cap (Prometheus unix-seconds)', () => {
    const query = { start: '1700000000', end: '1700001800' }; // 30 minutes, under the 1h cap
    expect(clampQueryTimeRange(query, maxRangeMs)).toEqual({ query, clamped: false });
  });

  it('leaves an exactly-at-cap range untouched', () => {
    const query = { start: '1700000000', end: String(1700000000 + maxRangeMs / 1000) };
    expect(clampQueryTimeRange(query, maxRangeMs)).toEqual({ query, clamped: false });
  });

  it('clamps an over-cap range expressed as Prometheus unix-seconds, moving only start', () => {
    const end = 1700010000;
    const start = end - 4 * 60 * 60; // 4h range, over the 1h cap
    const result = clampQueryTimeRange({ start: String(start), end: String(end) }, maxRangeMs);

    expect(result.clamped).toBe(true);
    expect(result.query?.end).toBe(String(end));
    expect(result.query?.start).toBe(String(end - maxRangeMs / 1000));
  });

  it('clamps an over-cap range expressed as unix-milliseconds, preserving the millisecond format', () => {
    const end = 1700010000000;
    const start = end - 4 * 60 * 60 * 1000;
    const result = clampQueryTimeRange({ start: String(start), end: String(end) }, maxRangeMs);

    expect(result.clamped).toBe(true);
    expect(result.query?.start).toBe(String(end - maxRangeMs));
    // Milliseconds, not seconds -- format is preserved from the original `start`.
    expect(Number(result.query?.start)).toBeGreaterThan(1e12);
  });

  it('clamps an over-cap range expressed as RFC3339, preserving the RFC3339 format', () => {
    const end = '2026-07-29T12:00:00.000Z';
    const start = '2026-07-29T06:00:00.000Z'; // 6h range, over the 1h cap
    const result = clampQueryTimeRange({ start, end }, maxRangeMs);

    expect(result.clamped).toBe(true);
    expect(result.query?.end).toBe(end);
    expect(result.query?.start).toBe(new Date(Date.parse(end) - maxRangeMs).toISOString());
  });

  it('preserves other query params untouched while clamping start', () => {
    const result = clampQueryTimeRange({ query: 'up', step: '15s', start: '1700000000', end: '1700018000' }, maxRangeMs);
    expect(result.clamped).toBe(true);
    expect(result.query).toMatchObject({ query: 'up', step: '15s' });
  });

  it('does not clamp when end <= start (malformed range) -- documented limitation, not silently coerced', () => {
    const query = { start: '1700010000', end: '1700000000' };
    expect(clampQueryTimeRange(query, maxRangeMs)).toEqual({ query, clamped: false });
  });

  it('does not clamp a relative duration (documented unsupported format)', () => {
    const relative = { start: '-1h', end: 'now' };
    expect(clampQueryTimeRange(relative, maxRangeMs)).toEqual({ query: relative, clamped: false });
  });

  /**
   * Loki's query APIs accept nanosecond epochs by default, and this clamp used
   * to answer "can't parse" for them and wave them through -- so asking Loki
   * for a week of logs in nanoseconds skipped the cap entirely. The arithmetic
   * runs in BigInt because a 19-digit nanosecond value is past the point where
   * a JS number can represent consecutive integers.
   */
  it('clamps a nanosecond-epoch range, which Loki accepts and this used to wave through', () => {
    const endNs = 1_770_000_000_000_000_000n;
    const startNs = endNs - 24n * 3_600n * 1_000_000_000n; // 24h, over the 1h cap
    const result = clampQueryTimeRange({ start: String(startNs), end: String(endNs) }, maxRangeMs);

    expect(result.clamped).toBe(true);
    expect(result.query?.end).toBe(String(endNs));
    expect(BigInt(result.query?.start ?? '0')).toBe(endNs - BigInt(maxRangeMs) * 1_000_000n);
  });

  it('still refuses to guess at a value between the millisecond and nanosecond bands', () => {
    // ~1e15: could be microseconds, could be a nonsense millisecond value in
    // the year 33658. Neither Prometheus nor Loki sends this, so guessing has
    // no upside.
    const ambiguous = { start: '1700000000000000', end: '1700018000000000' };
    expect(clampQueryTimeRange(ambiguous, maxRangeMs)).toEqual({ query: ambiguous, clamped: false });
  });
});

/**
 * `clampQueryTimeRange` on its own only bites when `start` and `end` are both
 * present, both parseable, and forward-moving. Every one of the cases below is
 * a way an agent reaches Prometheus or Loki with that condition unmet, or with
 * a range that satisfies the cap while still being ruinously expensive to
 * evaluate. `planQueryLimits` is what closes them, and it only engages for
 * paths it positively recognizes -- an unrecognized datasource path keeps the
 * generic pass-through behavior D8 requires.
 */
describe('planQueryLimits bypass closures', () => {
  const NOW = 1_770_000_000_000; // epoch ms
  const limits: EffectiveQueryLimits = {
    maxRangeMs: 12 * 60 * 60 * 1000,
    maxResponseBytes: 5 * 1024 * 1024,
    maxPoints: 1000,
    maxLokiLimit: 1000,
    queryTimeoutMs: 10_000
  };

  it('materializes a missing end so an omitted bound cannot skip the range cap', () => {
    const startSeconds = NOW / 1000 - 24 * 3600; // 24h ago, over the 12h cap

    const plan = planQueryLimits({
      path: 'loki/api/v1/query_range',
      query: { query: '{app="x"}', start: String(startSeconds) },
      limits,
      now: NOW
    });

    expect(plan.adjustments).toContain('time-range');
    expect(plan.query?.end).toBe(String(NOW / 1000));
    expect(plan.query?.start).toBe(String(NOW / 1000 - 12 * 3600));
  });

  it('materializes a missing start the same way', () => {
    const endSeconds = NOW / 1000;

    const plan = planQueryLimits({
      path: 'api/v1/query_range',
      query: { query: 'up', end: String(endSeconds) },
      limits,
      now: NOW
    });

    expect(plan.adjustments).toContain('time-range');
    expect(plan.query?.start).toBe(String(endSeconds - 12 * 3600));
  });

  it('materializes both missing bounds on a recognized range endpoint as now..now-maxRangeMs', () => {
    const plan = planQueryLimits({
      path: 'api/v1/query_range',
      query: { query: 'up' },
      limits,
      now: NOW
    });

    expect(plan.query?.end).toBeDefined();
    expect(plan.query?.start).toBeDefined();
    const start = Date.parse(plan.query?.start ?? '');
    const end = Date.parse(plan.query?.end ?? '');
    expect(end).toBe(NOW);
    expect(end - start).toBe(limits.maxRangeMs);
    // Filling a default window of exactly maxRangeMs is not truncation.
    expect(plan.adjustments).not.toContain('time-range');
  });

  it('materializes both missing bounds on a Loki range endpoint as rfc3339 now..now-maxRangeMs', () => {
    const plan = planQueryLimits({
      path: 'loki/api/v1/query_range',
      query: { query: '{app="x"}' },
      limits,
      now: NOW
    });

    expect(plan.query?.end).toBeDefined();
    expect(plan.query?.start).toBeDefined();
    const start = Date.parse(plan.query?.start ?? '');
    const end = Date.parse(plan.query?.end ?? '');
    expect(end).toBe(NOW);
    expect(end - start).toBe(limits.maxRangeMs);
    expect(plan.adjustments).not.toContain('time-range');
  });

  it('raises a step that would evaluate more points than the budget allows', () => {
    const end = NOW / 1000;
    const start = end - 12 * 3600; // exactly at the cap, so the range itself is legal

    const plan = planQueryLimits({
      path: 'api/v1/query_range',
      query: { query: 'up', start: String(start), end: String(end), step: '1s' },
      limits,
      now: NOW
    });

    // 43200s / 1000 points = 43.2s, rounded up.
    expect(plan.query?.step).toBe('44s');
    expect(plan.adjustments).toContain('step');
  });

  it('leaves a step that is already coarse enough alone', () => {
    const end = NOW / 1000;
    const start = end - 3600;

    const plan = planQueryLimits({
      path: 'api/v1/query_range',
      query: { query: 'up', start: String(start), end: String(end), step: '5m' },
      limits,
      now: NOW
    });

    expect(plan.query?.step).toBe('5m');
    expect(plan.adjustments).not.toContain('step');
  });

  it('replaces a step it cannot parse rather than waving it through', () => {
    const end = NOW / 1000;
    const start = end - 3600;

    const plan = planQueryLimits({
      path: 'api/v1/query_range',
      query: { query: 'up', start: String(start), end: String(end), step: 'not-a-duration' },
      limits,
      now: NOW
    });

    expect(plan.query?.step).toBe('4s'); // 3600s / 1000
    expect(plan.adjustments).toContain('step');
  });

  it('caps a Loki entry limit that would return far more lines than the budget', () => {
    const plan = planQueryLimits({
      path: 'loki/api/v1/query_range',
      query: { query: '{app="x"}', limit: '100000' },
      limits,
      now: NOW
    });

    expect(plan.query?.limit).toBe('1000');
    expect(plan.adjustments).toContain('loki-limit');
  });

  it('leaves a Loki limit under the cap alone', () => {
    const plan = planQueryLimits({
      path: 'loki/api/v1/query',
      query: { query: '{app="x"}', limit: '50' },
      limits,
      now: NOW
    });

    expect(plan.query?.limit).toBe('50');
    expect(plan.adjustments).not.toContain('loki-limit');
  });

  it('gives a Prometheus instant query a server-side timeout, the only lever it has', () => {
    // /api/v1/query has no start/end at all, so there is no range to clamp --
    // its cost is evaluation, and the only thing that bounds evaluation is
    // telling Prometheus to give up.
    const plan = planQueryLimits({
      path: 'api/v1/query',
      query: { query: 'sum(rate(http_requests_total[5m]))' },
      limits,
      now: NOW
    });

    expect(plan.query?.timeout).toBe('10s');
    expect(plan.adjustments).toContain('query-timeout');
  });

  it('does not lengthen a timeout the agent already set shorter', () => {
    const plan = planQueryLimits({
      path: 'api/v1/query',
      query: { query: 'up', timeout: '2s' },
      limits,
      now: NOW
    });

    expect(plan.query?.timeout).toBe('2s');
  });

  it('clamps a range smuggled through a POST body on a recognized query endpoint', () => {
    const endSeconds = NOW / 1000;
    const startSeconds = endSeconds - 24 * 3600;

    const plan = planQueryLimits({
      path: 'api/v1/query_range',
      query: {},
      body: { query: 'up', start: String(startSeconds), end: String(endSeconds) },
      limits,
      now: NOW
    });

    expect(plan.adjustments).toContain('time-range');
    expect(plan.body).toMatchObject({ start: String(endSeconds - 12 * 3600), end: String(endSeconds) });
  });

  it('leaves an unrecognized datasource path entirely alone, preserving the generic pass-through', () => {
    const query = { anything: 'goes', step: '1s', limit: '999999' };

    const plan = planQueryLimits({
      path: 'api/v2/some-exotic-datasource/search',
      query,
      limits,
      now: NOW
    });

    expect(plan.query).toEqual(query);
    expect(plan.adjustments).toEqual([]);
  });
});

describe('classifyQueryEndpoint', () => {
  it('recognizes the Prometheus and Loki query endpoints, with or without a leading slash', () => {
    expect(classifyQueryEndpoint('api/v1/query_range')).toBe('prometheus-range');
    expect(classifyQueryEndpoint('/api/v1/query_range')).toBe('prometheus-range');
    expect(classifyQueryEndpoint('api/v1/query')).toBe('prometheus-instant');
    expect(classifyQueryEndpoint('loki/api/v1/query_range')).toBe('loki-range');
    expect(classifyQueryEndpoint('loki/api/v1/query')).toBe('loki-instant');
  });

  it('does not classify anything else', () => {
    expect(classifyQueryEndpoint('api/v1/labels')).toBeUndefined();
    expect(classifyQueryEndpoint('api/v1/query_exemplars')).toBeUndefined();
    expect(classifyQueryEndpoint('')).toBeUndefined();
  });
});

describe('truncation envelopes', () => {
  it('buildTimeRangeTruncationEnvelope always produces a well-formed, round-trippable JSON object that includes the actual result', () => {
    const result = { status: 'success', data: { resultType: 'matrix', result: [] } };
    const envelope = buildTimeRangeTruncationEnvelope(3_600_000, result);

    expect(envelope).toMatchObject({ truncated: true, reason: 'time-range', maxRangeMs: 3_600_000, result });
    expect(envelope.message.length).toBeGreaterThan(0);
    expect(() => JSON.parse(JSON.stringify(envelope))).not.toThrow();
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  it('buildResponseSizeTruncationEnvelope always produces a well-formed, round-trippable JSON object with no partial result', () => {
    const envelope = buildResponseSizeTruncationEnvelope(1_048_576);

    expect(envelope).toMatchObject({ truncated: true, reason: 'response-size', maxBytes: 1_048_576 });
    expect(envelope.message.length).toBeGreaterThan(0);
    expect('result' in envelope).toBe(false);
    expect(() => JSON.parse(JSON.stringify(envelope))).not.toThrow();
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  it('never mid-structure-truncates even when the wrapped result is large/deeply nested', () => {
    const largeResult = { series: Array.from({ length: 1000 }, (_, i) => ({ id: i, values: [1, 2, 3] })) };
    const envelope = buildTimeRangeTruncationEnvelope(1_000, largeResult);
    const roundTripped = JSON.parse(JSON.stringify(envelope)) as typeof envelope;
    expect(roundTripped.result).toEqual(largeResult);
  });
});
