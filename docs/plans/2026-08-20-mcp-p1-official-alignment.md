# MCP P1 Official Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add read-only Prom/Loki discovery, annotations, deeplink (optional IDE Webview), and alert `states` filtering so AT Grafana MCP covers grafana/mcp-grafana P1 workflows without copying metadata/write tools.

**Architecture:** Discovery tools are thin `GET` builders into the existing private `queryDatasource` pipeline (rate limit, size cap, path confinement). Annotations use a new `GrafanaAnnotationsApi` on `GrafanaHttpClient`. Deeplink is a pure URL builder plus an optional vscode-free `openDashboardInIde` callback. Alert filtering happens after existing `normalizeAlertState` correlation. Catalog 11 → 17, all `risk: read`.

**Tech Stack:** TypeScript, Zod, Vitest, existing Bridge / `GrafanaApiClient` / Hub Protocol v1.

**Spec:** [docs/specs/2026-08-20-mcp-p1-official-alignment-design.md](../specs/2026-08-20-mcp-p1-official-alignment-design.md)  
**Decision:** [docs/decisions/ADR-007-discovery-annotations-deeplink.md](../decisions/ADR-007-discovery-annotations-deeplink.md)

**Out of scope:** write tools, metric metadata, Prom label-*names*, annotation tags, Tempo/OnCall/Sift, opening Explore/alerts in the IDE, Hub repo changes.

**Branch:** `feat/mcp-p1-official-alignment` (stacked on P0). Do not start from `master`.

After Task 3, Tasks 4 and 5 do not share production files and may run in parallel. Task 6 edits `bridgeSchemas` / service / catalog already touched by 3–5 — keep it serial after those land.

---

## File map

| File | Responsibility |
|---|---|
| `docs/decisions/ADR-007-discovery-annotations-deeplink.md` | Status → Accepted |
| `docs/requirements.md`, `docs/decisions/ADR-004-mcp-tool-catalog-and-permission-model.md` | Catalog / MGT / MON / DoD 17 |
| `src/grafana/typedDatasourceDiscovery.ts` | Builders, label pattern, list cap + projection |
| `src/grafana/grafanaDeeplink.ts` | Pure Grafana URL builder |
| `src/grafana/GrafanaAnnotationsApi.ts` | `GET /api/annotations` |
| `src/grafana/GrafanaApiClient.ts` | Facade `listAnnotations` |
| `src/mcp/bridgeSchemas.ts` | Zod + JSON Schema twins |
| `src/mcp/toolCatalog.ts` | 17 entries |
| `src/agent/GrafanaAgentToolService.ts` | Dispatch; `openDashboardInIde?` |
| `src/extension.ts` | Inject `atGrafana.openDashboard` callback |
| Skill + README / features / usage EN+zh-CN | 17-tool copy |

Do **not** change `GrafanaHttpClient` query typing, `DATASOURCE_PROXY_PATH_DENY_PATTERN`, or `QUERY_ENDPOINTS`.

---

### Task 1: Accept ADR-007 and patch requirements

**Files:**
- Modify: `docs/decisions/ADR-007-discovery-annotations-deeplink.md` (Status Proposed → Accepted)
- Modify: `docs/requirements.md`
- Modify: `docs/decisions/ADR-004-mcp-tool-catalog-and-permission-model.md`

- [ ] **Step 1: Mark ADR-007 Accepted**

In `docs/decisions/ADR-007-discovery-annotations-deeplink.md`, change:

```
## Status
Proposed
```

to:

```
## Status
Accepted
```

- [ ] **Step 2: Patch requirements.md**

In D10 monitoring family, add the four discovery tools (keep the two typed query tools and the escape hatch).

Add rows after MGT7:

```
| MGT8 | `grafana_list_annotations` — 只读 `GET /api/annotations`；可选 `from`/`to`（epoch ms）、`dashboardUid`（Grafana `dashboardUID`）、单 `tag`、`limit`≤100 | P1 |
| MGT9 | `grafana_generate_deeplink` — 由实例 URL 拼 dashboard/Explore 链接；可选 `openInIde`（缺省 false）打开本机 Webview | P1 |
```

Update MGT5:

```
| MGT5 | `grafana_list_alert_rules` — 列出告警规则及当前状态；可选 `states` 数组（`firing`\|`pending`\|`normal`\|`unknown`），缺省仍全量 | P0 |
```

Add after MON2b:

```
| MON2c | `grafana_list_prometheus_metric_names` — `GET api/v1/label/__name__/values`，可选 regex，最多 200 条 | P1 |
| MON2d | `grafana_list_prometheus_label_values` — `GET api/v1/label/<label>/values`，`label` 允许集 `^[a-zA-Z_][a-zA-Z0-9_]*$`，可选 `matcher`→`match[]` | P1 |
| MON2e | `grafana_list_loki_label_names` — `GET loki/api/v1/labels` | P1 |
| MON2f | `grafana_list_loki_label_values` — `GET loki/api/v1/label/<label>/values` | P1 |
```

Replace §7 item 5 with:

```
5. 开启后台访问后，无需打开任何面板，Agent 可直接调用全部 9 个管理类工具（含发现类 `grafana_list_instances`）+ 8 个监控数据类工具（共 17 个）
```

- [ ] **Step 3: Patch ADR-004 catalog table**

Add under Grafana management family:

```
| `grafana_list_annotations` | Read-only Grafana annotations (`from`/`to`/`dashboardUid`/`tag`/`limit`) |
| `grafana_generate_deeplink` | Build Grafana dashboard/Explore URL; optional `openInIde` opens the AT Webview |
```

Change `grafana_list_alert_rules` purpose to mention optional `states`.

Add under Monitoring data family (before the escape hatch):

```
| `grafana_list_prometheus_metric_names` | Prometheus metric names via `api/v1/label/__name__/values` (cap 200, optional regex) |
| `grafana_list_prometheus_label_values` | Prometheus label values via `api/v1/label/<label>/values` |
| `grafana_list_loki_label_names` | Loki label names via `loki/api/v1/labels` |
| `grafana_list_loki_label_values` | Loki label values via `loki/api/v1/label/<label>/values` |
```

