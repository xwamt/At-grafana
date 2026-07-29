import { GrafanaApiError, type GrafanaHttpClient } from './GrafanaHttpClient';
import { isRecord } from './jsonGuards';

export interface GrafanaSearchResult {
  uid: string;
  title: string;
  type: string;
  tags?: string[];
  folderUid?: string;
  folderTitle?: string;
  url?: string;
}

export interface GrafanaFolder {
  uid: string;
  title: string;
  parentUid?: string;
}

export interface GrafanaDashboard {
  uid: string;
  title: string;
  /** Full dashboard JSON model (panels, targets, datasource refs) — see requirements S5/MGT3. */
  model: Record<string, unknown>;
  folderUid?: string;
  folderTitle?: string;
  version?: number;
  url?: string;
}

export interface GrafanaDashboardSearchQuery {
  query?: string;
  type?: 'dash-db' | 'dash-folder';
}

export class GrafanaDashboardsApi {
  constructor(private readonly http: GrafanaHttpClient) {}

  async search(query: GrafanaDashboardSearchQuery = {}): Promise<GrafanaSearchResult[]> {
    const raw = await this.http.requestJson<unknown>('GET', '/api/search', {
      query: { query: query.query, type: query.type }
    });
    if (!Array.isArray(raw)) {
      throw new GrafanaApiError('invalid-response', 'Grafana /api/search did not return an array.');
    }
    return raw.map(toSearchResult);
  }

  async getFolders(): Promise<GrafanaFolder[]> {
    const raw = await this.http.requestJson<unknown>('GET', '/api/folders');
    if (!Array.isArray(raw)) {
      throw new GrafanaApiError('invalid-response', 'Grafana /api/folders did not return an array.');
    }
    return raw.map(toFolder);
  }

  async getDashboardByUid(uid: string): Promise<GrafanaDashboard> {
    const raw = await this.http.requestJson<unknown>('GET', `/api/dashboards/uid/${encodeURIComponent(uid)}`);
    return toDashboard(raw);
  }
}

function toSearchResult(entry: unknown): GrafanaSearchResult {
  if (!isRecord(entry) || typeof entry.uid !== 'string' || typeof entry.title !== 'string') {
    throw new GrafanaApiError('invalid-response', 'Grafana /api/search returned a malformed entry.');
  }
  return {
    uid: entry.uid,
    title: entry.title,
    type: typeof entry.type === 'string' ? entry.type : 'dash-db',
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
    folderUid: typeof entry.folderUid === 'string' ? entry.folderUid : undefined,
    folderTitle: typeof entry.folderTitle === 'string' ? entry.folderTitle : undefined,
    url: typeof entry.url === 'string' ? entry.url : undefined
  };
}

function toFolder(entry: unknown): GrafanaFolder {
  if (!isRecord(entry) || typeof entry.uid !== 'string' || typeof entry.title !== 'string') {
    throw new GrafanaApiError('invalid-response', 'Grafana /api/folders returned a malformed entry.');
  }
  return {
    uid: entry.uid,
    title: entry.title,
    parentUid: typeof entry.parentUid === 'string' ? entry.parentUid : undefined
  };
}

function toDashboard(raw: unknown): GrafanaDashboard {
  if (!isRecord(raw) || !isRecord(raw.dashboard)) {
    throw new GrafanaApiError('invalid-response', 'Grafana /api/dashboards/uid/:uid returned an unexpected shape.');
  }
  const dashboard = raw.dashboard;
  const meta = isRecord(raw.meta) ? raw.meta : {};
  if (typeof dashboard.uid !== 'string' || typeof dashboard.title !== 'string') {
    throw new GrafanaApiError('invalid-response', 'Grafana dashboard model is missing uid/title.');
  }
  return {
    uid: dashboard.uid,
    title: dashboard.title,
    model: dashboard,
    folderUid: typeof meta.folderUid === 'string' ? meta.folderUid : undefined,
    folderTitle: typeof meta.folderTitle === 'string' ? meta.folderTitle : undefined,
    version: typeof dashboard.version === 'number' ? dashboard.version : undefined,
    url: typeof meta.url === 'string' ? meta.url : undefined
  };
}
