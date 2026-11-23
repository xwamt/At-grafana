import { describe, expect, it } from 'vitest';
import { buildLokiProxyCall, buildPrometheusProxyCall } from '../../src/grafana/typedDatasourceQueries';

describe('buildPrometheusProxyCall', () => {
  it('maps range queries to api/v1/query_range', () => {
    expect(
      buildPrometheusProxyCall({
        expr: 'up',
        queryType: 'range',
        start: '1700000000',
        end: '1700003600',
        step: '15s'
      })
    ).toEqual({
      method: 'GET',
      path: 'api/v1/query_range',
      query: { query: 'up', start: '1700000000', end: '1700003600', step: '15s' }
    });
  });

  it('omits absent optional range bounds so QueryLimits can materialize them', () => {
    expect(buildPrometheusProxyCall({ expr: 'up', queryType: 'range' })).toEqual({
      method: 'GET',
      path: 'api/v1/query_range',
      query: { query: 'up' }
    });
  });

  it('converts epoch-millisecond range bounds to Unix seconds', () => {
    expect(
      buildPrometheusProxyCall(
        {
          expr: 'up',
          queryType: 'range',
          start: '1700000000000',
          end: '1700003600000'
        },
        1_700_003_600_000
      )
    ).toEqual({
      method: 'GET',
      path: 'api/v1/query_range',
      query: { query: 'up', start: '1700000000', end: '1700003600' }
    });
  });

  it('resolves relative range bounds and instant times against a fixed clock', () => {
    expect(
      buildPrometheusProxyCall(
        { expr: 'up', queryType: 'range', start: 'now-1h', end: 'now' },
        1_700_003_600_000
      )
    ).toEqual({
      method: 'GET',
      path: 'api/v1/query_range',
      query: { query: 'up', start: String(1_700_003_600 - 3600), end: '1700003600' }
    });
    expect(
      buildPrometheusProxyCall({ expr: 'up', queryType: 'instant', time: 'now-30m' }, 1_700_003_600_000)
    ).toEqual({
      method: 'GET',
      path: 'api/v1/query',
      query: { query: 'up', time: String(1_700_003_600 - 1800) }
    });
  });

  it('maps instant queries to api/v1/query and ignores start/end/step', () => {
    expect(
      buildPrometheusProxyCall({
        expr: 'up',
        queryType: 'instant',
        time: '1700000000',
        start: '1',
        end: '2',
        step: '15s'
      })
    ).toEqual({
      method: 'GET',
      path: 'api/v1/query',
      query: { query: 'up', time: '1700000000' }
    });
  });
});

describe('buildLokiProxyCall', () => {
  it('maps range queries to loki/api/v1/query_range', () => {
    expect(
      buildLokiProxyCall({
        expr: '{job="api"}',
        queryType: 'range',
        start: '1700000000000000000',
        end: '1700003600000000000',
        limit: 50,
        direction: 'backward'
      })
    ).toEqual({
      method: 'GET',
      path: 'loki/api/v1/query_range',
      query: {
        query: '{job="api"}',
        start: '1700000000000000000',
        end: '1700003600000000000',
        limit: '50',
        direction: 'backward'
      }
    });
  });

  it('maps instant queries to loki/api/v1/query and resolves relative times', () => {
    expect(
      buildLokiProxyCall({ expr: 'sum(rate({job="api"}[5m]))', queryType: 'instant', time: 'now' }, 1_700_003_600_000)
    ).toEqual({
      method: 'GET',
      path: 'loki/api/v1/query',
      query: { query: 'sum(rate({job="api"}[5m]))', time: '1700003600' }
    });
  });

  it('converts millisecond range bounds to Unix seconds while preserving Loki nanoseconds', () => {
    expect(
      buildLokiProxyCall({ expr: '{job="api"}', queryType: 'range', start: '1700000000000', end: '1700003600000' })
    ).toEqual({
      method: 'GET',
      path: 'loki/api/v1/query_range',
      query: { query: '{job="api"}', start: '1700000000', end: '1700003600' }
    });
    expect(
      buildLokiProxyCall({
        expr: '{job="api"}',
        queryType: 'range',
        start: '1700000000000000000',
        end: '1700003600000000000'
      })
    ).toEqual({
      method: 'GET',
      path: 'loki/api/v1/query_range',
      query: { query: '{job="api"}', start: '1700000000000000000', end: '1700003600000000000' }
    });
  });

  it('forwards limit and direction on instant queries (Loki instant supports both) without start/end', () => {
    expect(
      buildLokiProxyCall({
        expr: '{job="api"}',
        queryType: 'instant',
        time: '1700000000',
        start: '1',
        end: '2',
        limit: 50,
        direction: 'backward'
      })
    ).toEqual({
      method: 'GET',
      path: 'loki/api/v1/query',
      query: { query: '{job="api"}', time: '1700000000', limit: '50', direction: 'backward' }
    });
  });
});