After the ADR-006 pointer paragraph, add: typed discovery / annotations / deeplink are specified in ADR-007.

- [ ] **Step 4: Commit**

```bash
git add docs/decisions/ADR-007-discovery-annotations-deeplink.md \
  docs/requirements.md docs/decisions/ADR-004-mcp-tool-catalog-and-permission-model.md
git commit -m "$(cat <<'EOF'
docs: accept ADR-007 for discovery, annotations, and deeplink

Align requirements and ADR-004 with the 17-tool P1 catalog.
EOF
)"
```

---

### Task 2: Discovery builders (TDD)

**Files:**
- Create: `src/grafana/typedDatasourceDiscovery.ts`
- Test: `test/grafana/typedDatasourceDiscovery.test.ts`

Must not import vscode or `GrafanaAgentToolService`.

- [ ] **Step 1: Write failing tests**

Create `test/grafana/typedDatasourceDiscovery.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DISCOVERY_LIST_MAX,
  PROMETHEUS_LABEL_PATTERN,
  buildLokiLabelNamesCall,
  buildLokiLabelValuesCall,
  buildPrometheusLabelValuesCall,
  buildPrometheusMetricNamesCall,
  projectDiscoveryValues
} from '../../src/grafana/typedDatasourceDiscovery';

describe('buildPrometheusMetricNamesCall', () => {
  it('uses GET api/v1/label/__name__/values', () => {
    expect(buildPrometheusMetricNamesCall({})).toEqual({
      method: 'GET',
      path: 'api/v1/label/__name__/values',
      query: {}
    });
  });

  it('forwards optional start and end', () => {
    expect(buildPrometheusMetricNamesCall({ start: '1700000000', end: '1700003600' })).toEqual({
      method: 'GET',
      path: 'api/v1/label/__name__/values',
      query: { start: '1700000000', end: '1700003600' }
    });
  });
});

describe('buildPrometheusLabelValuesCall', () => {
  it('puts a valid label in the path and matcher in match[]', () => {
    expect(buildPrometheusLabelValuesCall({ label: 'job', matcher: '{__name__="up"}' })).toEqual({
      method: 'GET',
      path: 'api/v1/label/job/values',
      query: { 'match[]': '{__name__="up"}' }
    });
  });

  it('rejects labels that could escape the proxy path', () => {
    expect(() => buildPrometheusLabelValuesCall({ label: '..' })).toThrow(/label/);
    expect(() => buildPrometheusLabelValuesCall({ label: 'job/name' })).toThrow(/label/);
    expect(() => buildPrometheusLabelValuesCall({ label: '' })).toThrow(/label/);
  });
});

describe('buildLokiLabelNamesCall', () => {
  it('uses GET loki/api/v1/labels', () => {
    expect(buildLokiLabelNamesCall({ start: '1', end: '2' })).toEqual({
      method: 'GET',
      path: 'loki/api/v1/labels',
      query: { start: '1', end: '2' }
    });
  });
});

describe('buildLokiLabelValuesCall', () => {
  it('uses GET loki/api/v1/label/<label>/values', () => {
    expect(buildLokiLabelValuesCall({ label: 'job' })).toEqual({
      method: 'GET',
      path: 'loki/api/v1/label/job/values',
      query: {}
    });
  });
});

describe('projectDiscoveryValues', () => {
  it('reads Prometheus { status, data: string[] } and caps at DISCOVERY_LIST_MAX', () => {
    const data = Array.from({ length: DISCOVERY_LIST_MAX + 5 }, (_, i) => `m${i}`);
    const result = projectDiscoveryValues({ status: 'success', data });
    expect(result.values).toHaveLength(DISCOVERY_LIST_MAX);
    expect(result.truncated).toBe(true);
  });

  it('applies regex before capping', () => {
    const result = projectDiscoveryValues({ data: ['up', 'http_requests', 'go_goroutines'] }, '^go_');
    expect(result).toEqual({ values: ['go_goroutines'] });
  });
});

describe('PROMETHEUS_LABEL_PATTERN', () => {
  it('accepts job and __name__-style underscore names, not path segments', () => {
    expect(PROMETHEUS_LABEL_PATTERN.test('job')).toBe(true);
    expect(PROMETHEUS_LABEL_PATTERN.test('_name')).toBe(true);
    expect(PROMETHEUS_LABEL_PATTERN.test('__name__')).toBe(true);
    expect(PROMETHEUS_LABEL_PATTERN.test('job/name')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify RED**

Run: `npx vitest run test/grafana/typedDatasourceDiscovery.test.ts`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/grafana/typedDatasourceDiscovery.ts`:

```ts
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
```

Do not URL-encode `label` in the path: after `PROMETHEUS_LABEL_PATTERN` it is `[A-Za-z0-9_]+` only. Do not put `regex` into the Grafana query string.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/grafana/typedDatasourceDiscovery.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/grafana/typedDatasourceDiscovery.ts test/grafana/typedDatasourceDiscovery.test.ts
git commit -m "$(cat <<'EOF'
feat(grafana): add Prom/Loki label discovery proxy builders

Map metric/label listing onto confined datasource-proxy GET paths
and cap projected values at 200.
EOF
)"
```

---

### Task 3: Wire discovery tools (schemas, catalog, invoke)

**Files:**
- Modify: `src/mcp/bridgeSchemas.ts`
- Modify: `src/mcp/toolCatalog.ts`
- Modify: `src/agent/GrafanaAgentToolService.ts`
- Test: `test/mcp/bridgeSchemas.test.ts`
- Test: `test/mcp/toolCatalog.test.ts`
- Test: `test/agent/GrafanaAgentToolService.test.ts`
- Test: `test/mcp/BridgeServer.integration.test.ts`

Do **not** add annotations or deeplink yet (Tasks 4–5). Catalog will be 15 after this task (11 + 4). Task 7 / final catalog length 17 is after 4–5. Tests in this task should expect **15** names, or assert the four new names exist without freezing 17. Prefer: update `MONITORING_TOOL_NAMES` to include the four discovery tools and rename the catalog test to “current catalog names” using that array (will grow again in Tasks 4–5). After Task 3 the expected set is 11 + 4 = 15.

- [ ] **Step 1: Write failing schema tests**

Add to `test/mcp/bridgeSchemas.test.ts` (import the new schemas):

```ts
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
```

- [ ] **Step 2: Run schema tests — Expected FAIL (not exported)**

Run: `npx vitest run test/mcp/bridgeSchemas.test.ts`

- [ ] **Step 3: Add Zod + JSON Schema + monitoring names**

Shared regex refine (place above the schemas in `bridgeSchemas.ts`):

```ts
import { PROMETHEUS_LABEL_PATTERN } from '../grafana/typedDatasourceDiscovery';

