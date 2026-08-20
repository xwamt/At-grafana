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
});

describe('buildOpenInIdeSearch', () => {
  it('returns the same viewPanel/from/to query string used on the Grafana URL', () => {
    expect(buildOpenInIdeSearch({ panelId: 5, from: 'now-6h', to: 'now' })).toBe(
      'viewPanel=5&from=now-6h&to=now'
    );
  });
});
