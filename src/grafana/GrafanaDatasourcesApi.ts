import { GrafanaApiError, type GrafanaHttpClient } from './GrafanaHttpClient';
import { isRecord } from './jsonGuards';

export interface GrafanaDatasource {
  uid: string;
  name: string;
  type: string;
  url?: string;
  isDefault?: boolean;
}

const ALLOWED_PROXY_METHODS = new Set(['GET', 'POST']);

export class GrafanaDatasourcesApi {
  constructor(private readonly http: GrafanaHttpClient) {}

  async listDatasources(): Promise<GrafanaDatasource[]> {
    const raw = await this.http.requestJson<unknown>('GET', '/api/datasources');
    if (!Array.isArray(raw)) {
      throw new GrafanaApiError('invalid-response', 'Grafana /api/datasources did not return an array.');
    }
    return raw.map(toDatasource);
  }

  /**
   * Generic pass-through per D8/ADR-004 (`/api/datasources/proxy/uid/:uid/:path`).
   * The GET/POST allowlist (MON4) is a hard security requirement, not just a
   * TypeScript constraint: validate at runtime and reject synchronously
   * BEFORE touching the network, since a caller upstream of this class
   * (e.g. a Zod-parsed Bridge tool argument) could pass a value that
   * bypasses the `'GET' | 'POST'` type at compile time.
   */
  async proxyDatasourceRequest(
    datasourceUid: string,
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, string>,
    body?: unknown
  ): Promise<unknown> {
    if (!ALLOWED_PROXY_METHODS.has(method)) {
      throw new GrafanaApiError('validation', `Datasource proxy method must be GET or POST, got: ${String(method)}.`);
    }
    const trimmedPath = path.startsWith('/') ? path.slice(1) : path;
    const proxyPath = `/api/datasources/proxy/uid/${encodeURIComponent(datasourceUid)}/${trimmedPath}`;
    return this.http.requestJson<unknown>(method, proxyPath, { query, body });
  }
}

function toDatasource(entry: unknown): GrafanaDatasource {
  if (!isRecord(entry) || typeof entry.uid !== 'string' || typeof entry.name !== 'string' || typeof entry.type !== 'string') {
    throw new GrafanaApiError('invalid-response', 'Grafana /api/datasources returned a malformed entry.');
  }
  return {
    uid: entry.uid,
    name: entry.name,
    type: entry.type,
    url: typeof entry.url === 'string' ? entry.url : undefined,
    isDefault: typeof entry.isDefault === 'boolean' ? entry.isDefault : undefined
  };
}
