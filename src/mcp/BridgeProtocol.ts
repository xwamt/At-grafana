import type { HostApp } from '@at-series/mcp-hub';
import { AT_SERIES_PROTOCOL_VERSION, AT_SERIES_TOKEN_HEADER, BRIDGE_HOST, BRIDGE_MAX_BODY_BYTES } from '@at-series/mcp-hub';

export { AT_SERIES_PROTOCOL_VERSION, AT_SERIES_TOKEN_HEADER, BRIDGE_HOST, BRIDGE_MAX_BODY_BYTES };

export const AT_GRAFANA_PLUGIN_DISPLAY_NAME = 'AT Grafana';

export interface BridgeErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type { HostApp };
