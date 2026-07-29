import { describe, expect, it } from 'vitest';
import {
  grafanaGetAlertHistorySchema,
  grafanaGetAlertRuleSchema,
  grafanaGetDashboardSchema,
  grafanaListAlertRulesSchema,
  grafanaListDashboardsSchema,
  grafanaListFoldersSchema,
  grafanaListInstancesSchema
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
    grafanaListAlertRulesSchema
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
    grafanaGetDashboardSchema,
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
