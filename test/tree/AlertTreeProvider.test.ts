import { describe, expect, it } from 'vitest';
import type { GrafanaInstanceConfig } from '../../src/config/schema';
import type { GrafanaFolder } from '../../src/grafana/GrafanaDashboardsApi';
import type { GrafanaAlertRule, GrafanaAlertRuleState } from '../../src/grafana/GrafanaAlertsApi';
import { AlertTreeProvider, type AlertApiClient } from '../../src/tree/AlertTreeProvider';
import {
  AlertGroupTreeItem,
  AlertRuleTreeItem,
  ErrorTreeItem,
  InstanceTreeItem,
  MessageTreeItem
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

function rule(overrides: Partial<GrafanaAlertRule> = {}): GrafanaAlertRule {
  return {
    uid: 'r1',
    title: 'Rule',
    folderUid: 'f1',
    ruleGroup: 'g1',
    condition: 'B',
    for: '5m',
    ...overrides
  };
}

function state(overrides: Partial<GrafanaAlertRuleState> = {}): GrafanaAlertRuleState {
  return {
    uid: 'r1',
    name: 'Rule',
    state: 'normal',
    group: 'g1',
    ...overrides
  };
}

const folders: GrafanaFolder[] = [
  { uid: 'f1', title: 'Infra' },
  { uid: 'f2', title: 'Payments' }
];

describe('AlertTreeProvider', () => {
  it('returns no root children (not an error) when no instances are configured, so the viewsWelcome "Add Instance" button renders', async () => {
    const provider = new AlertTreeProvider({ listInstances: async () => [] }, async () => {
      throw new Error('createClient should not be called with no instances');
    });

    const children = await provider.getChildren();

    expect(children).toEqual([]);
  });

  it('lists one node per configured instance at the root', async () => {
    const instances = [instance({ id: 'a', label: 'A' }), instance({ id: 'b', label: 'B' })];
    const provider = new AlertTreeProvider(
      { listInstances: async () => instances },
      async (): Promise<AlertApiClient> => ({
        listAlertRules: async () => [],
        listAlertRuleStates: async () => [],
        getFolders: async () => []
      })
    );

    const children = await provider.getChildren();

    expect(children).toHaveLength(2);
    expect(children.every((child) => child instanceof InstanceTreeItem)).toBe(true);
  });

  it('shows a message node when an instance has no alert rules', async () => {
    const inst = instance();
    const provider = new AlertTreeProvider(
      { listInstances: async () => [inst] },
      async (): Promise<AlertApiClient> => ({
        listAlertRules: async () => [],
        listAlertRuleStates: async () => [],
        getFolders: async () => folders
      })
    );

    const [instanceItem] = await provider.getChildren();
    const children = await provider.getChildren(instanceItem);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(MessageTreeItem);
  });

  it('groups rules by folder+ruleGroup and sorts groups/rules firing before pending before normal', async () => {
    const inst = instance();
    const client: AlertApiClient = {
      listAlertRules: async () => [
        rule({ uid: 'r1', title: 'CPU high', folderUid: 'f1', ruleGroup: 'g-a' }),
        rule({ uid: 'r2', title: 'CPU normal', folderUid: 'f1', ruleGroup: 'g-a' }),
        rule({ uid: 'r3', title: 'Disk pending', folderUid: 'f1', ruleGroup: 'g-b' }),
        // No matching state entry below — must be treated as unknown, not crash.
        rule({ uid: 'r4', title: 'Payments unknown', folderUid: 'f2', ruleGroup: 'g-c' })
      ],
      listAlertRuleStates: async () => [
        state({ uid: 'r1', state: 'firing', group: 'g-a' }),
        state({ uid: 'r2', state: 'normal', group: 'g-a' }),
        state({ uid: 'r3', state: 'pending', group: 'g-b' })
      ],
      getFolders: async () => folders
    };
    const provider = new AlertTreeProvider({ listInstances: async () => [inst] }, async () => client);

    const [instanceItem] = await provider.getChildren();
    const groups = (await provider.getChildren(instanceItem)) as AlertGroupTreeItem[];

    expect(groups.map((group) => group.ruleGroup)).toEqual(['g-a', 'g-b', 'g-c']);
    expect(groups[0].label).toBe('Infra / g-a');
    expect(groups[0].worstState).toBe('firing');
    expect(groups[1].worstState).toBe('pending');
    expect(groups[2].worstState).toBe('unknown');

    const groupARules = (await provider.getChildren(groups[0])) as AlertRuleTreeItem[];
    expect(groupARules.map((item) => item.rule.uid)).toEqual(['r1', 'r2']);
    expect(groupARules[0].rule.state).toBe('firing');
    expect(groupARules[1].rule.state).toBe('normal');

    const groupCRules = (await provider.getChildren(groups[2])) as AlertRuleTreeItem[];
    expect(groupCRules).toHaveLength(1);
    expect(groupCRules[0].rule.state).toBe('unknown');
    expect(groupCRules[0].rule.uid).toBe('r4');
  });

  it('surfaces a root-level listInstances error as a single ErrorTreeItem without throwing', async () => {
    const provider = new AlertTreeProvider(
      {
        listInstances: async () => {
          throw new Error('storage unavailable');
        }
      },
      async (): Promise<AlertApiClient> => ({
        listAlertRules: async () => [],
        listAlertRuleStates: async () => [],
        getFolders: async () => []
      })
    );

    const children = await provider.getChildren();

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorTreeItem);
  });

  it('surfaces an instance-level API error as a single ErrorTreeItem without throwing out of getChildren', async () => {
    const inst = instance();
    const provider = new AlertTreeProvider({ listInstances: async () => [inst] }, async () => {
      throw new Error('unauthorized');
    });

    const [instanceItem] = await provider.getChildren();
    const children = await provider.getChildren(instanceItem);

    expect(children).toHaveLength(1);
    expect(children[0]).toBeInstanceOf(ErrorTreeItem);
    expect((children[0] as ErrorTreeItem).description).toContain('unauthorized');
  });

  it('refresh() clears the cached groups so the next expand re-fetches from the client', async () => {
    const inst = instance();
    let callCount = 0;
    const provider = new AlertTreeProvider(
      { listInstances: async () => [inst] },
      async (): Promise<AlertApiClient> => {
        callCount += 1;
        return { listAlertRules: async () => [], listAlertRuleStates: async () => [], getFolders: async () => [] };
      }
    );

    const [instanceItem] = await provider.getChildren();
    await provider.getChildren(instanceItem);
    await provider.getChildren(instanceItem);
    expect(callCount).toBe(1);

    provider.refresh();
    await provider.getChildren(instanceItem);
    expect(callCount).toBe(2);
  });
});
