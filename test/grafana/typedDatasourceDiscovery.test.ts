import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_LIST_MAX,
  PROMETHEUS_LABEL_PATTERN,
  buildLokiLabelNamesCall,
  buildLokiLabelValuesCall,
  buildPrometheusLabelValuesCall,
  buildPrometheusMetricNamesCall,
  projectDiscoveryValues
} from '../../src/grafana/typedDatasourceDiscovery';

describe('buildPrometheusMetricNamesCall', () => {
  it('uses GET api/v1/label/__name__/values', () => {
    expect(buildPrometheusMetricNamesCall({})).toEqual({
      method: 'GET',
      path: 'api/v1/label/__name__/values',
      query: {}
    });
  });

  it('forwards optional start and end', () => {
    expect(buildPrometheusMetricNamesCall({ start: '1700000000', end: '1700003600' })).toEqual({
      method: 'GET',
      path: 'api/v1/label/__name__/values',
      query: { start: '1700000000', end: '1700003600' }
    });
  });
});

describe('buildPrometheusLabelValuesCall', () => {
  it('puts a valid label in the path and matcher in match[]', () => {
    expect(buildPrometheusLabelValuesCall({ label: 'job', matcher: '{__name__="up"}' })).toEqual({
      method: 'GET',
      path: 'api/v1/label/job/values',
      query: { 'match[]': '{__name__="up"}' }
    });
  });

  it('rejects labels that could escape the proxy path', () => {
    expect(() => buildPrometheusLabelValuesCall({ label: '..' })).toThrow(/label/);
    expect(() => buildPrometheusLabelValuesCall({ label: 'job/name' })).toThrow(/label/);
    expect(() => buildPrometheusLabelValuesCall({ label: '' })).toThrow(/label/);
  });
});

describe('buildLokiLabelNamesCall', () => {
  it('uses GET loki/api/v1/labels', () => {
    expect(buildLokiLabelNamesCall({ start: '1', end: '2' })).toEqual({
      method: 'GET',
      path: 'loki/api/v1/labels',
      query: { start: '1', end: '2' }
    });
  });
});

describe('buildLokiLabelValuesCall', () => {
  it('uses GET loki/api/v1/label/<label>/values', () => {
    expect(buildLokiLabelValuesCall({ label: 'job' })).toEqual({
      method: 'GET',
      path: 'loki/api/v1/label/job/values',
      query: {}
    });
  });
});

describe('projectDiscoveryValues', () => {
  it('reads Prometheus { status, data: string[] } and caps at DISCOVERY_LIST_MAX', () => {
    const data = Array.from({ length: DISCOVERY_LIST_MAX + 5 }, (_, i) => `m${i}`);
    const result = projectDiscoveryValues({ status: 'success', data });
    expect(result.values).toHaveLength(DISCOVERY_LIST_MAX);
    expect(result.truncated).toBe(true);
  });

  it('applies regex before capping', () => {
    const result = projectDiscoveryValues({ data: ['up', 'http_requests', 'go_goroutines'] }, '^go_');
    expect(result).toEqual({ values: ['go_goroutines'] });
  });
});

describe('PROMETHEUS_LABEL_PATTERN', () => {
  it('accepts job and __name__-style underscore names, not path segments', () => {
    expect(PROMETHEUS_LABEL_PATTERN.test('job')).toBe(true);
    expect(PROMETHEUS_LABEL_PATTERN.test('_name')).toBe(true);
    expect(PROMETHEUS_LABEL_PATTERN.test('__name__')).toBe(true);
    expect(PROMETHEUS_LABEL_PATTERN.test('job/name')).toBe(false);
  });
});