const optionalRegexSchema = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        new RegExp(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a valid JavaScript regular expression' }
  )
  .optional();

const prometheusLabelSchema = z.string().regex(PROMETHEUS_LABEL_PATTERN);
```

```ts
export const grafanaListPrometheusMetricNamesSchema = z
  .object({
    instanceId: z.string().min(1),
    datasourceUid: z.string().min(1),
    regex: optionalRegexSchema,
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional()
  })
  .strict();

export const grafanaListPrometheusLabelValuesSchema = z
  .object({
    instanceId: z.string().min(1),
    datasourceUid: z.string().min(1),
    label: prometheusLabelSchema,
    matcher: z.string().min(1).optional(),
    regex: optionalRegexSchema,
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional()
  })
  .strict();

export const grafanaListLokiLabelNamesSchema = z
  .object({
    instanceId: z.string().min(1),
    datasourceUid: z.string().min(1),
    regex: optionalRegexSchema,
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional()
  })
  .strict();

export const grafanaListLokiLabelValuesSchema = z
  .object({
    instanceId: z.string().min(1),
    datasourceUid: z.string().min(1),
    label: prometheusLabelSchema,
    regex: optionalRegexSchema,
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional()
  })
  .strict();
```

Export `z.infer` types. Extend `AT_GRAFANA_MONITORING_TOOL_NAMES`:

```ts
export const AT_GRAFANA_MONITORING_TOOL_NAMES = [
  'grafana_list_datasources',
  'grafana_query_prometheus',
  'grafana_query_loki',
  'grafana_list_prometheus_metric_names',
  'grafana_list_prometheus_label_values',
  'grafana_list_loki_label_names',
  'grafana_list_loki_label_values',
  'grafana_query_datasource'
] as const;
```

Add all four to `BRIDGE_SCHEMAS_BY_TOOL_NAME`.

JSON Schema twins: `required: ['instanceId', 'datasourceUid']`; label-values schemas also require `label` with `pattern: '^[a-zA-Z_][a-zA-Z0-9_]*$'`; `additionalProperties: false`. Do not put `regex` into `required`.

- [ ] **Step 4: Re-run schema tests — Expected PASS**

- [ ] **Step 5: Write failing catalog + service tests**

`test/mcp/toolCatalog.test.ts`: add the four names to `MONITORING_TOOL_NAMES`. Rename the “exactly the 11 tools” test to “declares the current catalog names, in any order”. Add:

```ts
it('grafana_list_prometheus_metric_names requires instanceId and datasourceUid', () => {
  const tool = findTool('grafana_list_prometheus_metric_names');
  expect(tool.risk).toBe('read');
  expect(tool.inputSchema.required).toEqual(['instanceId', 'datasourceUid']);
});
```

`test/agent/GrafanaAgentToolService.test.ts`:

1. Add the four tools to the disabled-instance `toolCalls` array (minimal valid args).
2. Add:

```ts
it('grafana_list_prometheus_metric_names forwards GET api/v1/label/__name__/values and projects values', async () => {
  const proxyDatasourceRequest = vi.fn(async () => ({ status: 'success', data: ['up', 'go_goroutines'] }));
  const client = fakeClient({ proxyDatasourceRequest });
  const { service } = await makeService({ client });

  const result = await service.invoke('grafana_list_prometheus_metric_names', {
    instanceId: 'instance-1',
    datasourceUid: 'prom',
    regex: '^go_'
  });

  expect(result).toEqual({ ok: true, result: { values: ['go_goroutines'] } });
  expect(proxyDatasourceRequest).toHaveBeenCalledWith(
    'prom',
    'GET',
    'api/v1/label/__name__/values',
    expect.any(Object),
    undefined,
    expect.any(Number)
  );
});
```

`test/mcp/BridgeServer.integration.test.ts`: keep using `haveLength(AT_GRAFANA_TOOL_CATALOG.length)`. Add:

```ts
it('monitoring family: POST /invoke grafana_list_prometheus_metric_names projects label values', async () => {
  const client = fakeClient({
    proxyDatasourceRequest: async () => ({ status: 'success', data: ['up', 'go_goroutines'] })
  });
  const handler = await makeHandler({ client });

  const response = await handler(
    invokeRequest('grafana_list_prometheus_metric_names', {
      instanceId: 'instance-1',
      datasourceUid: 'prom',
      regex: '^up$'
    })
  );

  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    ok: true,
    name: 'grafana_list_prometheus_metric_names',
    result: { values: ['up'] }
  });
});
```

- [ ] **Step 6: Run those tests — Expected FAIL (unknown tool)**

```bash
npx vitest run test/mcp/toolCatalog.test.ts test/agent/GrafanaAgentToolService.test.ts \
  test/mcp/BridgeServer.integration.test.ts
```

- [ ] **Step 7: Implement catalog + dispatch**

`toolCatalog.ts`: import the four JSON schemas. Insert the four tools after `grafana_query_loki` and before `grafana_query_datasource`. Descriptions must mention PromQL/LogQL discovery, the 200 cap, and `truncated`. Append `MONITORING_FAMILY_SUFFIX`.

`GrafanaAgentToolService.ts`: import the four schemas and the four builders + `projectDiscoveryValues`. Add a private helper:

```ts
private projectProxyDiscovery(result: unknown, regex?: string): unknown {
  if (typeof result === 'object' && result !== null && 'truncated' in result && (result as { truncated?: unknown }).truncated === true) {
    return result;
  }
  return projectDiscoveryValues(result, regex);
}
```

Add cases **before** `default` (pattern matches typed query tools):

```ts
case 'grafana_list_prometheus_metric_names':
  return await this.withAuthorizedClient(grafanaListPrometheusMetricNamesSchema, args, async (client, parsed) => {
    const proxy = buildPrometheusMetricNamesCall(parsed);
    const result = await this.queryDatasource(client, {
      instanceId: parsed.instanceId,
      datasourceUid: parsed.datasourceUid,
      method: proxy.method,
      path: proxy.path,
      query: proxy.query
    });
    return this.projectProxyDiscovery(result, parsed.regex);
  });
