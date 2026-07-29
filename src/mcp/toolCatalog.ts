import type { ToolCatalogEntry } from '@at-series/mcp-hub';

/**
 * Stable reverse-domain plugin id (AT Series Hub Protocol v1 §4.2).
 * See docs/decisions/ADR-005-at-series-hub-protocol-v1-adoption.md.
 */
export const AT_GRAFANA_PLUGIN_ID = 'at.grafana' as const;

/**
 * Populated across Phase 5 (management tools) and Phase 6 (monitoring data tools).
 * See docs/decisions/ADR-004-mcp-tool-catalog-and-permission-model.md for the full
 * catalog design (all `risk: 'read'`, prefix `grafana_`).
 */
export const AT_GRAFANA_TOOL_CATALOG: ToolCatalogEntry[] = [];
