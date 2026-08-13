import { describe, expect, it } from 'vitest';
import {
  grafanaGetAlertHistorySchema,
  grafanaGetAlertRuleSchema,
  grafanaGetDashboardSchema,
  grafanaListAlertRulesSchema,
  grafanaListDashboardsSchema,
  grafanaListDatasourcesSchema,
  grafanaListFoldersSchema,
  grafanaListInstancesSchema,
  grafanaQueryDatasourceSchema
} from '../../src/mcp/bridgeSchemas';

describe('grafanaListInstancesSchema', () => {
  it('accepts an empty object', () => {
    expect(grafanaListInstancesSchema.safeParse({}).success).toBe(true);
  });

  it('rejects unknown properties', () => {
    expect(grafanaListInstancesSchema.safeParse({ instanceId: 'x' }).success).toBe(false);
  });
});

describe('instanceId-only schemas', () => {
  const schemas = {
    grafanaListDashboardsSchema,
    grafanaListFoldersSchema,
    grafanaListAlertRulesSchema,
    grafanaListDatasourcesSchema
  };

  for (const [name, schema] of Object.entries(schemas)) {
    describe(name, () => {
      it('accepts a valid instanceId', () => {
        expect(schema.safeParse({ instanceId: 'abc' }).success).toBe(true);
      });

      it('rejects a missing instanceId', () => {
        expect(schema.safeParse({}).success).toBe(false);
      });

      it('rejects a non-string instanceId', () => {
        expect(schema.safeParse({ instanceId: 42 }).success).toBe(false);
      });

      it('rejects an empty instanceId', () => {
        expect(schema.safeParse({ instanceId: '' }).success).toBe(false);
      });

      it('rejects unexpected extra properties', () => {
        expect(schema.safeParse({ instanceId: 'abc', extra: true }).success).toBe(false);
      });
    });
  }
});

describe('instanceId + uid schemas', () => {
  const schemas = {
    grafanaGetAlertRuleSchema,
    grafanaGetAlertHistorySchema
  };

  for (const [name, schema] of Object.entries(schemas)) {
    describe(name, () => {
      it('accepts a valid instanceId and uid', () => {
        expect(schema.safeParse({ instanceId: 'abc', uid: 'dash-1' }).success).toBe(true);
      });

      it('rejects a missing instanceId', () => {
        expect(schema.safeParse({ uid: 'dash-1' }).success).toBe(false);
      });

      it('rejects a missing uid', () => {
        expect(schema.safeParse({ instanceId: 'abc' }).success).toBe(false);
      });

      it('rejects a malformed uid', () => {
        expect(schema.safeParse({ instanceId: 'abc', uid: 123 }).success).toBe(false);
      });
    });
  }
});

describe('grafanaGetDashboardSchema', () => {
  it('accepts instanceId and uid alone (fields defaults to full at projection time)', () => {
    expect(grafanaGetDashboardSchema.safeParse({ instanceId: 'abc', uid: 'dash-1' }).success).toBe(true);
  });

  it('accepts fields/panelIds/titleContains', () => {
    expect(
      grafanaGetDashboardSchema.safeParse({
        instanceId: 'abc',
        uid: 'dash-1',
        fields: 'targets',
        panelIds: [1, 2],
        titleContains: 'cpu'
      }).success
    ).toBe(true);
  });

  it('rejects an unknown fields value', () => {
    expect(
      grafanaGetDashboardSchema.safeParse({ instanceId: 'abc', uid: 'dash-1', fields: 'panels' }).success
    ).toBe(false);
  });

  it('rejects unexpected extra properties', () => {
    expect(
      grafanaGetDashboardSchema.safeParse({ instanceId: 'abc', uid: 'dash-1', extra: true }).success
    ).toBe(false);
  });
});

describe('grafanaQueryDatasourceSchema', () => {
  const validBase = { instanceId: 'abc', datasourceUid: 'ds1', method: 'GET', path: 'api/v1/query' };

  it('accepts the minimal required fields', () => {
    expect(grafanaQueryDatasourceSchema.safeParse(validBase).success).toBe(true);
  });

  it('accepts optional query and body', () => {
    expect(
      grafanaQueryDatasourceSchema.safeParse({ ...validBase, query: { query: 'up', step: '15s' }, body: { anything: true } }).success
    ).toBe(true);
  });

  it('accepts method GET and POST', () => {
    expect(grafanaQueryDatasourceSchema.safeParse({ ...validBase, method: 'GET' }).success).toBe(true);
    expect(grafanaQueryDatasourceSchema.safeParse({ ...validBase, method: 'POST' }).success).toBe(true);
  });

  it('rejects any method other than GET/POST (ADR-004 MON4 method allowlist enforced at the schema-validation layer)', () => {
    for (const method of ['PUT', 'DELETE', 'PATCH', 'get', 'post', '']) {
      expect(grafanaQueryDatasourceSchema.safeParse({ ...validBase, method }).success).toBe(false);
    }
  });

  it('rejects missing required fields', () => {
    for (const key of ['instanceId', 'datasourceUid', 'method', 'path'] as const) {
      const { [key]: _omit, ...rest } = validBase;
      expect(grafanaQueryDatasourceSchema.safeParse(rest).success).toBe(false);
    }
  });

  it('rejects a non-string-valued query entry', () => {
    expect(grafanaQueryDatasourceSchema.safeParse({ ...validBase, query: { start: 1700000000 } }).success).toBe(false);
  });

  it('rejects unexpected extra top-level properties', () => {
    expect(grafanaQueryDatasourceSchema.safeParse({ ...validBase, extra: true }).success).toBe(false);
  });

  it('rejects a path that could traverse out of the datasource proxy prefix', () => {
    for (const path of [
      '../../../../../api/auth/keys',
      '/../../../../../api/dashboards/db',
      'api/v1/../../../../api/auth/keys',
      '%2e%2e/%2e%2e/api/auth/keys',
      'api%2f..%2f..%2fapi/auth/keys',
      '..\\..\\..\\api\\auth\\keys'
    ]) {
      expect(grafanaQueryDatasourceSchema.safeParse({ ...validBase, path }).success).toBe(false);
    }
  });

  it('still accepts the realistic Prometheus/Loki query paths this tool exists to serve', () => {
    for (const path of ['api/v1/query_range', '/api/v1/query', 'loki/api/v1/query_range', 'api/v1/labels']) {
      expect(grafanaQueryDatasourceSchema.safeParse({ ...validBase, path }).success).toBe(true);
    }
  });
});