```

Repeat for label-values (Prom + Loki) and Loki label-names, passing `parsed` into the matching builder. Never bypass `queryDatasource`.

- [ ] **Step 8: Run focused tests then typecheck**

```bash
npx vitest run test/grafana/typedDatasourceDiscovery.test.ts test/mcp/bridgeSchemas.test.ts \
  test/mcp/toolCatalog.test.ts test/agent/GrafanaAgentToolService.test.ts \
  test/mcp/BridgeServer.integration.test.ts
npm run typecheck
```

Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/mcp/bridgeSchemas.ts src/mcp/toolCatalog.ts src/agent/GrafanaAgentToolService.ts \
  test/mcp/bridgeSchemas.test.ts test/mcp/toolCatalog.test.ts \
  test/agent/GrafanaAgentToolService.test.ts test/mcp/BridgeServer.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add Prom/Loki metric and label discovery tools

Typed list tools reuse queryDatasource metering; results are capped
and optionally regex-filtered before they hit the model context.
EOF
)"
```

---

### Task 4: Annotations API + MCP tool

**Files:**
- Create: `src/grafana/GrafanaAnnotationsApi.ts`
- Modify: `src/grafana/GrafanaApiClient.ts`
- Modify: `src/mcp/bridgeSchemas.ts`
- Modify: `src/mcp/toolCatalog.ts`
- Modify: `src/agent/GrafanaAgentToolService.ts` (`GrafanaApiClientLike` Pick + dispatch)
- Test: `test/grafana/GrafanaAnnotationsApi.test.ts`
- Test: `test/mcp/bridgeSchemas.test.ts`
- Test: `test/agent/GrafanaAgentToolService.test.ts`
- Test: `test/mcp/toolCatalog.test.ts`
- Test: `test/mcp/BridgeServer.integration.test.ts` (fakeClient must add `listAnnotations`)

- [ ] **Step 1: Write failing HTTP test**

Create `test/grafana/GrafanaAnnotationsApi.test.ts` using the same `listen` helper as `GrafanaDashboardsApi.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { GrafanaApiClient } from '../../src/grafana/GrafanaApiClient';
import { listen, type TestHttpServer } from './testHttpServer';

let server: TestHttpServer | undefined;

afterEach(async () => {
  if (server) {
    await server.close();
    server = undefined;
  }
});

it('listAnnotations() forwards from, to, dashboardUID, tags, and limit to GET /api/annotations', async () => {
  let seen: string | undefined;
  server = await listen((req, res) => {
    seen = req.url;
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify([{ id: 1, time: 1700000000000, text: 'deploy', tags: ['release'] }])
    );
  });
  const client = new GrafanaApiClient({ baseUrl: server.url, token: 'tok' });

  const rows = await client.listAnnotations({
    from: 1700000000000,
    to: 1700003600000,
    dashboardUid: 'dash-1',
    tag: 'release',
    limit: 50
  });

  const parsed = new URL(seen ?? '/', 'http://grafana.invalid');
  expect(parsed.pathname).toBe('/api/annotations');
  expect(parsed.searchParams.get('from')).toBe('1700000000000');
  expect(parsed.searchParams.get('to')).toBe('1700003600000');
  expect(parsed.searchParams.get('dashboardUID')).toBe('dash-1');
  expect(parsed.searchParams.get('tags')).toBe('release');
  expect(parsed.searchParams.get('limit')).toBe('50');
  expect(rows).toEqual([
    { id: 1, time: 1700000000000, text: 'deploy', tags: ['release'] }
  ]);
});
```

- [ ] **Step 2: Run — Expected FAIL** (`listAnnotations` missing)

Run: `npx vitest run test/grafana/GrafanaAnnotationsApi.test.ts`

- [ ] **Step 3: Implement API + facade**

Create `src/grafana/GrafanaAnnotationsApi.ts`:

```ts
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
```

In `GrafanaApiClient.ts`: construct `GrafanaAnnotationsApi`, add:

```ts
listAnnotations(
  ...args: Parameters<GrafanaAnnotationsApi['list']>
): ReturnType<GrafanaAnnotationsApi['list']> {
  return this.annotationsApi.list(...args);
}
```

Update the file header comment to mention `GET /api/annotations`.

- [ ] **Step 4: Run API test — Expected PASS**

- [ ] **Step 5: Write failing schema/service tests**

Schema: accepts `{ instanceId }` and `{ instanceId, from, to, dashboardUid, tag, limit: 50 }`; rejects `limit: 0`, `limit: 101`, extra properties.

Service:

```ts
it('grafana_list_annotations forwards dashboardUid as dashboardUID via listAnnotations', async () => {
  const listAnnotations = vi.fn(async () => [{ id: 1, time: 1, text: 'deploy', tags: ['r'] }]);
  const { service } = await makeService({ client: fakeClient({ listAnnotations }) });

  await service.invoke('grafana_list_annotations', {
    instanceId: 'instance-1',
    dashboardUid: 'dash-1',
    tag: 'r',
    limit: 50
  });

  expect(listAnnotations).toHaveBeenCalledWith({
    from: undefined,
    to: undefined,
    dashboardUid: 'dash-1',
    tag: 'r',
    limit: 50
  });
});
```

Add `grafana_list_annotations` to disabled-instance `toolCalls` and `AT_GRAFANA_MANAGEMENT_TOOL_NAMES`. Add `listAnnotations: async () => []` to **both** `fakeClient` implementations (`GrafanaAgentToolService.test.ts` and `BridgeServer.integration.test.ts`). Extend `GrafanaApiClientLike` Pick with `'listAnnotations'`.

Catalog: add name to `MANAGEMENT_TOOL_NAMES`.

