import { describe, expect, it } from 'vitest';
import type { GrafanaInstanceConfig } from '../../src/config/schema';
import { GrafanaApiError } from '../../src/grafana/GrafanaApiClient';
import {
  AlertGroupTreeItem,
  AlertRuleTreeItem,
  ErrorTreeItem,
  InstanceTreeItem,
  describeTreeError,
  type AlertRuleWithState
} from '../../src/tree/GrafanaTreeItems';

function instance(overrides: Partial<GrafanaInstanceConfig> = {}): GrafanaInstanceConfig {
  return {
    id: 'instance-1',
    label: 'Production',
    url: 'https://grafana.example.com',
    allowBackgroundAccess: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function rule(overrides: Partial<AlertRuleWithState> = {}): AlertRuleWithState {
  return { uid: 'r1', title: 'Rule', state: 'normal', ...overrides };
}

describe('InstanceTreeItem (UX-05)', () => {
  it('shows "Agent access off" and a lock icon for the default (gated) instance', () => {
    const item = new InstanceTreeItem(instance({ allowBackgroundAccess: false }));

    expect(item.description).toBe('Agent access off');
    expect((item.iconPath as { id: string }).id).toBe('lock');
    expect(item.tooltip).toContain('https://grafana.example.com');
    expect(item.tooltip).toContain('Agent access off');
  });

  it('shows "Agent access on" and the server icon when background access is enabled', () => {
    const item = new InstanceTreeItem(instance({ allowBackgroundAccess: true }));

    expect(item.description).toBe('Agent access on');
    expect((item.iconPath as { id: string }).id).toBe('server-environment');
    expect(item.tooltip).toContain('Agent access on');
  });
});

describe('ErrorTreeItem (UX-07)', () => {
  it('opens the instance edit form when constructed with an instanceId', () => {
    const item = new ErrorTreeItem('token rejected', { instanceId: 'instance-1' });

    expect(item.command).toMatchObject({
      command: 'atGrafana.editInstance',
      arguments: [{ instanceId: 'instance-1' }]
    });
  });

  it('has no command without an instanceId, and keeps the raw detail in the tooltip', () => {
    const item = new ErrorTreeItem('friendly message', { detail: 'ECONNREFUSED 127.0.0.1:3000' });

    expect(item.command).toBeUndefined();
    expect(item.description).toBe('friendly message');
    expect(item.tooltip).toContain('friendly message');
    expect(item.tooltip).toContain('ECONNREFUSED');
  });
});

describe('describeTreeError (UX-07)', () => {
  it('tells the user to edit the instance on an auth error', () => {
    expect(describeTreeError(new GrafanaApiError('auth', 'HTTP 401', 401))).toBe(
      'Grafana rejected the token. Edit the instance to update the token.'
    );
  });

  it('points at the TOFU confirmation flow on a tls error', () => {
    const message = describeTreeError(new GrafanaApiError('tls', 'self signed'));
    expect(message).toContain('Test Connection');
    expect(message).toContain('fingerprint');
  });

  it('points at URL/network on a network error', () => {
    const message = describeTreeError(new GrafanaApiError('network', 'ECONNREFUSED'));
    expect(message).toContain('URL');
  });

  it('falls back to the raw message for unclassified errors', () => {
    expect(describeTreeError(new Error('weird'))).toBe('weird');
  });
});

describe('AlertGroupTreeItem description (UX-18)', () => {
  it('appends the firing count when at least one rule is firing', () => {
    const item = new AlertGroupTreeItem(instance(), 'f1', 'g1', 'Infra / g1', 'firing', [
      rule({ uid: 'r1', state: 'firing' }),
      rule({ uid: 'r2', state: 'firing' }),
      rule({ uid: 'r3', state: 'normal' })
    ]);

    expect(item.description).toBe('3 rules · 2 firing');
  });

  it('keeps the plain rule count when nothing is firing', () => {
    const item = new AlertGroupTreeItem(instance(), 'f1', 'g1', 'Infra / g1', 'normal', [
      rule({ uid: 'r1' }),
      rule({ uid: 'r2' })
    ]);

    expect(item.description).toBe('2 rules');
  });
});

describe('AlertRuleTreeItem paused rendering (UX-18)', () => {
  it('renders a paused rule with the pause icon and "paused" description', () => {
    const item = new AlertRuleTreeItem(instance(), rule({ isPaused: true, state: 'normal' }));

    expect((item.iconPath as { id: string }).id).toBe('debug-pause');
    expect(item.description).toBe('paused');
  });

  it('renders a non-paused rule with its state as before', () => {
    const item = new AlertRuleTreeItem(instance(), rule({ state: 'firing', rawState: 'firing' }));

    expect((item.iconPath as { id: string }).id).toBe('bell-dot');
    expect(item.description).toBe('firing');
  });
});
