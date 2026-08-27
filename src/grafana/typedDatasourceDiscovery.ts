export const DISCOVERY_LIST_MAX = 200;

/**
 * Regex guardrails (PERF-12): the `regex` argument arrives verbatim from the
 * Agent, so a pathological pattern must not be able to stall the extension
 * host with catastrophic backtracking over an unbounded label universe.
 * The pattern length is capped well above any legitimate discovery filter,
 * and the candidate list is sliced before filtering so the regex runs
 * against a bounded input. Enforced here (not in the MCP schema) so every
 * caller gets the guard.
 */
export const DISCOVERY_REGEX_MAX_LENGTH = 256;

/**
 * Upper bound on candidates a regex filter may run against. 25x the output
 * cap keeps a sparse filter useful against a large metric universe while
 * bounding the worst-case regex work.
 */
export const DISCOVERY_FILTER_CANDIDATE_MAX = DISCOVERY_LIST_MAX * 25;

export const PROMETHEUS_LABEL_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface DatasourceProxyCall {
  method: 'GET';
  path: string;
  query: Record<string, string>;
}

export interface DiscoveryTimeRange {
  start?: string;
  end?: string;
}

export interface PrometheusLabelValuesInput extends DiscoveryTimeRange {
  label: string;
  matcher?: string;
}

function timeQuery(input: DiscoveryTimeRange): Record<string, string> {
  const query: Record<string, string> = {};
  if (input.start !== undefined) {
    query.start = input.start;
  }
  if (input.end !== undefined) {
    query.end = input.end;
  }
  return query;
}

function assertLabel(label: string): string {
  if (!PROMETHEUS_LABEL_PATTERN.test(label)) {
    throw new Error(`Invalid Prometheus/Loki label: ${label}`);
  }
  return label;
}

export function buildPrometheusMetricNamesCall(input: DiscoveryTimeRange): DatasourceProxyCall {
  return { method: 'GET', path: 'api/v1/label/__name__/values', query: timeQuery(input) };
}

export function buildPrometheusLabelValuesCall(input: PrometheusLabelValuesInput): DatasourceProxyCall {
  const label = assertLabel(input.label);
  const query = timeQuery(input);
  if (input.matcher !== undefined) {
    query['match[]'] = input.matcher;
  }
  return { method: 'GET', path: `api/v1/label/${label}/values`, query };
}

export function buildLokiLabelNamesCall(input: DiscoveryTimeRange): DatasourceProxyCall {
  return { method: 'GET', path: 'loki/api/v1/labels', query: timeQuery(input) };
}

export function buildLokiLabelValuesCall(input: { label: string } & DiscoveryTimeRange): DatasourceProxyCall {
  const label = assertLabel(input.label);
  return { method: 'GET', path: `loki/api/v1/label/${label}/values`, query: timeQuery(input) };
}

export function projectDiscoveryValues(raw: unknown, regex?: string): { values: string[]; truncated?: true } {
  const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const data = record?.data;
  if (!Array.isArray(data) || data.some((entry) => typeof entry !== 'string')) {
    throw new Error('Datasource label API did not return data: string[].');
  }
  let values = data as string[];
  let truncated = false;
  if (regex !== undefined) {
    if (regex.length > DISCOVERY_REGEX_MAX_LENGTH) {
      throw new Error(`Invalid discovery regex: exceeds the maximum length of ${DISCOVERY_REGEX_MAX_LENGTH} characters.`);
    }
    let pattern: RegExp;
    try {
      pattern = new RegExp(regex);
    } catch (error) {
      throw new Error(`Invalid discovery regex: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (values.length > DISCOVERY_FILTER_CANDIDATE_MAX) {
      // Candidates beyond the cap are never examined, so the result may be
      // missing matches -- surface that the same way the output cap does.
      values = values.slice(0, DISCOVERY_FILTER_CANDIDATE_MAX);
      truncated = true;
    }
    values = values.filter((entry) => pattern.test(entry));
  }
  if (values.length > DISCOVERY_LIST_MAX) {
    return { values: values.slice(0, DISCOVERY_LIST_MAX), truncated: true };
  }
  return truncated ? { values, truncated: true } : { values };
}
