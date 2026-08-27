import { describe, expect, it } from 'vitest';
import { buildGrafanaDeeplink, buildOpenInIdeSearch } from '../../src/grafana/grafanaDeeplink';

describe('buildGrafanaDeeplink', () => {
  it('builds a dashboard URL with viewPanel and range, stripping a trailing slash on origin', () => {
    expect(
      buildGrafanaDeeplink('https://grafana.example.com/', {
        kind: 'dashboard',
        uid: 'dash-1',
        panelId: 5,
        from: 'now-1h',
        to: 'now'
      })
    ).toBe('https://grafana.example.com/d/dash-1?viewPanel=5&from=now-1h&to=now');
  });

  it('builds an Explore left-pane URL with default range now-1h..now', () => {
    const url = buildGrafanaDeeplink('https://grafana.example.com', {
      kind: 'explore',
      datasourceUid: 'prom'
    });
    expect(url.startsWith('https://grafana.example.com/explore?left=')).toBe(true);
    const left = JSON.parse(decodeURIComponent(new URL(url).searchParams.get('left') ?? ''));
    expect(left).toEqual({
      datasource: 'prom',
      queries: [{ refId: 'A', datasource: { uid: 'prom' } }],
      range: { from: 'now-1h', to: 'now' }
    });
  });

  it('writes an optional expr into the first Explore query', () => {
    const url = buildGrafanaDeeplink('https://grafana.example.com', {
      kind: 'explore',
      datasourceUid: 'prom',
      expr: 'rate(http_requests_total[5m])',
      from: 'now-6h',
      to: 'now'
    });
    const left = JSON.parse(decodeURIComponent(new URL(url).searchParams.get('left') ?? ''));
    expect(left).toEqual({
      datasource: 'prom',
      queries: [{ refId: 'A', datasource: { uid: 'prom' }, expr: 'rate(http_requests_total[5m])' }],
      range: { from: 'now-6h', to: 'now' }
    });
  });

  it('builds an alert-rule view URL matching Grafana\'s Unified Alerting route, encoding the uid', () => {
    expect(
      buildGrafanaDeeplink('https://grafana.example.com/', { kind: 'alertRule', uid: 'rule/one' })
    ).toBe('https://grafana.example.com/alerting/grafana/rule%2Fone/view');
  });
});

describe('buildOpenInIdeSearch', () => {
  it('returns the same viewPanel/from/to query string used on the Grafana URL', () => {
    expect(buildOpenInIdeSearch({ panelId: 5, from: 'now-6h', to: 'now' })).toBe(
      'viewPanel=5&from=now-6h&to=now'
    );
  });
});