- [ ] **Step 6: Run — Expected FAIL**

- [ ] **Step 7: Implement schema, catalog, dispatch**

```ts
export const grafanaListAnnotationsSchema = z
  .object({
    instanceId: z.string().min(1),
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().nonnegative().optional(),
    dashboardUid: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    limit: z.number().int().positive().max(100).default(100)
  })
  .strict();
```

JSON Schema twin: `limit` not required (Zod default); `from`/`to`/`limit` type integer; required `['instanceId']`.

Catalog entry after `grafana_get_alert_history`, `risk: 'read'`, mention read-only and deploy-window use. `MANAGEMENT_FAMILY_SUFFIX`.

Invoke:

```ts
case 'grafana_list_annotations':
  return await this.withAuthorizedClient(grafanaListAnnotationsSchema, args, (client, parsed) =>
    client.listAnnotations({
      from: parsed.from,
      to: parsed.to,
      dashboardUid: parsed.dashboardUid,
      tag: parsed.tag,
      limit: parsed.limit
    })
  );
```

- [ ] **Step 8: Run tests + typecheck — Expected PASS**

```bash
npx vitest run test/grafana/GrafanaAnnotationsApi.test.ts test/mcp/bridgeSchemas.test.ts \
  test/mcp/toolCatalog.test.ts test/agent/GrafanaAgentToolService.test.ts \
  test/mcp/BridgeServer.integration.test.ts
npm run typecheck
```

- [ ] **Step 9: Commit**

```bash
git add src/grafana/GrafanaAnnotationsApi.ts src/grafana/GrafanaApiClient.ts \
  src/mcp/bridgeSchemas.ts src/mcp/toolCatalog.ts src/agent/GrafanaAgentToolService.ts \
  test/grafana/GrafanaAnnotationsApi.test.ts test/mcp/bridgeSchemas.test.ts \
  test/mcp/toolCatalog.test.ts test/agent/GrafanaAgentToolService.test.ts \
  test/mcp/BridgeServer.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add read-only grafana_list_annotations

Forward from/to/dashboardUid/tag/limit to Grafana GET /api/annotations
so agents can correlate events with a time window.
EOF
)"
```

---

### Task 5: Deeplink builder + optional IDE open

**Files:**
- Create: `src/grafana/grafanaDeeplink.ts`
- Modify: `src/mcp/bridgeSchemas.ts`
- Modify: `src/mcp/toolCatalog.ts`
- Modify: `src/agent/GrafanaAgentToolService.ts` (deps + dispatch)
- Modify: `src/extension.ts`
- Test: `test/grafana/grafanaDeeplink.test.ts`
- Test: `test/mcp/bridgeSchemas.test.ts`
- Test: `test/agent/GrafanaAgentToolService.test.ts`
- Test: `test/mcp/toolCatalog.test.ts`

- [ ] **Step 1: Write failing URL-builder tests**

Create `test/grafana/grafanaDeeplink.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildGrafanaDeeplink, buildOpenInIdeSearch } from '../../src/grafana/grafanaDeeplink';

describe('buildGrafanaDeeplink', () => {
  it('builds a dashboard URL with viewPanel and range, stripping a trailing slash on origin', () => {
    expect(
      buildGrafanaDeeplink('https://grafana.example.com/', {
        kind: 'dashboard',
        uid: 'dash-1',
        panelId: 5,
        from: 'now-1h',
        to: 'now'
      })
    ).toBe('https://grafana.example.com/d/dash-1?viewPanel=5&from=now-1h&to=now');
  });

  it('builds an Explore left-pane URL with default range now-1h..now', () => {
    const url = buildGrafanaDeeplink('https://grafana.example.com', {
      kind: 'explore',
      datasourceUid: 'prom'
    });
    expect(url.startsWith('https://grafana.example.com/explore?left=')).toBe(true);
    const left = JSON.parse(decodeURIComponent(new URL(url).searchParams.get('left') ?? ''));
    expect(left).toEqual({
      datasource: 'prom',
      queries: [{ refId: 'A', datasource: { uid: 'prom' } }],
      range: { from: 'now-1h', to: 'now' }
    });
  });
});

describe('buildOpenInIdeSearch', () => {
  it('returns the same viewPanel/from/to query string used on the Grafana URL', () => {
    expect(buildOpenInIdeSearch({ panelId: 5, from: 'now-6h', to: 'now' })).toBe(
      'viewPanel=5&from=now-6h&to=now'
    );
  });
});
```

- [ ] **Step 2: Run — Expected FAIL**

Run: `npx vitest run test/grafana/grafanaDeeplink.test.ts`

- [ ] **Step 3: Implement builder**

Create `src/grafana/grafanaDeeplink.ts`:

```ts
export type GrafanaDeeplinkKind = 'dashboard' | 'explore';

export interface GrafanaDashboardDeeplinkInput {
  kind: 'dashboard';
  uid: string;
  panelId?: number;
  from?: string;
  to?: string;
}

export interface GrafanaExploreDeeplinkInput {
  kind: 'explore';
  datasourceUid: string;
  from?: string;
  to?: string;
}

export type GrafanaDeeplinkInput = GrafanaDashboardDeeplinkInput | GrafanaExploreDeeplinkInput;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function buildOpenInIdeSearch(input: { panelId?: number; from?: string; to?: string }): string {
  const params = new URLSearchParams();
  if (input.panelId !== undefined) {
    params.set('viewPanel', String(input.panelId));
  }
  if (input.from !== undefined) {
    params.set('from', input.from);
  }
  if (input.to !== undefined) {
    params.set('to', input.to);
  }
  return params.toString();
}

export function buildGrafanaDeeplink(instanceUrl: string, input: GrafanaDeeplinkInput): string {
  const origin = stripTrailingSlash(instanceUrl);
  if (input.kind === 'dashboard') {
    const search = buildOpenInIdeSearch(input);
    return search.length > 0
      ? `${origin}/d/${encodeURIComponent(input.uid)}?${search}`
      : `${origin}/d/${encodeURIComponent(input.uid)}`;
  }
  const left = {
    datasource: input.datasourceUid,
    queries: [{ refId: 'A', datasource: { uid: input.datasourceUid } }],
    range: { from: input.from ?? 'now-1h', to: input.to ?? 'now' }
  };
  return `${origin}/explore?left=${encodeURIComponent(JSON.stringify(left))}`;
}
```

