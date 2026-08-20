import type { GrafanaDashboard } from '../grafana/GrafanaDashboardsApi';
import { isRecord } from '../grafana/jsonGuards';

export type DashboardFieldsMode = 'full' | 'summary' | 'targets';

export interface ProjectDashboardOptions {
  fields?: DashboardFieldsMode;
  panelIds?: number[];
  titleContains?: string;
}

/**
 * Projects a full Grafana dashboard (already fetched) before returning it from
 * `grafana_get_dashboard`. Default `fields: "targets"` (ADR-006).
 */
export function projectDashboard(
  dashboard: GrafanaDashboard,
  options: ProjectDashboardOptions = {}
): GrafanaDashboard {
  const fields = options.fields ?? 'targets';
  if (fields === 'full') {
    return dashboard;
  }

  const rawPanels = Array.isArray(dashboard.model.panels) ? dashboard.model.panels : [];
  const filtered = filterPanels(rawPanels, options);
  const projectedPanels =
    fields === 'summary' ? filtered.map(projectPanelSummary) : filtered.map(projectPanelTargets);

  return {
    ...dashboard,
    model: {
      uid: typeof dashboard.model.uid === 'string' ? dashboard.model.uid : dashboard.uid,
      title: typeof dashboard.model.title === 'string' ? dashboard.model.title : dashboard.title,
      time: dashboard.model.time,
      panels: projectedPanels
    }
  };
}

function filterPanels(panels: unknown[], options: ProjectDashboardOptions): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const entry of panels) {
    if (!isRecord(entry)) {
      continue;
    }
    const nestedRaw = Array.isArray(entry.panels) ? entry.panels : undefined;
    const nestedFiltered = nestedRaw ? filterPanels(nestedRaw, options) : undefined;
    const selfMatches = panelMatches(entry, options);

    if (nestedRaw) {
      if (selfMatches || (nestedFiltered && nestedFiltered.length > 0)) {
        result.push({
          ...entry,
          panels: nestedFiltered ?? []
        });
      }
      continue;
    }

    if (selfMatches) {
      result.push(entry);
    }
  }
  return result;
}

function panelMatches(panel: Record<string, unknown>, options: ProjectDashboardOptions): boolean {
  if (options.panelIds && options.panelIds.length > 0) {
    if (typeof panel.id !== 'number' || !options.panelIds.includes(panel.id)) {
      return false;
    }
  }
  if (options.titleContains && options.titleContains.length > 0) {
    const title = typeof panel.title === 'string' ? panel.title : '';
    if (!title.toLowerCase().includes(options.titleContains.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function projectPanelSummary(panel: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    id: panel.id,
    title: panel.title,
    type: panel.type,
    datasource: panel.datasource
  };
  if (Array.isArray(panel.panels)) {
    projected.panels = (panel.panels as unknown[])
      .filter(isRecord)
      .map(projectPanelSummary);
  }
  return projected;
}

function projectPanelTargets(panel: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    id: panel.id,
    title: panel.title,
    type: panel.type,
    datasource: panel.datasource
  };
  if (Array.isArray(panel.targets)) {
    projected.targets = panel.targets.filter(isRecord).map(projectTarget);
  }
  if (Array.isArray(panel.panels)) {
    projected.panels = (panel.panels as unknown[])
      .filter(isRecord)
      .map(projectPanelTargets);
  }
  return projected;
}

function projectTarget(target: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  if ('refId' in target) {
    projected.refId = target.refId;
  }
  if ('expr' in target) {
    projected.expr = target.expr;
  }
  if ('datasource' in target) {
    projected.datasource = target.datasource;
  }
  // Keep common query-shaped fields used by non-Prom datasources (e.g. Loki).
  if ('query' in target) {
    projected.query = target.query;
  }
  return projected;
}
