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

const DATASOURCE_PROXY_PREFIX = '/api/datasources/proxy/uid';

/**
 * Spellings of a path separator or parent-directory reference that must never
 * appear in an Agent-supplied datasource path.
 *
 * `..` and `\` are the two forms `new URL(...)` itself will normalize (see
 * `GrafanaHttpClient.buildUrl`), which is what turns "read from a datasource"
 * into "reach any endpoint the Service Account Token can reach". The
 * percent-encoded forms survive our URL layer untouched but are decoded by
 * Grafana's own router on the far side, so they have to be rejected here
 * rather than left to `buildDatasourceProxyPath`'s post-join check.
 *
 * Written without the `i` flag so `.source` can be embedded verbatim in the
 * JSON Schema twin's `pattern` (see bridgeSchemas.ts), which carries no flags.
 */
export const DATASOURCE_PROXY_PATH_DENY_PATTERN = /\.\.|\\|%2[eEfF]|%5[cC]/;

/**
 * Joins a datasource uid and a caller-supplied path into a Grafana datasource
 * proxy path, refusing to return one that no longer resolves inside this
 * datasource's own subtree.
 *
 * The normalization here deliberately mirrors what `GrafanaHttpClient.buildUrl`
 * will do to the same string moments later, so the check is made against the
 * path Grafana actually receives rather than the pre-normalized one. This is
 * the belt-and-braces layer -- the same shape as `buildTargetUrl`'s
 * protocol/host assertion in GrafanaEmbedProxy -- and stays correct even for a
 * caller that reaches it without `proxyDatasourceRequest`'s input rejection.
 */
export function buildDatasourceProxyPath(datasourceUid: string, path: string): string {
  const requiredPrefix = `${DATASOURCE_PROXY_PREFIX}/${encodeURIComponent(datasourceUid)}/`;
  const trimmedPath = path.startsWith('/') ? path.slice(1) : path;
  const proxyPath = `${requiredPrefix}${trimmedPath}`;

  let normalizedPathname: string;
  try {
    normalizedPathname = new URL(proxyPath.slice(1), 'http://datasource-proxy.invalid/').pathname;
  } catch {
    throw new GrafanaApiError('validation', `Datasource proxy path is not a valid URL path: ${path}`);
  }
  if (!normalizedPathname.startsWith(requiredPrefix)) {
    throw new GrafanaApiError(
      'validation',
      `Datasource proxy path resolved outside this datasource's proxy prefix (${requiredPrefix}): ${path}`
    );
  }
  return proxyPath;
}

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
   *
   * `path` gets the same treatment for the same reason, and it matters more:
   * the caller is an Agent whose input may be attacker-authored (a poisoned
   * dashboard description, a prompt-injected log line). Left unconstrained it
   * escapes the datasource subtree entirely -- `POST ../../../api/auth/keys`
   * mints a long-lived admin API key under the Service Account Token.
   */
  async proxyDatasourceRequest(
    datasourceUid: string,
    method: 'GET' | 'POST',
    path: string,
    query?: Record<string, string>,
    body?: unknown,
    /** Task 6.1: threaded straight through to GrafanaHttpClient's early-abort; see GrafanaRequestOptions.maxResponseBytes. */
    maxResponseBytes?: number
  ): Promise<unknown> {
    if (!ALLOWED_PROXY_METHODS.has(method)) {
      throw new GrafanaApiError('validation', `Datasource proxy method must be GET or POST, got: ${String(method)}.`);
    }
    if (DATASOURCE_PROXY_PATH_DENY_PATTERN.test(path)) {
      throw new GrafanaApiError(
        'validation',
        'Datasource proxy path must stay inside the datasource subtree: "..", "\\", and percent-encoded ' +
          `separators (%2e/%2f/%5c) are rejected. Got: ${path}`
      );
    }
    const proxyPath = buildDatasourceProxyPath(datasourceUid, path);
    return this.http.requestJson<unknown>(method, proxyPath, { query, body, maxResponseBytes });
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