- [ ] **Step 4: Run builder tests — Expected PASS**

- [ ] **Step 5: Write failing schema + service tests**

Schema (discriminated union):

- dashboard `{ instanceId, kind: 'dashboard', uid }` succeeds; `openInIde` defaults false at parse time
- explore `{ instanceId, kind: 'explore', datasourceUid }` succeeds
- explore + `openInIde: true` fails
- extra properties fail

Service: extend `ServiceOptions` with `openDashboardInIde?: GrafanaAgentToolServiceDependencies['openDashboardInIde']` and pass it into the constructor.

```ts
it('grafana_generate_deeplink returns a dashboard URL and does not open the IDE by default', async () => {
  const openDashboardInIde = vi.fn(async () => undefined);
  const { service } = await makeService({ openDashboardInIde });

  const result = await service.invoke('grafana_generate_deeplink', {
    instanceId: 'instance-1',
    kind: 'dashboard',
    uid: 'dash-1'
  });

  expect(result).toEqual({
    ok: true,
    result: { grafanaUrl: 'https://grafana.example.com/d/dash-1', openedInIde: false }
  });
  expect(openDashboardInIde).not.toHaveBeenCalled();
});

it('grafana_generate_deeplink openInIde calls the callback with matching search and survives callback failure', async () => {
  const openDashboardInIde = vi.fn(async () => {
    throw new Error('panel failed');
  });
  const { service } = await makeService({ openDashboardInIde });

  const result = await service.invoke('grafana_generate_deeplink', {
    instanceId: 'instance-1',
    kind: 'dashboard',
    uid: 'dash-1',
    panelId: 5,
    from: 'now-1h',
    to: 'now',
    openInIde: true,
    title: 'CPU'
  });

  expect(openDashboardInIde).toHaveBeenCalledWith({
    instanceId: 'instance-1',
    uid: 'dash-1',
    title: 'CPU',
    search: 'viewPanel=5&from=now-1h&to=now'
  });
  expect(result).toMatchObject({
    ok: true,
    result: {
      grafanaUrl: 'https://grafana.example.com/d/dash-1?viewPanel=5&from=now-1h&to=now',
      openedInIde: false
    }
  });
  expect((result as { result: { message: string } }).result.message.length).toBeGreaterThan(0);
});
```

Add `grafana_generate_deeplink` to disabled-instance `toolCalls` with `{ instanceId: 'known', kind: 'dashboard', uid: 'd1' }`.

- [ ] **Step 6: Run — Expected FAIL**

- [ ] **Step 7: Implement schema, catalog, service, extension**

```ts
export const grafanaGenerateDeeplinkSchema = z.discriminatedUnion('kind', [
  z
    .object({
      instanceId: z.string().min(1),
      kind: z.literal('dashboard'),
      uid: z.string().min(1),
      panelId: z.number().int().positive().optional(),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
      openInIde: z.boolean().default(false),
      title: z.string().min(1).optional()
    })
    .strict(),
  z
    .object({
      instanceId: z.string().min(1),
      kind: z.literal('explore'),
      datasourceUid: z.string().min(1),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional()
    })
    .strict()
]);
```

JSON Schema twin (hand-written; Zod remains source of truth):

```ts
export const GRAFANA_GENERATE_DEEPLINK_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', minLength: 1 },
    kind: { type: 'string', enum: ['dashboard', 'explore'] },
    uid: { type: 'string', minLength: 1, description: 'Required when kind is dashboard.' },
    datasourceUid: { type: 'string', minLength: 1, description: 'Required when kind is explore.' },
    panelId: { type: 'integer', exclusiveMinimum: 0 },
    from: { type: 'string', minLength: 1 },
    to: { type: 'string', minLength: 1 },
    openInIde: {
      type: 'boolean',
      description: 'Dashboard only. Default false. Opens the AT Grafana Webview.'
    },
    title: { type: 'string', minLength: 1 }
  },
  required: ['instanceId', 'kind'],
  additionalProperties: false
};
```

Add to management names + `BRIDGE_SCHEMAS_BY_TOOL_NAME`. Catalog: after annotations (or after alert history if Task 4 order differs — place after `grafana_list_annotations` if that entry exists). Description: always returns `grafanaUrl`; `openInIde` default false; Explore is URL-only.

In `GrafanaAgentToolServiceDependencies`:

```ts
openDashboardInIde?: (args: {
  instanceId: string;
  uid: string;
  title?: string;
  search?: string;
}) => Promise<void>;
```

Invoke (still `withAuthorizedClient` so background-access + token apply). Use `parsed.data` instance url from `configManager.getInstance` — already loaded inside `withAuthorizedClient`. Implementation:

```ts
case 'grafana_generate_deeplink':
  return await this.withAuthorizedClient(grafanaGenerateDeeplinkSchema, args, async (_client, parsed) => {
    const instance = await this.deps.configManager.getInstance(parsed.instanceId);
    const grafanaUrl = buildGrafanaDeeplink(instance!.url, parsed);
    if (parsed.kind !== 'dashboard' || parsed.openInIde !== true) {
      return { grafanaUrl, openedInIde: false };
    }
    const opener = this.deps.openDashboardInIde;
    if (!opener) {
      return { grafanaUrl, openedInIde: false, message: 'IDE opener is not available.' };
    }
    try {
      await opener({
        instanceId: parsed.instanceId,
        uid: parsed.uid,
        title: parsed.title,
        search: buildOpenInIdeSearch(parsed) || undefined
      });
      return { grafanaUrl, openedInIde: true };
    } catch (error) {
      return { grafanaUrl, openedInIde: false, message: formatError(error) };
    }
  });
```

`withAuthorizedClient` already proved the instance exists; `instance!` is safe, or throw if missing.

`src/extension.ts` — add to the `GrafanaAgentToolService` constructor options (after `getQueryLimitsConfig`):

