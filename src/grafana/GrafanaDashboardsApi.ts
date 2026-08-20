import { asRedactedLog, type AtGrafanaLog } from '../utils/logger';
import { GrafanaApiError, type GrafanaHttpClient } from './GrafanaHttpClient';
import { isRecord, readUidOrLegacyId } from './jsonGuards';

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
  /** Full dashboard JSON model (panels, targets, datasource refs) — see requirements S5/MGT3.
   *  May be projected by `grafana_get_dashboard` (`fields=summary|targets`). */
  model: Record<string, unknown>;
  folderUid?: string;
  folderTitle?: string;
  version?: number;
  url?: string;
}

export interface GrafanaDashboardSearchQuery {
  query?: string;
  type?: 'dash-db' | 'dash-folder';
  /** Single Grafana search `tag` parameter. */
  tag?: string;
  /** Mapped to Grafana `/api/search` `folderUIDs`. */
  folderUid?: string;
}

/**
 * Rows requested per page by the `*All` listings below. Grafana's
 * `/api/search` caps `limit` at 5000 and defaults it to 1000; `/api/folders`
 * defaults to 1000 as well. Matching that default keeps the common case at a
 * single round trip -- an instance under 1000 dashboards pages exactly once,
 * the same request count as before pagination existed.
 */
export const DASHBOARD_LISTING_PAGE_SIZE = 1000;

/**
 * Hard ceiling on the rows one paginated listing will accumulate.
 *
 * This is a runaway guardrail, not a statement that 10,000 dashboards are
 * supported: it exists so a pager that keeps claiming another full page
 * cannot walk forever, and so the extension host cannot be made to buffer an
 * unbounded list by a malformed upstream. Hitting it is logged at `warn`
 * precisely because the failure this whole change removes -- a listing that
 * silently comes back short -- must not be reintroduced in a new place.
 */
export const MAX_LISTED_DASHBOARDS = 10_000;

export interface GrafanaListingPageOptions {
  pageSize?: number;
  maxResults?: number;
}

export class GrafanaDashboardsApi {
  private readonly log: AtGrafanaLog;

  constructor(
    private readonly http: GrafanaHttpClient,
    log?: AtGrafanaLog
  ) {
    this.log = asRedactedLog(log);
  }

  /**
   * One page of `/api/search`, exactly as Grafana returns it.
   *
   * Deliberately left unpaged. This is the method the Agent-facing
   * `grafana_list_dashboards` tool reaches (via `GrafanaAgentToolService`),
   * so the number of rows one tool call can put into a model's context stays
   * bounded by Grafana's own `/api/search` default. Completeness is the tree
   * view's requirement, and it has its own method -- see `searchAll`.
   */
  async search(query: GrafanaDashboardSearchQuery = {}): Promise<GrafanaSearchResult[]> {
    const raw = await this.http.requestJson<unknown>('GET', '/api/search', {
      query: {
        query: query.query,
        type: query.type,
        tag: query.tag,
        folderUIDs: query.folderUid
      }
    });
    if (!Array.isArray(raw)) {
      throw new GrafanaApiError('invalid-response', 'Grafana /api/search did not return an array.');
    }
    return raw.map(toSearchResult);
  }

  /**
   * Every dashboard `/api/search` will hand over, for the tree view.
   *
   * `/api/search` truncates at its `limit` (1000 by default) and says nothing
   * about having done so -- no total, no next-page cursor, no flag -- so a
   * large instance renders a tree that is quietly missing dashboards. Walking
   * `page` until the walk ends is the only way to tell "that's all of them"
   * from "that's the first 1000."
   *
   * Three independent stopping conditions, because the only thing that can
   * be assumed about the far side is that it answers:
   *
   * 1. **A short page.** Fewer rows than asked for is the sole end-of-results
   *    signal this API offers, so it is the primary one.
   * 2. **The total guardrail.** A pager that always returns a full page (a
   *    proxy that pins `page=1`, a broken plugin) would otherwise never
   *    produce a short page.
   * 3. **A page that adds nothing new.** The interesting shape of (2) is an
   *    upstream that ignores `page` entirely: every page is full *and*
   *    identical. Stopping only at the guardrail would still "succeed," just
   *    with the first page repeated ten times and a duplicated tree to show
   *    for it. Deduplicating by uid catches that on the second request, and
   *    incidentally absorbs the rows a result set shifting under a live
   *    paginator hands back twice.
   */
  async searchAll(
    query: GrafanaDashboardSearchQuery = {},
    options: GrafanaListingPageOptions = {}
  ): Promise<GrafanaSearchResult[]> {
    return this.collectPages(
      '/api/search',
      { query: query.query, type: query.type, tag: query.tag, folderUIDs: query.folderUid },
      options,
      (raw) => {
        if (!Array.isArray(raw)) {
          throw new GrafanaApiError('invalid-response', 'Grafana /api/search did not return an array.');
        }
        return raw.map(toSearchResult);
      }
    );
  }

