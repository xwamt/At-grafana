import { describe, expect, it } from 'vitest';
import {
  buildResponseSizeTruncationEnvelope,
  buildTimeRangeTruncationEnvelope,
  clampQueryTimeRange,
  DEFAULT_MAX_RANGE_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  resolveMaxRangeMs,
  resolveMaxResponseBytes
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

  it('does not clamp an unparseable value, e.g. a relative duration or a nanosecond epoch (documented unsupported formats)', () => {
    const relative = { start: '-1h', end: 'now' };
    expect(clampQueryTimeRange(relative, maxRangeMs)).toEqual({ query: relative, clamped: false });

    // 19-digit nanosecond epoch -- explicitly unsupported per parseTimestamp's doc.
    const nanoseconds = { start: '1700000000000000000', end: '1700018000000000000' };
    expect(clampQueryTimeRange(nanoseconds, maxRangeMs)).toEqual({ query: nanoseconds, clamped: false });
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
