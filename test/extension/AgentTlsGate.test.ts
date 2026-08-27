import { describe, expect, it } from 'vitest';
import type { GrafanaInstanceConfig } from '../../src/config/schema';
import type { TrustedCert } from '../../src/grafana/GrafanaCertTrustStore';
import { assertAgentTlsPreTrusted, grafanaUrlFromTreeItem, instanceIdFromCommandArg } from '../../src/extension';
import { AlertRuleTreeItem, DashboardTreeItem, InstanceTreeItem } from '../../src/tree/GrafanaTreeItems';

function instance(overrides: Partial<GrafanaInstanceConfig> = {}): GrafanaInstanceConfig {
  return {
    id: 'instance-1',
    label: 'Production',
    url: 'https://grafana.example.com',
    allowBackgroundAccess: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function storeWith(entries: Record<string, TrustedCert>) {
  return {
    getTrusted: (host: string, port: number) => entries[`${host}:${port}`]
  };
}

const cert: TrustedCert = { host: 'grafana.example.com', port: 443, fingerprint: 'SHA256:abc', trustedAt: 1 };

describe('assertAgentTlsPreTrusted (FUNC-14)', () => {
  it('passes silently for plain http instances', () => {
    expect(() => assertAgentTlsPreTrusted('http://grafana.example.com:3000', storeWith({}))).not.toThrow();
  });

  it('passes when the https instance host:port is already trusted', () => {
    expect(() =>
      assertAgentTlsPreTrusted('https://grafana.example.com', storeWith({ 'grafana.example.com:443': cert }))
    ).not.toThrow();
  });

  it('uses the explicit port when the URL has one', () => {
    expect(() =>
      assertAgentTlsPreTrusted(
        'https://grafana.example.com:8443',
        storeWith({ 'grafana.example.com:8443': { ...cert, port: 8443 } })
      )
    ).not.toThrow();
  });

  it('throws (never prompts) for an https instance that has not been trusted yet', () => {
    expect(() => assertAgentTlsPreTrusted('https://grafana.example.com', storeWith({}))).toThrow(
      /not trusted yet/
    );
  });

  it('throws for a malformed URL', () => {
    expect(() => assertAgentTlsPreTrusted('not a url', storeWith({}))).toThrow(/Invalid Grafana URL/);
  });
});

describe('grafanaUrlFromTreeItem (UX-04)', () => {
  it('builds the /d/{uid} URL for a dashboard item, without a trailing-slash double', () => {
    const item = new DashboardTreeItem(instance({ url: 'https://grafana.example.com/' }), 'dash-1', 'CPU');
    expect(grafanaUrlFromTreeItem(item)).toBe('https://grafana.example.com/d/dash-1');
  });

  it('builds the unified-alerting view URL for an alert rule item', () => {
    const item = new AlertRuleTreeItem(instance(), { uid: 'rule-1', title: 'High CPU', state: 'firing' });
    expect(grafanaUrlFromTreeItem(item)).toBe('https://grafana.example.com/alerting/grafana/rule-1/view');
  });

  it('returns the instance base URL for an instance item', () => {
    const item = new InstanceTreeItem(instance());
    expect(grafanaUrlFromTreeItem(item)).toBe('https://grafana.example.com');
  });

  it('returns undefined for anything else', () => {
    expect(grafanaUrlFromTreeItem(undefined)).toBeUndefined();
    expect(grafanaUrlFromTreeItem({})).toBeUndefined();
  });
});

describe('instanceIdFromCommandArg', () => {
  it('reads the id from a tree item carrying an instance', () => {
    expect(instanceIdFromCommandArg(new InstanceTreeItem(instance({ id: 'via-item' })))).toBe('via-item');
  });

  it('reads a bare instanceId (the ErrorTreeItem command shape)', () => {
    expect(instanceIdFromCommandArg({ instanceId: 'via-error-node' })).toBe('via-error-node');
  });

  it('returns undefined for anything else', () => {
    expect(instanceIdFromCommandArg(undefined)).toBeUndefined();
    expect(instanceIdFromCommandArg('inst')).toBeUndefined();
    expect(instanceIdFromCommandArg({ instance: {} })).toBeUndefined();
  });
});
