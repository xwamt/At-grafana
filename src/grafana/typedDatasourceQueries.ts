export type TypedQueryType = 'instant' | 'range';

export interface PrometheusProxyInput {
  expr: string;
  queryType: TypedQueryType;
  start?: string;
  end?: string;
  step?: string;
  time?: string;
}

export interface LokiProxyInput {
  expr: string;
  queryType: TypedQueryType;
  start?: string;
  end?: string;
  time?: string;
  limit?: number;
  direction?: 'forward' | 'backward';
}

export interface DatasourceProxyCall {
  method: 'GET';
  path: string;
  query: Record<string, string>;
}

export function buildPrometheusProxyCall(input: PrometheusProxyInput): DatasourceProxyCall {
  if (input.queryType === 'instant') {
    const query: Record<string, string> = { query: input.expr };
    if (input.time !== undefined) {
      query.time = input.time;
    }
    return { method: 'GET', path: 'api/v1/query', query };
  }
  const query: Record<string, string> = { query: input.expr };
  if (input.start !== undefined) {
    query.start = input.start;
  }
  if (input.end !== undefined) {
    query.end = input.end;
  }
  if (input.step !== undefined) {
    query.step = input.step;
  }
  return { method: 'GET', path: 'api/v1/query_range', query };
}

export function buildLokiProxyCall(input: LokiProxyInput): DatasourceProxyCall {
  if (input.queryType === 'instant') {
    const query: Record<string, string> = { query: input.expr };
    if (input.time !== undefined) {
      query.time = input.time;
    }
    // Loki's instant endpoint accepts limit/direction too (they bound a
    // log-selector instant query exactly like the range one) — dropping them
    // here silently un-limited instant queries (FUNC-07).
    if (input.limit !== undefined) {
      query.limit = String(input.limit);
    }
    if (input.direction !== undefined) {
      query.direction = input.direction;
    }
    return { method: 'GET', path: 'loki/api/v1/query', query };
  }
  const query: Record<string, string> = { query: input.expr };
  if (input.start !== undefined) {
    query.start = input.start;
  }
  if (input.end !== undefined) {
    query.end = input.end;
  }
  if (input.limit !== undefined) {
    query.limit = String(input.limit);
  }
  if (input.direction !== undefined) {
    query.direction = input.direction;
  }
  return { method: 'GET', path: 'loki/api/v1/query_range', query };
}
