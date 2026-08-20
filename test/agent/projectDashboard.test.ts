import { describe, expect, it } from 'vitest';
import type { GrafanaDashboard } from '../../src/grafana/GrafanaDashboardsApi';
import { projectDashboard } from '../../src/agent/projectDashboard';

const heavyChrome = {
  fieldConfig: { defaults: { custom: { fillOpacity: 20, lineWidth: 2, spanNulls: false } }, overrides: [] },
  options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
  gridPos: { h: 8, w: 12, x: 0, y: 0 },
  transformations: [{ id: 'organize', options: { excludeByName: { Time: true } } }]
};

function sampleDashboard(): GrafanaDashboard {
  return {
    uid: 'd1',
    title: 'Ops Overview',
    folderUid: 'f1',
    folderTitle: 'Infra',
    version: 3,
    url: '/d/d1',
    model: {
      uid: 'd1',
      title: 'Ops Overview',
      time: { from: 'now-6h', to: 'now' },
      templating: { list: [{ name: 'job', type: 'query', query: 'label_values(job)' }] },
      annotations: { list: [{ name: 'Deploy', enable: true }] },
      panels: [
        {
          id: 1,
          title: 'CPU Usage',
          type: 'timeseries',
          datasource: { type: 'prometheus', uid: 'prom-1' },
          targets: [{ refId: 'A', expr: 'rate(cpu[5m])', datasource: { type: 'prometheus', uid: 'prom-1' } }],
          ...heavyChrome
        },
        {
          id: 2,
          title: 'Memory',
          type: 'timeseries',
          datasource: { type: 'prometheus', uid: 'prom-1' },
          targets: [{ refId: 'A', expr: 'node_memory_Active_bytes', datasource: { type: 'prometheus', uid: 'prom-1' } }],
          ...heavyChrome
        },
        {
          id: 10,
          title: 'Network Row',
          type: 'row',
          collapsed: true,
          panels: [
            {
              id: 11,
              title: 'Network In',
              type: 'timeseries',
              datasource: { type: 'prometheus', uid: 'prom-1' },
              targets: [{ refId: 'A', expr: 'rate(net_in[5m])', datasource: { type: 'prometheus', uid: 'prom-1' } }],
              ...heavyChrome
            },
            {
              id: 12,
              title: 'Disk IO',
              type: 'timeseries',
              datasource: { type: 'prometheus', uid: 'prom-1' },
              targets: [{ refId: 'A', expr: 'rate(disk_io[5m])', datasource: { type: 'prometheus', uid: 'prom-1' } }],
              ...heavyChrome
            }
          ]
        }
      ]
    }
  };
}

describe('projectDashboard', () => {
  it('defaults to targets and strips UI chrome', () => {
    const dashboard = sampleDashboard();
    const result = projectDashboard(dashboard, {});
    const cpu = (result.model.panels as Array<Record<string, unknown>>)[0];
    expect(cpu.targets).toEqual([
      { refId: 'A', expr: 'rate(cpu[5m])', datasource: { type: 'prometheus', uid: 'prom-1' } }
    ]);
    expect(cpu.fieldConfig).toBeUndefined();
    expect(cpu.gridPos).toBeUndefined();
    expect(result).not.toBe(dashboard);
  });

  it('returns the dashboard unchanged when fields is full', () => {
    const dashboard = sampleDashboard();
    expect(projectDashboard(dashboard, { fields: 'full' })).toBe(dashboard);
  });

  it('summary keeps uid/title/time and panel id/title/type/datasource only', () => {
    const result = projectDashboard(sampleDashboard(), { fields: 'summary' });

    expect(result.uid).toBe('d1');
    expect(result.title).toBe('Ops Overview');
    expect(result.model).toEqual({
      uid: 'd1',
      title: 'Ops Overview',
      time: { from: 'now-6h', to: 'now' },
      panels: [
        {
          id: 1,
          title: 'CPU Usage',
          type: 'timeseries',
          datasource: { type: 'prometheus', uid: 'prom-1' }
        },
        {
          id: 2,
          title: 'Memory',
          type: 'timeseries',
          datasource: { type: 'prometheus', uid: 'prom-1' }
        },
        {
          id: 10,
          title: 'Network Row',
          type: 'row',
          datasource: undefined,
          panels: [
            {
              id: 11,
              title: 'Network In',
              type: 'timeseries',
              datasource: { type: 'prometheus', uid: 'prom-1' }
            },
            {
              id: 12,
              title: 'Disk IO',
              type: 'timeseries',
              datasource: { type: 'prometheus', uid: 'prom-1' }
            }
          ]
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain('fieldConfig');
    expect(JSON.stringify(result)).not.toContain('gridPos');
  });

  it('targets strips UI chrome but keeps expr + datasource, including nested row panels', () => {
    const result = projectDashboard(sampleDashboard(), { fields: 'targets' });
    const panels = result.model.panels as Array<Record<string, unknown>>;

    expect(panels[0]).toEqual({
      id: 1,
      title: 'CPU Usage',
      type: 'timeseries',
      datasource: { type: 'prometheus', uid: 'prom-1' },
      targets: [{ refId: 'A', expr: 'rate(cpu[5m])', datasource: { type: 'prometheus', uid: 'prom-1' } }]
    });
    expect(panels[0]).not.toHaveProperty('fieldConfig');
    expect(panels[0]).not.toHaveProperty('options');
    expect(panels[0]).not.toHaveProperty('gridPos');

    const row = panels[2] as { panels: Array<Record<string, unknown>> };
    expect(row.panels[0]).toMatchObject({
      id: 11,
      title: 'Network In',
      targets: [{ expr: 'rate(net_in[5m])' }]
    });
    expect(row.panels[0]).not.toHaveProperty('transformations');
  });

  it('filters by panelIds across nested row panels', () => {
    const result = projectDashboard(sampleDashboard(), { fields: 'targets', panelIds: [11, 2] });
    const panels = result.model.panels as Array<Record<string, unknown>>;

    expect(panels.map((p) => p.id)).toEqual([2, 10]);
    const row = panels[1] as { panels: Array<{ id: number }> };
    expect(row.panels.map((p) => p.id)).toEqual([11]);
  });

  it('filters by titleContains case-insensitively', () => {
    const result = projectDashboard(sampleDashboard(), { fields: 'summary', titleContains: 'cpu' });
    const panels = result.model.panels as Array<{ title: string }>;
    expect(panels).toEqual([
      {
        id: 1,
        title: 'CPU Usage',
        type: 'timeseries',
        datasource: { type: 'prometheus', uid: 'prom-1' }
      }
    ]);
  });

  it('targets + titleContains is substantially smaller than full', () => {
    const dashboard = sampleDashboard();
    const fullSize = JSON.stringify(projectDashboard(dashboard, { fields: 'full' })).length;
    const projectedSize = JSON.stringify(
      projectDashboard(dashboard, { fields: 'targets', titleContains: 'cpu' })
    ).length;

    expect(projectedSize).toBeLessThan(fullSize / 2);
    expect(projectedSize).toBeLessThan(800);
  });
});