  /** One page of `/api/folders`; the Agent-facing counterpart of `search`. See its doc for why this stays unpaged. */
  async getFolders(): Promise<GrafanaFolder[]> {
    const raw = await this.http.requestJson<unknown>('GET', '/api/folders');
    if (!Array.isArray(raw)) {
      throw new GrafanaApiError('invalid-response', 'Grafana /api/folders did not return an array.');
    }
    return raw.map(toFolder);
  }

  /** Every folder, for the tree view. Same truncation problem and same three stopping conditions as `searchAll`. */
  async getAllFolders(options: GrafanaListingPageOptions = {}): Promise<GrafanaFolder[]> {
    return this.collectPages('/api/folders', {}, options, (raw) => {
      if (!Array.isArray(raw)) {
        throw new GrafanaApiError('invalid-response', 'Grafana /api/folders did not return an array.');
      }
      return raw.map(toFolder);
    });
  }

  async getDashboardByUid(uid: string): Promise<GrafanaDashboard> {
    const raw = await this.http.requestJson<unknown>('GET', `/api/dashboards/uid/${encodeURIComponent(uid)}`);
    return toDashboard(raw);
  }

  private async collectPages<T extends { uid: string }>(
    path: string,
    baseQuery: Record<string, string | undefined>,
    options: GrafanaListingPageOptions,
    parsePage: (raw: unknown) => T[]
  ): Promise<T[]> {
    const pageSize = Math.max(1, Math.floor(options.pageSize ?? DASHBOARD_LISTING_PAGE_SIZE));
    const maxResults = Math.max(1, Math.floor(options.maxResults ?? MAX_LISTED_DASHBOARDS));

    const collected: T[] = [];
    const seenUids = new Set<string>();
    let page = 1;
    let pages = 0;
    let truncated = false;

    for (;;) {
      const raw = await this.http.requestJson<unknown>('GET', path, {
        query: { ...baseQuery, page: String(page), limit: String(pageSize) }
      });
      const entries = parsePage(raw);
      pages++;

      let added = 0;
      let droppedAtCap = false;
      for (const entry of entries) {
        if (collected.length >= maxResults) {
          droppedAtCap = true;
          break;
        }
        if (seenUids.has(entry.uid)) {
          continue;
        }
        seenUids.add(entry.uid);
        collected.push(entry);
        added++;
      }

      // A page shorter than requested is this API's only end-of-results
      // signal, so a full page is the only state from which continuing is
      // justified -- and the only state in which stopping at the cap means
      // rows may have been left behind.
      const pageWasFull = entries.length >= pageSize;
      if (droppedAtCap || (pageWasFull && collected.length >= maxResults)) {
        truncated = true;
        break;
      }
      if (added === 0 || !pageWasFull) {
        break;
      }
      page++;
    }

    if (truncated) {
      this.log.warn(
        `grafana-api: ${path} stopped at the ${maxResults}-row guardrail after ${pages} page(s); ` +
          'rows beyond it were not fetched.'
      );
    } else {
      this.log.debug(`grafana-api: ${path} listed ${collected.length} row(s) across ${pages} page(s)`);
    }
    return collected;
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
    folderUid: readUidOrLegacyId(entry.folderUid, entry.folderId),
    folderTitle: typeof entry.folderTitle === 'string' ? entry.folderTitle : undefined,
    url: typeof entry.url === 'string' ? entry.url : undefined
  };
}

function toFolder(entry: unknown): GrafanaFolder {
  // The `id` fallback has to move in lockstep with `toSearchResult`'s: if
  // dashboards were keyed by a legacy numeric folderId while folders were
  // still keyed by uid, nothing would match and every dashboard in a folder
  // would disappear from the tree instead of merely losing its grouping.
  const uid = isRecord(entry) ? readUidOrLegacyId(entry.uid, entry.id) : undefined;
  if (!isRecord(entry) || uid === undefined || typeof entry.title !== 'string') {
    throw new GrafanaApiError('invalid-response', 'Grafana /api/folders returned a malformed entry.');
  }
  return {
    uid,
    title: entry.title,
    parentUid: readUidOrLegacyId(entry.parentUid, entry.parentId)
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
