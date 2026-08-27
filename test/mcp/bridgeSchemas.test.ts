import { describe, expect, it } from 'vitest';
import {
  grafanaGetAlertHistorySchema,
  grafanaGetAlertRuleSchema,
  grafanaGetDashboardSchema,
  grafanaListAlertRulesSchema,
  grafanaListDashboardsSchema,
  grafanaListDatasourcesSchema,
  grafanaListAnnotationsSchema,
  grafanaListFoldersSchema,
  grafanaListInstancesSchema,
  grafanaQueryDatasourceSchema,
  grafanaQueryLokiSchema,
  grafanaQueryPrometheusSchema,
  grafanaListPrometheusMetricNamesSchema,
  grafanaListPrometheusLabelValuesSchema,
  grafanaListLokiLabelNamesSchema,
  grafanaListLokiLabelValuesSchema,
  grafanaGenerateDeeplinkSchema
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
    grafanaListFoldersSchema,
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

describe('grafanaListAlertRulesSchema', () => {
  it('accepts instanceId alone', () => {
    expect(grafanaListAlertRulesSchema.safeParse({ instanceId: 'abc' }).success).toBe(true);
  });

  it('accepts a non-empty states array', () => {
    expect(
      grafanaListAlertRulesSchema.safeParse({ instanceId: 'abc', states: ['firing', 'pending'] }).success
    ).toBe(true);
  });

  it('rejects an empty states array and unknown members', () => {
    expect(grafanaListAlertRulesSchema.safeParse({ instanceId: 'abc', states: [] }).success).toBe(false);
    expect(grafanaListAlertRulesSchema.safeParse({ instanceId: 'abc', states: ['silenced'] }).success).toBe(false);
  });
});

describe('grafanaListDashboardsSchema', () => {
  it('accepts instanceId alone', () => {
    expect(grafanaListDashboardsSchema.safeParse({ instanceId: 'abc' }).success).toBe(true);
  });

  it('accepts optional query, tag, and folderUid', () => {
    expect(
      grafanaListDashboardsSchema.safeParse({
        instanceId: 'abc',
        query: 'cpu',
        tag: 'infra',
        folderUid: 'folder-1'
      }).success
    ).toBe(true);
  });

  it('rejects empty optional strings', () => {
    expect(grafanaListDashboardsSchema.safeParse({ instanceId: 'abc', query: '' }).success).toBe(false);
    expect(grafanaListDashboardsSchema.safeParse({ instanceId: 'abc', tag: '' }).success).toBe(false);
    expect(grafanaListDashboardsSchema.safeParse({ instanceId: 'abc', folderUid: '' }).success).toBe(false);
  });

  it('rejects unexpected extra properties', () => {
    expect(grafanaListDashboardsSchema.safeParse({ instanceId: 'abc', extra: true }).success).toBe(false);
  });

  it('rejects a missing instanceId', () => {
    expect(grafanaListDashboardsSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-string instanceId', () => {
    expect(grafanaListDashboardsSchema.safeParse({ instanceId: 42 }).success).toBe(false);
  });

  it('rejects an empty instanceId', () => {
    expect(grafanaListDashboardsSchema.safeParse({ instanceId: '' }).success).toBe(false);
  });
});

describe('grafanaGetAlertHistorySchema window parameters', () => {
  it('accepts optional from/to (epoch seconds) and limit', () => {
    expect(
      grafanaGetAlertHistorySchema.safeParse({
        instanceId: 'abc',
        uid: 'r1',
        from: 1700000000,
        to: 1700003600,
        limit: 250
      }).success
    ).toBe(true);
  });

  it('rejects a limit of 0 and a limit above 1000', () => {
    expect(grafanaGetAlertHistorySchema.safeParse({ instanceId: 'abc', uid: 'r1', limit: 0 }).success).toBe(false);
    expect(grafanaGetAlertHistorySchema.safeParse({ instanceId: 'abc', uid: 'r1', limit: 1001 }).success).toBe(false);
  });

  it('rejects negative and non-integer from/to', () => {
    expect(grafanaGetAlertHistorySchema.safeParse({ instanceId: 'abc', uid: 'r1', from: -1 }).success).toBe(false);
    expect(grafanaGetAlertHistorySchema.safeParse({ instanceId: 'abc', uid: 'r1', to: 1.5 }).success).toBe(false);
  });
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
  it('accepts instanceId and uid alone (fields defaults to targets at projection time)', () => {
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

describe('grafanaQueryPrometheusSchema', () => {
  it('accepts instanceId, datasourceUid, expr and defaults queryType to range at parse time', () => {
    const parsed = grafanaQueryPrometheusSchema.safeParse({
      instanceId: 'abc',
      datasourceUid: 'prom',
      expr: 'up'
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.queryType).toBe('range');
    }
  });

  it('accepts instant with time', () => {
    expect(
      grafanaQueryPrometheusSchema.safeParse({
        instanceId: 'abc',
        datasourceUid: 'prom',
        expr: 'up',
        queryType: 'instant',
        time: '1700000000'
      }).success
    ).toBe(true);
  });

  it('rejects extra properties and empty expr', () => {
    expect(
      grafanaQueryPrometheusSchema.safeParse({
        instanceId: 'abc',
        datasourceUid: 'prom',
        expr: 'up',
        path: 'api/v1/query'
      }).success
    ).toBe(false);
    expect(
      grafanaQueryPrometheusSchema.safeParse({ instanceId: 'abc', datasourceUid: 'prom', expr: '' }).success
    ).toBe(false);
  });
});

describe('grafanaQueryLokiSchema', () => {
  it('accepts expr and optional limit/direction', () => {
    expect(
      grafanaQueryLokiSchema.safeParse({
        instanceId: 'abc',
        datasourceUid: 'loki',
        expr: '{job="api"}',
        limit: 50,
        direction: 'backward'
      }).success
    ).toBe(true);
  });

  it('rejects a non-positive limit', () => {
    expect(
      grafanaQueryLokiSchema.safeParse({
        instanceId: 'abc',
        datasourceUid: 'loki',
        expr: '{job="api"}',
        limit: 0
      }).success
    ).toBe(false);
  });
});

describe('grafanaListPrometheusMetricNamesSchema', () => {
  it('accepts instanceId and datasourceUid', () => {
    expect(
      grafanaListPrometheusMetricNamesSchema.safeParse({ instanceId: 'abc', datasourceUid: 'prom' }).success
    ).toBe(true);
  });

  it('rejects an invalid regex', () => {
    expect(
      grafanaListPrometheusMetricNamesSchema.safeParse({
        instanceId: 'abc',
        datasourceUid: 'prom',
        regex: '('
      }).success
    ).toBe(false);
  });
});

describe('grafanaListPrometheusLabelValuesSchema', () => {
  it('rejects a path-like label', () => {
    expect(
      grafanaListPrometheusLabelValuesSchema.safeParse({
        instanceId: 'abc',
        datasourceUid: 'prom',
        label: 'job/name'
      }).success
    ).toBe(false);
  });

  it('accepts job and matcher', () => {
    expect(
      grafanaListPrometheusLabelValuesSchema.safeParse({
        instanceId: 'abc',
        datasourceUid: 'prom',
        label: 'job',
        matcher: '{__name__="up"}'
      }).success
    ).toBe(true);
  });
});

describe('grafanaListLokiLabelNamesSchema', () => {
  it('accepts instanceId and datasourceUid', () => {
    expect(
      grafanaListLokiLabelNamesSchema.safeParse({ instanceId: 'abc', datasourceUid: 'loki' }).success
    ).toBe(true);
  });

  it('accepts optional regex, start, and end', () => {
    expect(
      grafanaListLokiLabelNamesSchema.safeParse({
        instanceId: 'abc',
        datasourceUid: 'loki',
        regex: '^job',
        start: '1700000000',
        end: '1700003600'
      }).success
    ).toBe(true);
  });
});

describe('grafanaListAnnotationsSchema', () => {
  it('accepts instanceId alone and defaults limit to 100', () => {
    const parsed = grafanaListAnnotationsSchema.safeParse({ instanceId: 'abc' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.limit).toBe(100);
    }
  });

  it('accepts optional from, to, dashboardUid, tag, and limit', () => {
    expect(
      grafanaListAnnotationsSchema.safeParse({
        instanceId: 'abc',
        from: 1700000000000,
        to: 1700003600000,
        dashboardUid: 'dash-1',
        tag: 'release',
        limit: 50
      }).success
    ).toBe(true);
  });

  it('rejects limit 0 and limit 101', () => {
    expect(grafanaListAnnotationsSchema.safeParse({ instanceId: 'abc', limit: 0 }).success).toBe(false);
    expect(grafanaListAnnotationsSchema.safeParse({ instanceId: 'abc', limit: 101 }).success).toBe(false);
  });

  it('rejects unexpected extra properties', () => {
    expect(grafanaListAnnotationsSchema.safeParse({ instanceId: 'abc', extra: true }).success).toBe(false);
  });

  it('rejects negative from and to', () => {
    expect(grafanaListAnnotationsSchema.safeParse({ instanceId: 'abc', from: -1 }).success).toBe(false);
    expect(grafanaListAnnotationsSchema.safeParse({ instanceId: 'abc', to: -1 }).success).toBe(false);
  });
});

describe('grafanaGenerateDeeplinkSchema', () => {
  it('accepts explore with instanceId, kind, and datasourceUid', () => {
    expect(
      grafanaGenerateDeeplinkSchema.safeParse({
        instanceId: 'abc',
        kind: 'explore',
        datasourceUid: 'prom'
      }).success
    ).toBe(true);
  });

  it('rejects explore with openInIde true', () => {
    expect(
      grafanaGenerateDeeplinkSchema.safeParse({
        instanceId: 'abc',
        kind: 'explore',
        datasourceUid: 'prom',
        openInIde: true
      }).success
    ).toBe(false);
  });

  it('rejects extra properties on dashboard and explore', () => {
    expect(
      grafanaGenerateDeeplinkSchema.safeParse({
        instanceId: 'abc',
        kind: 'dashboard',
        uid: 'dash-1',
        extra: true
      }).success
    ).toBe(false);
    expect(
      grafanaGenerateDeeplinkSchema.safeParse({
        instanceId: 'abc',
        kind: 'explore',
        datasourceUid: 'prom',
        extra: true
      }).success
    ).toBe(false);
  });

  it('accepts dashboard with instanceId, kind, and uid', () => {
    expect(
      grafanaGenerateDeeplinkSchema.safeParse({
        instanceId: 'abc',
        kind: 'dashboard',
        uid: 'dash-1'
      }).success
    ).toBe(true);
  });

  it('parses omitted openInIde as false on dashboard', () => {
    const parsed = grafanaGenerateDeeplinkSchema.safeParse({
      instanceId: 'abc',
      kind: 'dashboard',
      uid: 'dash-1'
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({ kind: 'dashboard', openInIde: false });
    }
  });

  it('accepts explore with an optional expr and rejects an empty one', () => {
    expect(
      grafanaGenerateDeeplinkSchema.safeParse({
        instanceId: 'abc',
        kind: 'explore',
        datasourceUid: 'prom',
        expr: 'up'
      }).success
    ).toBe(true);
    expect(
      grafanaGenerateDeeplinkSchema.safeParse({
        instanceId: 'abc',
        kind: 'explore',
        datasourceUid: 'prom',
        expr: ''
      }).success
    ).toBe(false);
  });

  it('accepts alertRule with instanceId and uid', () => {
    expect(
      grafanaGenerateDeeplinkSchema.safeParse({
        instanceId: 'abc',
        kind: 'alertRule',
        uid: 'rule-1'
      }).success
    ).toBe(true);
  });

  it('rejects alertRule without uid, with openInIde, or with dashboard-only extras', () => {
    expect(grafanaGenerateDeeplinkSchema.safeParse({ instanceId: 'abc', kind: 'alertRule' }).success).toBe(false);
    expect(
      grafanaGenerateDeeplinkSchema.safeParse({
        instanceId: 'abc',
        kind: 'alertRule',
        uid: 'rule-1',
        openInIde: true
      }).success
    ).toBe(false);
    expect(
      grafanaGenerateDeeplinkSchema.safeParse({
        instanceId: 'abc',
        kind: 'alertRule',
        uid: 'rule-1',
        panelId: 5
      }).success
    ).toBe(false);
  });
});

describe('grafanaListLokiLabelValuesSchema', () => {
  it('accepts instanceId, datasourceUid, and a valid label', () => {
    expect(
      grafanaListLokiLabelValuesSchema.safeParse({
        instanceId: 'abc',
        datasourceUid: 'loki',
        label: 'job'
      }).success
    ).toBe(true);
  });

  it('rejects a path-like label', () => {
    expect(
      grafanaListLokiLabelValuesSchema.safeParse({
        instanceId: 'abc',
        datasourceUid: 'loki',
        label: 'job/name'
      }).success
    ).toBe(false);
  });
});