```ts
openDashboardInIde: async ({ instanceId, uid, title, search }) => {
  await vscode.commands.executeCommand('atGrafana.openDashboard', {
    instanceId,
    uid,
    title,
    search
  });
}
```

Register this **after** `atGrafana.openDashboard` is registered, or keep command registration order as today (openDashboard is registered later in `activate`). If the service is constructed **before** the command exists, `executeCommand` still works at call time (registration only needs to happen before the first invoke). Current code constructs the service before registering `openDashboard`; that is fine — the callback runs later.

- [ ] **Step 8: Run tests + typecheck — Expected PASS**

```bash
npx vitest run test/grafana/grafanaDeeplink.test.ts test/mcp/bridgeSchemas.test.ts \
  test/mcp/toolCatalog.test.ts test/agent/GrafanaAgentToolService.test.ts
npm run typecheck
```

- [ ] **Step 9: Commit**

```bash
git add src/grafana/grafanaDeeplink.ts src/mcp/bridgeSchemas.ts src/mcp/toolCatalog.ts \
  src/agent/GrafanaAgentToolService.ts src/extension.ts \
  test/grafana/grafanaDeeplink.test.ts test/mcp/bridgeSchemas.test.ts \
  test/mcp/toolCatalog.test.ts test/agent/GrafanaAgentToolService.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): add grafana_generate_deeplink with optional IDE open

Always return a Grafana URL; openInIde calls atGrafana.openDashboard
and still returns the URL if the Webview fails to open.
EOF
)"
```

---

### Task 6: Alert `states` filter

**Files:**
- Modify: `src/mcp/bridgeSchemas.ts` (`grafanaListAlertRulesSchema` + JSON twin)
- Modify: `src/mcp/toolCatalog.ts` (description)
- Modify: `src/agent/GrafanaAgentToolService.ts` (`listAlertRules(client, parsed)`)
- Test: `test/mcp/bridgeSchemas.test.ts`
- Test: `test/mcp/toolCatalog.test.ts` (remove `grafana_list_alert_rules` from `INSTANCE_ID_ONLY_TOOLS`)
- Test: `test/agent/GrafanaAgentToolService.test.ts`
- Test: `test/mcp/BridgeServer.integration.test.ts` (invoke with `states`)

- [ ] **Step 1: Write failing tests**

Remove `grafanaListAlertRulesSchema` from the instanceId-only schema loop if it is still there; add:

```ts
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
```

Next to the existing list_alert_rules service test:

```ts
it('grafana_list_alert_rules filters by normalized states after correlation', async () => {
  const client = fakeClient({
    listAlertRules: async () => [
      { uid: 'r1', title: 'A', folderUid: 'f1', ruleGroup: 'g1', condition: 'A', for: '1m' },
      { uid: 'r2', title: 'B', folderUid: 'f1', ruleGroup: 'g1', condition: 'A', for: '1m' }
    ],
    listAlertRuleStates: async () => [
      { uid: 'r1', name: 'A', state: 'firing', group: 'g1' },
      { uid: 'r2', name: 'B', state: 'pending', group: 'g1' }
    ]
  });
  const { service } = await makeService({ client });

  const result = await service.invoke('grafana_list_alert_rules', {
    instanceId: 'instance-1',
    states: ['firing']
  });

  expect(result).toMatchObject({
    ok: true,
    result: [{ uid: 'r1', state: 'firing' }]
  });
  expect((result as { result: unknown[] }).result).toHaveLength(1);
});
```

Existing unfiltered list_alert_rules test must still pass (omit `states`).

`test/mcp/BridgeServer.integration.test.ts`:

```ts
it('management family: POST /invoke grafana_list_alert_rules honors states=firing', async () => {
  const client = fakeClient({
    listAlertRules: async () => [
      { uid: 'r1', title: 'A', folderUid: 'f1', ruleGroup: 'g1', condition: 'A', for: '1m' },
      { uid: 'r2', title: 'B', folderUid: 'f1', ruleGroup: 'g1', condition: 'A', for: '1m' }
    ],
    listAlertRuleStates: async () => [
      { uid: 'r1', name: 'A', state: 'firing', group: 'g1' },
      { uid: 'r2', name: 'B', state: 'pending', group: 'g1' }
    ]
  });
  const handler = await makeHandler({ client });

  const response = await handler(
    invokeRequest('grafana_list_alert_rules', { instanceId: 'instance-1', states: ['firing'] })
  );

  expect(response.status).toBe(200);
  expect((response.body as { result: Array<{ uid: string }> }).result.map((rule) => rule.uid)).toEqual(['r1']);
});
```

- [ ] **Step 2: Run — Expected FAIL** (strict schema rejects `states`; list returns both rules)

```bash
npx vitest run test/mcp/bridgeSchemas.test.ts test/agent/GrafanaAgentToolService.test.ts
```

- [ ] **Step 3: Implement**

```ts
export const grafanaListAlertRulesSchema = z
  .object({
    instanceId: z.string().min(1),
    states: z.array(z.enum(['firing', 'pending', 'normal', 'unknown'])).min(1).optional()
  })
  .strict();
```

JSON Schema: replace `instanceIdOnlyInputSchema()` for list alert rules:

```ts
export const GRAFANA_LIST_ALERT_RULES_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', minLength: 1 },
    states: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: ['firing', 'pending', 'normal', 'unknown'] },
      description: 'Filter by normalized state after correlation. Omit to return every rule.'
    }
  },
  required: ['instanceId'],
  additionalProperties: false
};
```

Service invoke already uses `grafanaListAlertRulesSchema`; pass `parsed`:

```ts
case 'grafana_list_alert_rules':
  return await this.withAuthorizedClient(grafanaListAlertRulesSchema, args, (client, parsed) =>
    this.listAlertRules(client, parsed)
  );
```

