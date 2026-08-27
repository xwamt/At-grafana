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
 *
 * `panelIds`/`titleContains` apply in every mode, including `full`
 * (FUNC-06): a caller that passed a filter expects it honored, and silently
 * returning every panel would defeat the point of filtering. `full` with no
 * filters still returns the exact same object it was given.
 */
export function projectDashboard(
  dashboard: GrafanaDashboard,
  options: ProjectDashboardOptions = {}
): GrafanaDashboard {
  const fields = options.fields ?? 'targets';
  const rawPanels = Array.isArray(dashboard.model.panels) ? dashboard.model.panels : [];

  if (fields === 'full') {
    if (!hasPanelFilters(options)) {
      return dashboard;
    }
    return {
      ...dashboard,
      model: { ...dashboard.model, panels: filterPanels(rawPanels, options) }
    };
  }

  const filtered = filterPanels(rawPanels, options);
  const projectedPanels =
    fields === 'summary' ? filtered.map(projectPanelSummary) : filtered.map(projectPanelTargets);

  const model: Record<string, unknown> = {
    uid: typeof dashboard.model.uid === 'string' ? dashboard.model.uid : dashboard.uid,
    title: typeof dashboard.model.title === 'string' ? dashboard.model.title : dashboard.title,
    time: dashboard.model.time,
    panels: projectedPanels
  };
  // FUNC-16: keep template variables on the projection — a target's
  // `expr` routinely references `$job`-style variables, and without
  // `templating.list` the agent would have to re-fetch `fields: "full"`
  // just to resolve them, defeating the projection's purpose.
  const templating = projectTemplating(dashboard.model.templating);
  if (templating) {
    model.templating = templating;
  }

  return { ...dashboard, model };
}

function hasPanelFilters(options: ProjectDashboardOptions): boolean {
  return (
    (options.panelIds !== undefined && options.panelIds.length > 0) ||
    (options.titleContains !== undefined && options.titleContains.length > 0)
  );
}

/** Slim `templating` projection: name/type/query/current (+label) per variable — enough to resolve `$var` references in a target expr. */
function projectTemplating(templating: unknown): { list: Record<string, unknown>[] } | undefined {
  if (!isRecord(templating) || !Array.isArray(templating.list)) {
    return undefined;
  }
  const list = templating.list.filter(isRecord).map((variable) => {
    const projected: Record<string, unknown> = {};
    for (const key of ['name', 'type', 'query', 'current', 'label'] as const) {
      if (key in variable) {
        projected[key] = variable[key];
      }
    }
    return projected;
  });
  return { list };
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
