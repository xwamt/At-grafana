import { GrafanaApiError, type GrafanaHttpClient } from './GrafanaHttpClient';
import { isRecord } from './jsonGuards';

export interface GrafanaAnnotation {
  id: number;
  time: number;
  timeEnd?: number;
  text: string;
  tags: string[];
  dashboardUID?: string;
  panelId?: number;
}

export interface GrafanaAnnotationQuery {
  from?: number;
  to?: number;
  dashboardUid?: string;
  tag?: string;
  limit?: number;
}

export class GrafanaAnnotationsApi {
  constructor(private readonly http: GrafanaHttpClient) {}

  async list(query: GrafanaAnnotationQuery = {}): Promise<GrafanaAnnotation[]> {
    const limit = query.limit ?? 100;
    const raw = await this.http.requestJson<unknown>('GET', '/api/annotations', {
      query: {
        from: query.from !== undefined ? String(query.from) : undefined,
        to: query.to !== undefined ? String(query.to) : undefined,
        dashboardUID: query.dashboardUid,
        tags: query.tag,
        limit: String(limit)
      }
    });
    if (!Array.isArray(raw)) {
      throw new GrafanaApiError('invalid-response', 'Grafana /api/annotations did not return an array.');
    }
    return raw.map(toAnnotation);
  }
}

function toAnnotation(entry: unknown): GrafanaAnnotation {
  if (!isRecord(entry) || typeof entry.id !== 'number' || typeof entry.time !== 'number' || typeof entry.text !== 'string') {
    throw new GrafanaApiError('invalid-response', 'Grafana /api/annotations returned a malformed entry.');
  }
  return {
    id: entry.id,
    time: entry.time,
    timeEnd: typeof entry.timeEnd === 'number' ? entry.timeEnd : undefined,
    text: entry.text,
    tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    dashboardUID: typeof entry.dashboardUID === 'string' ? entry.dashboardUID : undefined,
    panelId: typeof entry.panelId === 'number' ? entry.panelId : undefined
  };
}