```ts
private async listAlertRules(
  client: GrafanaApiClientLike,
  parsed: { states?: Array<'firing' | 'pending' | 'normal' | 'unknown'> }
): Promise<unknown> {
  const [rules, states] = await Promise.all([client.listAlertRules(), client.listAlertRuleStates()]);
  const stateIndex = buildAlertStateIndex(states);
  const mapped = rules.map((rule) => {
    const correlated = correlateAlertState(rule.uid, stateIndex);
    return {
      uid: rule.uid,
      title: rule.title,
      folderUid: rule.folderUid,
      ruleGroup: rule.ruleGroup,
      state: correlated.state,
      rawState: correlated.rawState,
      activeAt: correlated.activeAt
    };
  });
  if (parsed.states === undefined) {
    return mapped;
  }
  const allowed = new Set(parsed.states);
  return mapped.filter((rule) => allowed.has(rule.state));
}
```

Catalog description: mention optional `states` (`firing`/`pending`/`normal`/`unknown`); omit to list all.

Remove `'grafana_list_alert_rules'` from `INSTANCE_ID_ONLY_TOOLS` in `toolCatalog.test.ts`; add a schema assertion that `states` is documented.

- [ ] **Step 4: Run tests — Expected PASS**

```bash
npx vitest run test/mcp/bridgeSchemas.test.ts test/mcp/toolCatalog.test.ts \
  test/agent/GrafanaAgentToolService.test.ts test/mcp/BridgeServer.integration.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/mcp/bridgeSchemas.ts src/mcp/toolCatalog.ts src/agent/GrafanaAgentToolService.ts \
  test/mcp/bridgeSchemas.test.ts test/mcp/toolCatalog.test.ts \
  test/agent/GrafanaAgentToolService.test.ts test/mcp/BridgeServer.integration.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): filter grafana_list_alert_rules by normalized state

Optional states uses the same firing/pending/normal/unknown set as
the sidebar so agents need not ingest every rule.
EOF
)"
```

---

### Task 7: Skill + user docs (17 tools)

**Files:**
- Modify: `skills/at-grafana-mcp/references/tool-selection.md`
- Modify: `README.md`
- Modify: `docs/README.zh-CN.md`
- Modify: `docs/features.md`
- Modify: `docs/features.zh-CN.md`
- Modify: `docs/usage.md`
- Modify: `docs/usage.zh-CN.md`

Do **not** rewrite `docs/releases/0.1.0.md` or `docs/plans/2026-07-29-at-grafana-v1-implementation-plan.md`.

- [ ] **Step 1: Update tool-selection.md**

Replace the Live data table with:

```markdown
## Live data

| Need | Tool | Notes |
|---|---|---|
| Discover Prom metrics | `grafana_list_prometheus_metric_names` | Optional `regex`. If `truncated: true`, tighten regex. Do not dump an unbounded catalog. |
| Prom label values | `grafana_list_prometheus_label_values` | Required `label` (e.g. `job`). Optional `matcher`. |
| Loki labels | `grafana_list_loki_label_names` / `grafana_list_loki_label_values` | Then write LogQL. Prefer official `loki` skill for query language. |
| Prometheus query | `grafana_query_prometheus` | After discovery. Default `queryType: "range"`. Pass `start`/`end`/`step`. |
| Loki query | `grafana_query_loki` | `limit` 50–100; not `{job=~".+"}`. |
| Other datasource / unusual path | `grafana_query_datasource` | `GET`/`POST` only; path under the datasource proxy. |

Do not call `grafana_query_datasource` for ordinary PromQL/LogQL or for these four label/metric list paths.

## Annotations and links

| Need | Tool | Notes |
|---|---|---|
| Deploy / event markers | `grafana_list_annotations` | Optional `from`/`to` (epoch ms), `dashboardUid`, `tag`. Read-only. |
| Grafana URL | `grafana_generate_deeplink` | Always returns `grafanaUrl`. `openInIde: true` only for dashboards; default false. |
```

Under Alerts, add: pass `states: ["firing"]` (and/or `pending`) instead of listing every rule.

- [ ] **Step 2: Replace live “11” / “11 MCP tools” / “全部 11” / “Eleven tools” in the six user-facing files with 17.** List:

- Discovery: `grafana_list_instances`
- Management: existing six + `grafana_list_annotations` + `grafana_generate_deeplink` (mention `states` on alert list, `openInIde` default false)
- Monitoring: existing four + four discovery tools

Mirror EN ↔ zh-CN. Do not invent write tools.

- [ ] **Step 3: Commit**

```bash
git add skills/at-grafana-mcp/references/tool-selection.md README.md docs/README.zh-CN.md \
  docs/features.md docs/features.zh-CN.md docs/usage.md docs/usage.zh-CN.md
git commit -m "$(cat <<'EOF'
docs: document 17-tool P1 catalog

Point agents at label discovery, annotations, deeplink, and alert
state filters without duplicating PromQL tutorials.
EOF
)"
```

---

### Task 8: Final verification

- [ ] **Step 1: Full local gate**

```bash
npm run typecheck
npm test
```

Expected: typecheck clean; Vitest all green.

- [ ] **Step 2: Grep guardrails**

```bash
rg -n "exactly the 11|Eleven tools|11 MCP tools|全部 11|共 11" --glob '!docs/plans/**' --glob '!docs/releases/**' --glob '!docs/handoffs/**' --glob '!docs/specs/**'
```

Expected: no remaining live-catalog claims of 11 outside historical plans/releases/this spec.

```bash
rg -n "create_annotation|list_prometheus_metric_metadata" src
```

Expected: no matches.

- [ ] **Step 3: If anything failed, fix in a follow-up commit on this branch. Do not start write tools or P2 work.**

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 3.1–3.4 discovery tools | 2–3 |
| 3.5 annotations | 4 |
| 3.6 deeplink + openInIde | 5 |
| 3.7 alert states | 6 |
| Skill compose grafana/skills | already P0; Task 7 adds rows only |
| ADR-007 Accepted + requirements 17 | 1 |
| Out of scope | Task 8 grep |

**Placeholder scan:** no TBD / “similar to Task N” without inlined code.

**Type consistency:** `PROMETHEUS_LABEL_PATTERN`, `DISCOVERY_LIST_MAX = 200`, annotation `dashboardUid` → HTTP `dashboardUID`, deeplink `kind: 'dashboard' | 'explore'`, alert `states` union matches `NormalizedAlertState`, `openDashboardInIde` callback shape matches `atGrafana.openDashboard` args (`instanceId`, `uid`, `title`, `search`).
