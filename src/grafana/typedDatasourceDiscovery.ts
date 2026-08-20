export const DISCOVERY_LIST_MAX = 200;

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
  if (regex !== undefined) {
    const pattern = new RegExp(regex);
    values = values.filter((entry) => pattern.test(entry));
  }
  if (values.length > DISCOVERY_LIST_MAX) {
    return { values: values.slice(0, DISCOVERY_LIST_MAX), truncated: true };
  }
  return { values };
}
