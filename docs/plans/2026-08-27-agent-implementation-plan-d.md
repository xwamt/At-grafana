# AT Grafana 0.2.x 可执行计划 · Part D（Tasks 19–26）

> **Parent corrections (must follow):**
> 1. Canonical Grafana pin is **11.5.2** (Part A Task 5). Task 26 must not pin 13.x.
> 2. Current `docker-compose.smoke.yml` is unpinned (`image: grafana/grafana`) until T5. T26 Step 0: if T5 not done, apply T5's compose patch (11.5.2) — do not invent a third compose.
> 3. Favorites are LOCAL (globalState/workspaceState). Never Grafana `/api/user/stars` or `starred=true`.
> 4. ADR-008 stays Proposed; no POST silence code.
> 5. `GrafanaAgentToolService` must not import vscode.

> 执行前先读[索引](./2026-08-27-agent-implementation-plan.md)。本文件由 claude-fable-5-thinking-xhigh 子代理起草，父代理仅做交叉引用修正。
> **Canonical Grafana pin = 11.5.2 (Task 5).** Do not pin 13.x in this file.
> 分支：stack on `cursor/implement-optimizations-ef26`（或其后继，已含 Wave 0–3）。**禁止 `master`。**
> 每个任务收尾：`npm run typecheck && npm test`。改过 `package.nls.*` 后额外跑 `npx vitest run test/i18n/nls.test.ts`。

---

## Sequencing & file ownership (read before starting any task)

```
T19                    ── first (only Part D task touching bridgeSchemas/toolCatalog/GrafanaAgentToolService listings)
T20 → T21              ── strictly serial (T21 reuses T20's contextValue atGrafana.dashboardFavorite + menus)
T22                    ── after T21 (extension.ts / package.json / nls / GrafanaTreeItems all shared with T20/T21;
                          GrafanaAgentToolService shared with T19)
T23                    ── after T22 (DashboardTreeProvider/AlertTreeProvider shared with T20/T22)
T24, T25               ── docs only; any time, independent of everything
T26                    ── any time; Step 0 depends on whether Part A Task 5 already pinned the compose file
```

**Hot files in Part D — never edit the same file from two unfinished tasks:**

| File | Part D tasks that edit it |
|---|---|
| `src/extension.ts` | 20, 21, 22 |
| `package.json` (contributes) | 20, 21, 22 |
| `package.nls.json` / `package.nls.zh-cn.json` | 20, 21, 22 |
| `l10n/bundle.l10n.zh-cn.json` | 20, 21, 22, 23 |
| `src/tree/GrafanaTreeItems.ts` | 20, 22 |
| `src/tree/DashboardTreeProvider.ts` | 20, 23 |
| `src/tree/AlertTreeProvider.ts` | 23 |
| `src/agent/GrafanaAgentToolService.ts` | 19, 22 |
| `src/mcp/bridgeSchemas.ts` / `src/mcp/toolCatalog.ts` | 19, 22 (catalog only for 22) |
| `docker-compose.smoke.yml` | 26 (only if T5 has not pinned it — apply T5's patch verbatim) |

Also shared with **earlier parts** (check `git log` before starting): `extension.ts` is edited by Tasks 7/8/10/13/16; `bridgeSchemas.ts`/`toolCatalog.ts` by Tasks 2/8/16. Finish-and-commit discipline: one task, one commit (or a small commit series), then the next.

**Global rules (repeat of the index, enforced in every task below):**

1. User-visible strings go through `t()` + `l10n/bundle.l10n.zh-cn.json`; `contributes` titles use `%nls%` keys with twins in both `package.nls.json` and `package.nls.zh-cn.json`.
2. Agent tool *results* (hints, envelope messages) are **not** localized — they are English by convention, same as `UNAUTHORIZED_INSTANCE_MESSAGE` / `EMPTY_INSTANCES_HINT` in `GrafanaAgentToolService.ts` today.
3. `GrafanaAgentToolService`, `GrafanaDashboardsApi`, `grafanaDeeplink.ts`, and the new `dashboardBookmarks.ts` must not import `vscode`.
4. All tools stay `risk: 'read'`. Task 24 writes an ADR **document** about a future write tool; it ships zero code.
5. Steps marked **HUMAN** stay unchecked; do not fake DoD 1/2/3/9.

---

## Task 19 — Agent `list_dashboards` / `list_folders`: explicit `limit`/`page` + `truncated` envelope (NEXT-P-06)

**Goal.** On a large Grafana org, one `grafana_list_dashboards` call returns at most Grafana's default `/api/search` page and *says nothing* about having truncated — an agent cannot tell "not found" from "not on page 1". Add explicit `limit` (1–1000, default 1000) and `page` (default 1) inputs to `grafana_list_dashboards` and `grafana_list_folders`, and wrap both responses in an envelope that carries `truncated: true` + a next-page hint when a page comes back full. Default caps remain: the Agent path must **never** switch to `searchAll()`/`getAllFolders()` — bounded single-page reads are ADR-006's deliberate design; this task makes the bound *visible and steerable*, not unbounded.

**DoD.** Both schemas accept/default `limit`/`page`; both Grafana API methods forward them; both tools return `{ dashboards|folders, page, limit, truncated?, hint? }`; a full page ⇒ `truncated: true`; catalog descriptions + skill updated; ADR-006 carries a dated revision note; `npm run typecheck && npm test` green.

> **Breaking change, on purpose:** both tools previously returned a bare JSON array. Downstream MCP clients see the envelope from this commit on. The catalog description and ADR-006 revision note are the migration notice — there is no compatibility shim (an array-or-envelope union is worse for agents than a clean break).

### Files

| Path | Action |
|---|---|
| `src/mcp/bridgeSchemas.ts` | Patch (2 Zod schemas + 2 JSON Schema twins) |
| `src/grafana/GrafanaDashboardsApi.ts` | Patch (`GrafanaDashboardSearchQuery`, `search`, `getFolders`) |
| `src/grafana/GrafanaApiClient.ts` | Patch (`getFolders` facade signature) |
| `src/agent/GrafanaAgentToolService.ts` | Patch (`listDashboards`, new `listFolders` + `listingEnvelope`, dispatch) |
| `src/mcp/toolCatalog.ts` | Patch (2 descriptions) |
| `docs/decisions/ADR-006-typed-query-tools-and-context-defaults.md` | Patch (revision note) |
| `skills/at-grafana-mcp/references/tool-selection.md` | Patch (Dashboards table rows) |
| `test/mcp/bridgeSchemas.test.ts` | Patch |
| `test/grafana/GrafanaDashboardsApi.test.ts` | Patch |
| `test/agent/GrafanaAgentToolService.test.ts` | Patch |
| `test/mcp/toolCatalog.test.ts` | Patch |
| `test/mcp/BridgeServer.integration.test.ts` | Patch (response-shape assertions) |

- [ ] **Step 1: Zod schemas** — in `src/mcp/bridgeSchemas.ts`, the two schemas currently read:

```18:25:src/mcp/bridgeSchemas.ts
export const grafanaListDashboardsSchema = z
  .object({
    instanceId: z.string().min(1),
    query: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    folderUid: z.string().min(1).optional()
  })
  .strict();
```

```44:44:src/mcp/bridgeSchemas.ts
export const grafanaListFoldersSchema = z.object({ instanceId: z.string().min(1) }).strict();
```

Replace with:

```typescript
export const grafanaListDashboardsSchema = z
  .object({
    instanceId: z.string().min(1),
    query: z.string().min(1).optional(),
    tag: z.string().min(1).optional(),
    folderUid: z.string().min(1).optional(),
    // NEXT-P-06: explicit paging. Defaults mirror Grafana's own /api/search
    // default page size, so an argument-free call behaves exactly as before
    // (one bounded page) -- but the bound is now visible in the result.
    limit: z.number().int().positive().max(1000).default(1000),
    page: z.number().int().positive().default(1)
  })
  .strict();

export const grafanaListFoldersSchema = z
  .object({
    instanceId: z.string().min(1),
    limit: z.number().int().positive().max(1000).default(1000),
    page: z.number().int().positive().default(1)
  })
  .strict();
```

`max(1000)` keeps the per-call context bound: `/api/search` accepts up to 5000, but this catalog's job is bounded pages, not bigger dumps.

- [ ] **Step 2: JSON Schema twins** — same file, same commit (the file's own doc comment demands lockstep updates). `GRAFANA_LIST_DASHBOARDS_INPUT_SCHEMA` gains two properties (after `folderUid`):

```typescript
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      description: 'Rows per page (default 1000, Grafana /api/search default). The result echoes it back.'
    },
    page: {
      type: 'integer',
      minimum: 1,
      description: '1-based page forwarded to Grafana. Use with truncated: true to walk further pages.'
    }
```

`GRAFANA_LIST_FOLDERS_INPUT_SCHEMA` can no longer reuse `instanceIdOnlyInputSchema()` (line 386). Replace:

```386:386:src/mcp/bridgeSchemas.ts
export const GRAFANA_LIST_FOLDERS_INPUT_SCHEMA: JsonSchemaObject = instanceIdOnlyInputSchema();
```

with:

```typescript
export const GRAFANA_LIST_FOLDERS_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', minLength: 1 },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      description: 'Rows per page (default 1000, Grafana /api/folders default). The result echoes it back.'
    },
    page: {
      type: 'integer',
      minimum: 1,
      description: '1-based page forwarded to Grafana. Use with truncated: true to walk further pages.'
    }
  },
  required: ['instanceId'],
  additionalProperties: false
};
```

`instanceIdOnlyInputSchema()` keeps its other caller (`GRAFANA_LIST_DATASOURCES_INPUT_SCHEMA`); do not delete it.

- [ ] **Step 3: `GrafanaDashboardsApi`** — three edits in `src/grafana/GrafanaDashboardsApi.ts`.

(a) Extend the query interface (currently lines 34–41):

```typescript
export interface GrafanaDashboardSearchQuery {
  query?: string;
  type?: 'dash-db' | 'dash-folder';
  /** Single Grafana search `tag` parameter. */
  tag?: string;
  /** Mapped to Grafana `/api/search` `folderUIDs`. */
  folderUid?: string;
  /**
   * One-page paging for the Agent-facing `search()` (NEXT-P-06). `searchAll`
   * ignores both fields -- it drives its own pager and must not be steered
   * onto a partial walk.
   */
  limit?: number;
  page?: number;
}
```

(b) `search()` forwards them (keep the method doc, but soften "Deliberately left unpaged" to "Single-page by design; the caller may pick which page"):

```typescript
  async search(query: GrafanaDashboardSearchQuery = {}): Promise<GrafanaSearchResult[]> {
    const raw = await this.http.requestJson<unknown>('GET', '/api/search', {
      query: {
        query: query.query,
        type: query.type,
        tag: query.tag,
        folderUIDs: query.folderUid,
        limit: query.limit !== undefined ? String(query.limit) : undefined,
        page: query.page !== undefined ? String(query.page) : undefined
      },
      maxResponseBytes: MANAGEMENT_MAX_RESPONSE_BYTES
    });
    if (!Array.isArray(raw)) {
      throw new GrafanaApiError('invalid-response', 'Grafana /api/search did not return an array.');
    }
    return raw.map(toSearchResult);
  }
```

(`requestJson` already skips `undefined` query values — `search()` relies on that today for `query.query` etc.)

(c) `getFolders()` gains an options bag (currently lines 147–155):

```typescript
  /** One page of `/api/folders`; the Agent-facing counterpart of `search`. Single-page by design -- see `search`. */
  async getFolders(options: { limit?: number; page?: number } = {}): Promise<GrafanaFolder[]> {
    const raw = await this.http.requestJson<unknown>('GET', '/api/folders', {
      query: {
        limit: options.limit !== undefined ? String(options.limit) : undefined,
        page: options.page !== undefined ? String(options.page) : undefined
      },
      maxResponseBytes: MANAGEMENT_MAX_RESPONSE_BYTES
    });
    if (!Array.isArray(raw)) {
      throw new GrafanaApiError('invalid-response', 'Grafana /api/folders did not return an array.');
    }
    return raw.map(toFolder);
  }
```

Do **not** touch `searchAll` / `getAllFolders` / `collectPages` — the tree's completeness pager is a different animal and already correct.

- [ ] **Step 4: facade** — `src/grafana/GrafanaApiClient.ts` line 88–90 currently hardcodes a no-arg pass-through:

```88:90:src/grafana/GrafanaApiClient.ts
  getFolders(): ReturnType<GrafanaDashboardsApi['getFolders']> {
    return this.dashboardsApi.getFolders();
  }
```

Replace with the spread pattern its siblings use:

```typescript
  getFolders(...args: Parameters<GrafanaDashboardsApi['getFolders']>): ReturnType<GrafanaDashboardsApi['getFolders']> {
    return this.dashboardsApi.getFolders(...args);
  }
```

- [ ] **Step 5: service layer** — `src/agent/GrafanaAgentToolService.ts`.

(a) Dispatch: `grafana_list_folders` currently inlines the client call (line 252–253):

```252:253:src/agent/GrafanaAgentToolService.ts
        case 'grafana_list_folders':
          return await this.withAuthorizedClient(grafanaListFoldersSchema, args, (client) => client.getFolders());
```

becomes:

```typescript
        case 'grafana_list_folders':
          return await this.withAuthorizedClient(grafanaListFoldersSchema, args, (client, parsed) =>
            this.listFolders(client, parsed)
          );
```

(b) `listDashboards` (currently lines 453–480) forwards paging and wraps the projection:

```typescript
  private async listDashboards(
    client: GrafanaApiClientLike,
    parsed: { query?: string; tag?: string; folderUid?: string; limit: number; page: number }
  ): Promise<unknown> {
    // Near-duplicate of DashboardTreeProvider's folder grouping by design --
    // see the original comment (kept). Folder titles still come from ONE
    // unpaged /api/folders page: a folder beyond that page degrades to
    // folderTitle: undefined, never to a second pager on this bounded path.
    const [dashboards, folders] = await Promise.all([
      client.search({
        type: 'dash-db',
        query: parsed.query,
        tag: parsed.tag,
        folderUid: parsed.folderUid,
        limit: parsed.limit,
        page: parsed.page
      }),
      client.getFolders()
    ]);
    const folderTitleByUid = new Map(folders.map((folder) => [folder.uid, folder.title]));
    const items = dashboards.map((dashboard) => ({
      uid: dashboard.uid,
      title: dashboard.title,
      tags: dashboard.tags ?? [],
      folderUid: dashboard.folderUid,
      folderTitle: dashboard.folderUid ? folderTitleByUid.get(dashboard.folderUid) : undefined
    }));
    return this.listingEnvelope('dashboards', items, parsed);
  }
```

(c) New private methods, next to `listDashboards`:

```typescript
  private async listFolders(client: GrafanaApiClientLike, parsed: { limit: number; page: number }): Promise<unknown> {
    const folders = await client.getFolders({ limit: parsed.limit, page: parsed.page });
    return this.listingEnvelope('folders', folders, parsed);
  }

  /**
   * NEXT-P-06: Grafana /api/search and /api/folders return no total and no
   * next-page cursor -- "the page came back full" is the only more-may-exist
   * signal these APIs offer. The envelope turns silent truncation into a
   * visible, steerable one: a full page carries truncated: true plus a hint
   * naming the next page. Not localized -- tool results are English by the
   * same convention as every other hint in this class.
   */
  private listingEnvelope<Key extends string>(
    key: Key,
    rows: unknown[],
    parsed: { limit: number; page: number }
  ): Record<string, unknown> {
    const envelope: Record<string, unknown> = { [key]: rows, page: parsed.page, limit: parsed.limit };
    if (rows.length >= parsed.limit) {
      envelope.truncated = true;
      envelope.hint = `Page ${parsed.page} is full; more results may exist. Request page ${parsed.page + 1}, or narrow the search.`;
    }
    return envelope;
  }
```

Note: `truncated` is a *maybe* — a result set of exactly `limit` rows also trips it. That is the correct bias: the API gives no way to distinguish, and one extra (empty) page fetch is cheaper than a silently missing dashboard. Say so in the catalog description (next step).

- [ ] **Step 6: catalog descriptions** — `src/mcp/toolCatalog.ts`. Replace the `grafana_list_dashboards` description (lines 75–78) with:

```typescript
    description:
      'List one page of dashboards on a Grafana instance as { dashboards: [{uid, title, tags, folderUid, ' +
      'folderTitle}], page, limit, truncated?, hint? }. Optional query, tag, and folderUid narrow Grafana ' +
      '/api/search; optional limit (1-1000, default 1000) and page (default 1) select the page. truncated: true ' +
      'means the page came back full and more results MAY exist -- fetch the next page or narrow the query. ' +
      'Prefer a query over paging through a large instance.' +
      MANAGEMENT_FAMILY_SUFFIX,
```

and the `grafana_list_folders` description (line 96) with:

```typescript
    description:
      'List one page of the dashboard folder structure on a Grafana instance as { folders: [{uid, title, ' +
      'parentUid?}], page, limit, truncated?, hint? }. Optional limit (1-1000, default 1000) and page (default 1); ' +
      `truncated: true means more folders may exist on the next page.${MANAGEMENT_FAMILY_SUFFIX}`,
```

- [ ] **Step 7: ADR-006 revision note** — append to `docs/decisions/ADR-006-typed-query-tools-and-context-defaults.md` (after the Consequences section):

```markdown
## Revision note — 2026-08-27: explicit `limit`/`page` on Agent listings (NEXT-P-06)

Decision 2's "the Agent path stays on unpaged `search()`" remains true in the
sense that matters: one tool call still fetches exactly one bounded
`/api/search` (or `/api/folders`) page, never `searchAll()`. What changed is
that the bound is now explicit and steerable:

- `grafana_list_dashboards` and `grafana_list_folders` accept optional
  `limit` (1–1000, default 1000 — Grafana's own default page size) and
  `page` (default 1), forwarded verbatim to Grafana.
- **Breaking:** both tools now return an envelope
  `{ dashboards|folders, page, limit, truncated?, hint? }` instead of a bare
  array. When a page comes back full (`rows.length >= limit`) the envelope
  carries `truncated: true` and a hint naming the next page — Grafana's
  search/folders APIs expose no total and no cursor, so "full page" is the
  only more-may-exist signal available.
- Folder titles inside `grafana_list_dashboards` still come from a single
  unpaged `/api/folders` page; a folder beyond it degrades to
  `folderTitle: undefined` rather than triggering a second pager.
```

- [ ] **Step 8: skill** — in `skills/at-grafana-mcp/references/tool-selection.md`, Dashboards table: change the `Find dashboards` row's Notes to:

```markdown
| Find dashboards | `grafana_list_dashboards` | Pass `query` and/or `tag` / `folderUid`. Optional `limit`/`page`; the result is `{ dashboards, page, limit, truncated? }` — on `truncated: true`, fetch the next `page` or narrow. Do not list an entire large instance unfiltered. |
```

and the `Folder tree` row's Notes to:

```markdown
| Folder tree | `grafana_list_folders` | Returns `{ folders, page, limit, truncated? }`; page through only when `truncated: true`. |
```

- [ ] **Step 9: tests.**

`test/mcp/bridgeSchemas.test.ts` — add:

```typescript
describe('grafanaListDashboardsSchema paging (NEXT-P-06)', () => {
  it('defaults limit to 1000 and page to 1', () => {
    const parsed = grafanaListDashboardsSchema.parse({ instanceId: 'a' });
    expect(parsed.limit).toBe(1000);
    expect(parsed.page).toBe(1);
  });

  it('rejects limit 0, limit 1001, page 0, and non-integers', () => {
    expect(grafanaListDashboardsSchema.safeParse({ instanceId: 'a', limit: 0 }).success).toBe(false);
    expect(grafanaListDashboardsSchema.safeParse({ instanceId: 'a', limit: 1001 }).success).toBe(false);
    expect(grafanaListDashboardsSchema.safeParse({ instanceId: 'a', page: 0 }).success).toBe(false);
    expect(grafanaListDashboardsSchema.safeParse({ instanceId: 'a', page: 1.5 }).success).toBe(false);
  });
});

describe('grafanaListFoldersSchema paging (NEXT-P-06)', () => {
  it('defaults limit/page and stays strict', () => {
    const parsed = grafanaListFoldersSchema.parse({ instanceId: 'a' });
    expect(parsed).toEqual({ instanceId: 'a', limit: 1000, page: 1 });
    expect(grafanaListFoldersSchema.safeParse({ instanceId: 'a', nope: true }).success).toBe(false);
  });
});
```

`test/grafana/GrafanaDashboardsApi.test.ts` — following the file's existing fake-http capture pattern, add: `search({ limit: 50, page: 2 })` puts `limit=50&page=2` in the query; `getFolders({ limit: 10, page: 3 })` likewise; `getFolders()` with no args sends **neither** param. Also update the existing test at line 375 (`'leaves the Agent-facing getFolders() as a single unpaged request'`) — the invariant it protects is now "a single request" (assert exactly one `requestJson` call and no follow-up pages), so rename it to `'getFolders() stays a single request even when limit/page are passed'` and keep the one-call assertion.

`test/agent/GrafanaAgentToolService.test.ts` — the fake clients (`getFolders: async () => [...]`) remain structurally valid because the new parameter is optional. Update shape assertions:

- The test at line 201 (`'grafana_list_dashboards returns a flat list with folder titles resolved'`): the result is now `{ dashboards, page: 1, limit: 1000 }`; assert `result.dashboards` carries the old rows and `result.truncated` is `undefined`.
- The test at line 376 (`'grafana_list_folders passes through the client folder list'`): assert `{ folders, page: 1, limit: 1000 }` and that `getFolders` was called with `{ limit: 1000, page: 1 }`.
- New: `'grafana_list_dashboards marks a full page truncated with a next-page hint'` — fake `search` returns exactly 2 rows, invoke with `{ instanceId, limit: 2, page: 3 }`, expect `truncated: true`, `page: 3`, and `hint` containing `'page 4'`.
- New: `'grafana_list_dashboards forwards limit and page to search'` — capture the `search` argument, expect `limit: 25, page: 2`.
- The list_folders TLS-hint tests around lines 1341–1411 unwrap `result` directly today; change those assertions from the bare array to `result.folders` where they assert success shapes (the failure-path assertions are untouched).

`test/mcp/toolCatalog.test.ts` — `INSTANCE_ID_ONLY_TOOLS` (line 27) currently contains `grafana_list_folders`; remove it from that set and add assertions that both tools' `inputSchema.properties` include `limit` and `page` and their descriptions mention `truncated`.

`test/mcp/BridgeServer.integration.test.ts` — the invoke at line 284 asserts the old bare-array result; update to the envelope (`result.dashboards`).

- [ ] **Step 10: verify + commit**

```bash
npm run typecheck && npm test
git add src/mcp/bridgeSchemas.ts src/grafana/GrafanaDashboardsApi.ts src/grafana/GrafanaApiClient.ts \
  src/agent/GrafanaAgentToolService.ts src/mcp/toolCatalog.ts \
  docs/decisions/ADR-006-typed-query-tools-and-context-defaults.md \
  skills/at-grafana-mcp/references/tool-selection.md test/
git commit -m "$(cat <<'EOF'
feat(mcp): explicit limit/page and truncated envelope on list_dashboards/list_folders

NEXT-P-06. Breaking for agents: both tools now return
{ dashboards|folders, page, limit, truncated?, hint? } instead of a bare
array. Default caps unchanged (one bounded page; never searchAll).
ADR-006 revision note documents the envelope.
EOF
)"
```

---

## Task 20 — Local dashboard favorites + recents (NEXT-P-08 / NEXT-U-03)

**Goal.** Per-user "Favorites" and "Recent" groups under each instance in the Dashboards tree, with right-click add/remove. Storage is **local only**: favorites in `globalState` (they follow the user across workspaces, like the instance list), recents in `workspaceState` (what you were looking at is a property of the workspace). **Never** Grafana's `/api/user/stars` or `/api/search?starred=true` — the extension authenticates as a Service Account, which has no user stars; those endpoints would 404/return nothing.

**DoD.** New vscode-free `dashboardBookmarks.ts` module with tests; Favorites/Recent groups render (only when non-empty, hidden while the title filter is active); star icon + `atGrafana.dashboardFavorite` contextValue on favorited items; Add/Remove context-menu commands; opening a dashboard records a recent; no duplicate-TreeItem-id crash when the same dashboard shows in its folder *and* a group; existing Open-in-Browser/Copy-URL menus still appear on favorited items.

### Files

| Path | Action |
|---|---|
| `src/tree/dashboardBookmarks.ts` | **Create** |
| `src/tree/GrafanaTreeItems.ts` | Patch (`DashboardTreeItem` options, new `DashboardGroupTreeItem`, union) |
| `src/tree/DashboardTreeProvider.ts` | Patch (options, groups, `notifyBookmarksChanged`) |
| `src/extension.ts` | Patch (stores, 2 commands, recents recording) |
| `package.json` | Patch (2 commands, menus, **fix 2 context regexes**) |
| `package.nls.json` / `package.nls.zh-cn.json` | Patch (2 titles) |
| `l10n/bundle.l10n.zh-cn.json` | Patch (5 strings) |
| `test/tree/dashboardBookmarks.test.ts` | **Create** |
| `test/tree/GrafanaTreeItems.test.ts` | Patch |
| `test/tree/DashboardTreeProvider.test.ts` | Patch |

- [ ] **Step 1: bookmarks module (TDD)** — create `test/tree/dashboardBookmarks.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_FAVORITES_STATE_KEY,
  DashboardFavorites,
  MAX_RECENT_DASHBOARDS,
  RECENT_DASHBOARDS_STATE_KEY,
  RecentDashboards,
  type BookmarksMemento
} from '../../src/tree/dashboardBookmarks';

class MemoryMemento implements BookmarksMemento {
  private readonly store = new Map<string, unknown>();
  get<T>(key: string, defaultValue: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

describe('DashboardFavorites', () => {
  it('adds, reports, and removes a favorite per instance', async () => {
    const favorites = new DashboardFavorites(new MemoryMemento());
    await favorites.add({ instanceId: 'i1', uid: 'd1', title: 'API latency' });
    expect(favorites.isFavorite('i1', 'd1')).toBe(true);
    expect(favorites.isFavorite('i2', 'd1')).toBe(false);
    expect(favorites.list('i1')).toHaveLength(1);
    await favorites.remove('i1', 'd1');
    expect(favorites.isFavorite('i1', 'd1')).toBe(false);
  });

  it('re-adding the same dashboard does not duplicate it', async () => {
    const favorites = new DashboardFavorites(new MemoryMemento());
    await favorites.add({ instanceId: 'i1', uid: 'd1', title: 'v1' });
    await favorites.add({ instanceId: 'i1', uid: 'd1', title: 'v2' });
    expect(favorites.list('i1')).toHaveLength(1);
    expect(favorites.list('i1')[0]?.title).toBe('v2');
  });

  it('ignores malformed persisted entries instead of throwing', () => {
    const memento = new MemoryMemento();
    void memento.update(DASHBOARD_FAVORITES_STATE_KEY, [null, 42, { uid: 'no-instance' }, { instanceId: 'i1', uid: 'd1', title: 't' }]);
    expect(new DashboardFavorites(memento).list()).toHaveLength(1);
  });
});

describe('RecentDashboards', () => {
  it('records most-recent-first, dedupes, and caps at MAX_RECENT_DASHBOARDS', async () => {
    const recents = new RecentDashboards(new MemoryMemento());
    for (let i = 0; i < MAX_RECENT_DASHBOARDS + 3; i++) {
      await recents.record({ instanceId: 'i1', uid: `d${i}`, title: `t${i}` });
    }
    await recents.record({ instanceId: 'i1', uid: 'd5', title: 't5-again' });
    const list = recents.list('i1');
    expect(list).toHaveLength(MAX_RECENT_DASHBOARDS);
    expect(list[0]).toMatchObject({ uid: 'd5', title: 't5-again' });
    expect(list.filter((entry) => entry.uid === 'd5')).toHaveLength(1);
  });

  it('uses a different state key than favorites', () => {
    expect(RECENT_DASHBOARDS_STATE_KEY).not.toBe(DASHBOARD_FAVORITES_STATE_KEY);
  });
});
```

- [ ] **Step 2: implement** — create `src/tree/dashboardBookmarks.ts` (no `vscode` import):

```typescript
/**
 * Local (IDE-side) dashboard favorites and recents (NEXT-P-08 / NEXT-U-03).
 *
 * Deliberately NOT Grafana's star API: `/api/user/stars` and
 * `/api/search?starred=true` are per-*user* surfaces, and this extension
 * authenticates as a Service Account, which has no user stars. Favorites
 * live in `globalState` (same store as the instance list, so they follow
 * the user across workspaces); recents live in `workspaceState`. The stores
 * accept any Memento-shaped object so tests pass a Map-backed fake and this
 * module stays vscode-free.
 */

/** The slice of `vscode.Memento` both stores need (same shape as `FilterMemento` in DashboardTreeProvider). */
export interface BookmarksMemento {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

export interface DashboardBookmark {
  instanceId: string;
  uid: string;
  title: string;
  /** The tree item's Grafana-relative URL when known; feeds slug/search on open. */
  url?: string;
}

export const DASHBOARD_FAVORITES_STATE_KEY = 'atGrafana.dashboardFavorites';
export const RECENT_DASHBOARDS_STATE_KEY = 'atGrafana.recentDashboards';

/** Recents are a short "what was I just looking at" strip, not a history. */
export const MAX_RECENT_DASHBOARDS = 10;

function isBookmark(value: unknown): value is DashboardBookmark {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.instanceId === 'string' &&
    typeof candidate.uid === 'string' &&
    typeof candidate.title === 'string' &&
    (candidate.url === undefined || typeof candidate.url === 'string')
  );
}

/** Persisted state is user-editable disk data -- filter instead of trusting it. */
function readBookmarks(memento: BookmarksMemento, key: string): DashboardBookmark[] {
  const raw = memento.get<unknown[]>(key, []);
  return Array.isArray(raw) ? raw.filter(isBookmark) : [];
}

export class DashboardFavorites {
  constructor(private readonly memento: BookmarksMemento) {}

  list(instanceId?: string): DashboardBookmark[] {
    const all = readBookmarks(this.memento, DASHBOARD_FAVORITES_STATE_KEY);
    return instanceId === undefined ? all : all.filter((bookmark) => bookmark.instanceId === instanceId);
  }

  isFavorite(instanceId: string, uid: string): boolean {
    return this.list(instanceId).some((bookmark) => bookmark.uid === uid);
  }

  async add(bookmark: DashboardBookmark): Promise<void> {
    const rest = this.list().filter(
      (entry) => !(entry.instanceId === bookmark.instanceId && entry.uid === bookmark.uid)
    );
    await this.memento.update(DASHBOARD_FAVORITES_STATE_KEY, [...rest, bookmark]);
  }

  async remove(instanceId: string, uid: string): Promise<void> {
    await this.memento.update(
      DASHBOARD_FAVORITES_STATE_KEY,
      this.list().filter((entry) => !(entry.instanceId === instanceId && entry.uid === uid))
    );
  }
}

export class RecentDashboards {
  constructor(private readonly memento: BookmarksMemento) {}

  list(instanceId?: string): DashboardBookmark[] {
    const all = readBookmarks(this.memento, RECENT_DASHBOARDS_STATE_KEY);
    return instanceId === undefined ? all : all.filter((bookmark) => bookmark.instanceId === instanceId);
  }

  /** Most-recent-first, deduplicated by instanceId+uid, capped at MAX_RECENT_DASHBOARDS. */
  async record(bookmark: DashboardBookmark): Promise<void> {
    const rest = this.list().filter(
      (entry) => !(entry.instanceId === bookmark.instanceId && entry.uid === bookmark.uid)
    );
    await this.memento.update(RECENT_DASHBOARDS_STATE_KEY, [bookmark, ...rest].slice(0, MAX_RECENT_DASHBOARDS));
  }
}
```

- [ ] **Step 3: tree items** — `src/tree/GrafanaTreeItems.ts`. Replace `DashboardTreeItem` (currently lines 92–105):

```typescript
export interface DashboardTreeItemOptions {
  /** Star icon + `atGrafana.dashboardFavorite` contextValue (drives the Remove-from-Favorites menu). */
  favorite?: boolean;
  /**
   * TreeItem ids must be unique per view. The same dashboard rendered inside
   * the Favorites/Recent group AND inside its real folder would collide on
   * the default id and VS Code rejects the tree -- group renderings pass
   * their own prefix.
   */
  idPrefix?: string;
}

export class DashboardTreeItem extends vscode.TreeItem {
  constructor(
    public readonly instance: GrafanaInstanceConfig,
    public readonly uid: string,
    public readonly dashboardTitle: string,
    public readonly url?: string,
    options: DashboardTreeItemOptions = {}
  ) {
    super(dashboardTitle, vscode.TreeItemCollapsibleState.None);
    this.id = `${options.idPrefix ?? 'atGrafana.dashboard'}:${instance.id}:${uid}`;
    this.contextValue = options.favorite === true ? 'atGrafana.dashboardFavorite' : 'atGrafana.dashboard';
    this.iconPath = new vscode.ThemeIcon(options.favorite === true ? 'star-full' : 'dashboard');
    this.tooltip = url ?? dashboardTitle;
    this.command = {
      command: 'atGrafana.openDashboard',
      title: t('Open Dashboard'),
      arguments: [{ instanceId: instance.id, uid, title: dashboardTitle, ...dashboardRouteFromUrl(url) }]
    };
  }
}
```

(The `title` constructor parameter becomes the public `dashboardTitle` and `url` becomes public — every existing call site passes them positionally, so nothing else breaks; `extension.ts`'s `grafanaUrlFromTreeItem` is unaffected.)

Add the group item after `FolderTreeItem`:

```typescript
export type DashboardGroupKind = 'favorites' | 'recents';

/** The synthetic "Favorites" / "Recent" group under an instance (NEXT-U-03). */
export class DashboardGroupTreeItem extends vscode.TreeItem {
  constructor(
    public readonly instance: GrafanaInstanceConfig,
    public readonly kind: DashboardGroupKind,
    label: string,
    count: number
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `atGrafana.dashboardGroup:${instance.id}:${kind}`;
    this.contextValue = 'atGrafana.dashboardGroup';
    this.iconPath = new vscode.ThemeIcon(kind === 'favorites' ? 'star-full' : 'history');
    this.description = String(count);
  }
}
```

and extend the union at the bottom of the file:

```typescript
export type GrafanaTreeItem =
  | InstanceTreeItem
  | FolderTreeItem
  | DashboardTreeItem
  | DashboardGroupTreeItem
  | AlertGroupTreeItem
  | AlertRuleTreeItem
  | MessageTreeItem
  | ErrorTreeItem;
```

- [ ] **Step 4: provider** — `src/tree/DashboardTreeProvider.ts`.

(a) Imports: add `DashboardGroupTreeItem` to the `./GrafanaTreeItems` import and

```typescript
import type { DashboardFavorites, RecentDashboards } from './dashboardBookmarks';
```

(b) Options (currently lines 33–38):

```typescript
export interface DashboardTreeProviderOptions {
  /** `context.workspaceState`; when set, the title filter survives a window reload. */
  workspaceState?: FilterMemento;
  /** Folders promise cache shared with AlertTreeProvider (PERF-04). */
  sharedReads?: SharedGrafanaReads;
  /** Local favorites store (globalState-backed); when set, non-empty instances get a Favorites group. */
  favorites?: DashboardFavorites;
  /** Local recents store (workspaceState-backed); when set, non-empty instances get a Recent group. */
  recents?: RecentDashboards;
}
```

(c) Fields + constructor: store `this.favorites = options.favorites;` / `this.recents = options.recents;` alongside `workspaceState`.

(d) `getChildren` dispatch — add before the `FolderTreeItem` branch:

```typescript
    if (element instanceof DashboardGroupTreeItem) {
      return this.getGroupChildren(element);
    }
```

(e) In `getInstanceChildren`, immediately before the final `if (items.length === 0)` check of the **unfiltered** path (i.e. after the `General` push at lines 190–192), prepend the groups. While the title filter is active the groups stay hidden — bookmarks are shortcuts, not search results:

```typescript
    const groups: GrafanaTreeItem[] = [];
    const favoriteCount = this.favorites?.list(instance.id).length ?? 0;
    if (favoriteCount > 0) {
      groups.push(new DashboardGroupTreeItem(instance, 'favorites', t('Favorites'), favoriteCount));
    }
    const recentCount = this.recents?.list(instance.id).length ?? 0;
    if (recentCount > 0) {
      groups.push(new DashboardGroupTreeItem(instance, 'recents', t('Recent'), recentCount));
    }
    items.unshift(...groups);
```

(f) New methods:

```typescript
  private getGroupChildren(element: DashboardGroupTreeItem): GrafanaTreeItem[] {
    const store = element.kind === 'favorites' ? this.favorites : this.recents;
    const bookmarks = store?.list(element.instance.id) ?? [];
    if (bookmarks.length === 0) {
      return [new MessageTreeItem(t('Nothing here yet.'))];
    }
    // Rendered from the stored bookmark (title/url captured at add time), so
    // the group works even before -- or without -- the instance fetch. A
    // renamed dashboard shows its old title until re-favorited; accepted.
    const idPrefix = element.kind === 'favorites' ? 'atGrafana.favoriteDashboard' : 'atGrafana.recentDashboard';
    return bookmarks.map(
      (bookmark) =>
        new DashboardTreeItem(element.instance, bookmark.uid, bookmark.title, bookmark.url, {
          favorite: this.favorites?.isFavorite(bookmark.instanceId, bookmark.uid) ?? false,
          idPrefix
        })
    );
  }

  /** Favorites/recents changed: re-render from the stores without dropping the fetched dashboard cache. */
  notifyBookmarksChanged(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }
```

(g) Folder children get the star state too — in `getFolderChildren`, the `DashboardTreeItem` construction (currently lines 223–225) becomes:

```typescript
      ...dashboards.map(
        (entry) =>
          new DashboardTreeItem(instance, entry.dashboard.uid, entry.dashboard.title, entry.dashboard.url, {
            favorite: this.favorites?.isFavorite(instance.id, entry.dashboard.uid) ?? false
          })
      )
```

- [ ] **Step 5: extension wiring** — `src/extension.ts`.

(a) Imports:

```typescript
import { DashboardFavorites, RecentDashboards } from './tree/dashboardBookmarks';
```

(b) Before the `dashboardTreeProvider` construction (line 106):

```typescript
  const dashboardFavorites = new DashboardFavorites(context.globalState);
  const recentDashboards = new RecentDashboards(context.workspaceState);
```

and extend the provider options (lines 106–110):

```typescript
  const dashboardTreeProvider = new DashboardTreeProvider(
    configManager,
    (instance) => createGrafanaClient(configManager, instance, certTrustStore, log),
    {
      workspaceState: context.workspaceState,
      sharedReads: sharedGrafanaReads,
      favorites: dashboardFavorites,
      recents: recentDashboards
    }
  );
```

(c) New commands (next to the other context-menu commands):

```typescript
  const addDashboardFavoriteCommand = vscode.commands.registerCommand(
    'atGrafana.addDashboardFavorite',
    async (arg?: unknown) => {
      if (!(arg instanceof DashboardTreeItem)) {
        showWarningNotification(t('Right-click a dashboard in the AT Grafana sidebar to add a favorite.'));
        return;
      }
      await dashboardFavorites.add({
        instanceId: arg.instance.id,
        uid: arg.uid,
        title: arg.dashboardTitle,
        url: arg.url
      });
      dashboardTreeProvider.notifyBookmarksChanged();
    }
  );

  const removeDashboardFavoriteCommand = vscode.commands.registerCommand(
    'atGrafana.removeDashboardFavorite',
    async (arg?: unknown) => {
      if (!(arg instanceof DashboardTreeItem)) {
        return;
      }
      await dashboardFavorites.remove(arg.instance.id, arg.uid);
      dashboardTreeProvider.notifyBookmarksChanged();
    }
  );
```

(d) Recents recording — the `atGrafana.openDashboard` handler (lines 431–446) gains a prologue before `openGrafanaEmbedPanel`:

```typescript
      if (args?.instanceId && args?.uid) {
        // Recorded before the open (not after success): "I tried to look at
        // this" is exactly what Recent is for, and a TLS/token failure would
        // otherwise silently drop the trail.
        await recentDashboards.record({
          instanceId: args.instanceId,
          uid: args.uid,
          title: args.title ?? args.uid
        });
        dashboardTreeProvider.notifyBookmarksChanged();
      }
```

(e) Push both new commands into `context.subscriptions`.

- [ ] **Step 6: `package.json`** — three edits.

(a) `contributes.commands` — add:

```json
      {
        "command": "atGrafana.addDashboardFavorite",
        "title": "%atGrafana.command.addDashboardFavorite.title%",
        "icon": "$(star-empty)"
      },
      {
        "command": "atGrafana.removeDashboardFavorite",
        "title": "%atGrafana.command.removeDashboardFavorite.title%",
        "icon": "$(star-full)"
      }
```

(b) `menus."view/item/context"` — add:

```json
        {
          "command": "atGrafana.addDashboardFavorite",
          "when": "view == atGrafana.dashboards && viewItem == atGrafana.dashboard",
          "group": "3_bookmarks@1"
        },
        {
          "command": "atGrafana.removeDashboardFavorite",
          "when": "view == atGrafana.dashboards && viewItem == atGrafana.dashboardFavorite",
          "group": "3_bookmarks@1"
        }
```

(c) **Fix the two existing context regexes** — `atGrafana.openInBrowser` and `atGrafana.copyGrafanaUrl` (lines 183 and 188) are `$`-anchored and would silently stop matching favorited items:

```json
"when": "view =~ /^atGrafana\\.(dashboards|alerts)$/ && viewItem =~ /^atGrafana\\.(instance|dashboard|dashboardFavorite|alertRule)$/"
```

(both entries). Add both new commands to `menus.commandPalette` with `"when": "false"` (they only make sense on a tree item).

- [ ] **Step 7: nls + l10n.**

`package.nls.json`:

```json
  "atGrafana.command.addDashboardFavorite.title": "Add to Favorites",
  "atGrafana.command.removeDashboardFavorite.title": "Remove from Favorites",
```

`package.nls.zh-cn.json`:

```json
  "atGrafana.command.addDashboardFavorite.title": "添加到收藏",
  "atGrafana.command.removeDashboardFavorite.title": "从收藏中移除",
```

`l10n/bundle.l10n.zh-cn.json`:

```json
  "Favorites": "收藏",
  "Recent": "最近打开",
  "Nothing here yet.": "这里还没有内容。",
  "Right-click a dashboard in the AT Grafana sidebar to add a favorite.": "请在 AT Grafana 侧边栏中右键点击一个仪表盘以添加收藏。",
```

- [ ] **Step 8: tests.**

`test/tree/GrafanaTreeItems.test.ts` — add: default `DashboardTreeItem` keeps `contextValue 'atGrafana.dashboard'` and id `atGrafana.dashboard:<instance>:<uid>`; with `{ favorite: true }` the contextValue is `'atGrafana.dashboardFavorite'` and the icon id is `star-full`; with `{ idPrefix: 'atGrafana.favoriteDashboard' }` the id starts with that prefix (so it cannot collide with the folder rendering); `DashboardGroupTreeItem` id embeds instance + kind and `contextValue` is `'atGrafana.dashboardGroup'`.

`test/tree/DashboardTreeProvider.test.ts` — following the file's existing fake-client pattern, add a `describe('bookmark groups (NEXT-U-03)')`:

- Provider constructed with `favorites`/`recents` stores holding one entry each for `inst-1` ⇒ instance children start with two `DashboardGroupTreeItem`s (favorites first), before folders.
- Empty stores ⇒ no group items.
- `getChildren(favoritesGroup)` returns one `DashboardTreeItem` with `contextValue 'atGrafana.dashboardFavorite'` and an id starting `atGrafana.favoriteDashboard:`.
- With an active filter (`setFilter('x')`) the groups are absent.
- A dashboard whose uid is favorited renders inside its folder with `contextValue 'atGrafana.dashboardFavorite'` but the **default** id prefix (no collision with the group rendering).

- [ ] **Step 9: verify + commit**

```bash
npm run typecheck && npm test && npx vitest run test/i18n/nls.test.ts
git add src/tree/dashboardBookmarks.ts src/tree/GrafanaTreeItems.ts src/tree/DashboardTreeProvider.ts \
  src/extension.ts package.json package.nls.json package.nls.zh-cn.json l10n/bundle.l10n.zh-cn.json test/
git commit -m "$(cat <<'EOF'
feat(tree): local dashboard favorites and recents

NEXT-P-08 / NEXT-U-03. Favorites in globalState, recents in
workspaceState (never Grafana /api/user/stars -- Service Accounts have
no user stars). Group renderings use distinct TreeItem id prefixes so a
dashboard can appear in its folder and a group simultaneously.
EOF
)"
```

---

## Task 21 — Right-click "Open with Time Range" (NEXT-U-04)

**Goal.** The `from`/`to` pipeline already exists end-to-end: `buildOpenInIdeSearch({ from, to })` → `openDashboard` `search` arg → `DashboardPanel` → embed URL. What is missing is any UI entry. Add a context-menu command on dashboard items (plain **and** favorited) that shows a QuickPick of presets — last 5m / 1h / 6h / 24h / 7d — plus a Custom option (two input boxes accepting Grafana time syntax), then delegates to the existing `atGrafana.openDashboard` command with the composed `search` string.

**Runs strictly after Task 20** (shares `package.json` menus, `extension.ts`, and matches the `dashboardFavorite` contextValue).

**DoD.** New command opens the panel with `from`/`to` in the embed search; ESC at any prompt aborts without opening; menu appears on both `atGrafana.dashboard` and `atGrafana.dashboardFavorite` items; nls twins + l10n complete; typecheck+test green.

### Files

| Path | Action |
|---|---|
| `src/extension.ts` | Patch (presets + command) |
| `package.json` | Patch (command + menu + palette-false) |
| `package.nls.json` / `package.nls.zh-cn.json` | Patch (1 title) |
| `l10n/bundle.l10n.zh-cn.json` | Patch (~9 strings) |
| `test/extension/PanelCommands.test.ts` | Patch |

- [ ] **Step 1: command implementation** — `src/extension.ts`.

(a) Import the existing pure builder (vscode-free, already used by `GrafanaAgentToolService`):

```typescript
import { buildOpenInIdeSearch } from './grafana/grafanaDeeplink';
```

(b) Register (next to `openDashboardCommand`):

```typescript
  // NEXT-U-04: presets are the five ranges SREs actually flip between; the
  // custom path passes raw Grafana time syntax (now-2d, ISO, epoch ms)
  // through unvalidated -- Grafana itself is the authority on parsing it.
  const openDashboardWithTimeRangeCommand = vscode.commands.registerCommand(
    'atGrafana.openDashboardWithTimeRange',
    async (arg?: unknown) => {
      if (!(arg instanceof DashboardTreeItem)) {
        showWarningNotification(t('Right-click a dashboard in the AT Grafana sidebar to pick a time range.'));
        return;
      }
      const presets: Array<{ label: string; from?: string; to?: string }> = [
        { label: t('Last 5 minutes'), from: 'now-5m', to: 'now' },
        { label: t('Last 1 hour'), from: 'now-1h', to: 'now' },
        { label: t('Last 6 hours'), from: 'now-6h', to: 'now' },
        { label: t('Last 24 hours'), from: 'now-24h', to: 'now' },
        { label: t('Last 7 days'), from: 'now-7d', to: 'now' },
        { label: t('Custom range...') }
      ];
      const picked = await vscode.window.showQuickPick(presets, {
        placeHolder: t('Open "{title}" with which time range?', { title: arg.dashboardTitle })
      });
      if (!picked) {
        return;
      }
      let from = picked.from;
      let to = picked.to;
      if (from === undefined) {
        from = await vscode.window.showInputBox({
          prompt: t('From (Grafana time, e.g. now-2d or an ISO timestamp)'),
          value: 'now-1h'
        });
        if (from === undefined) {
          return;
        }
        to = await vscode.window.showInputBox({
          prompt: t('To (Grafana time, e.g. now)'),
          value: 'now'
        });
        if (to === undefined) {
          return;
        }
      }
      const search = buildOpenInIdeSearch({ from: from || undefined, to: to || undefined });
      // Delegate to the existing command: reuses the token/TLS gate, the
      // panel plumbing, and Task 20's recents recording in one place.
      await vscode.commands.executeCommand('atGrafana.openDashboard', {
        instanceId: arg.instance.id,
        uid: arg.uid,
        title: arg.dashboardTitle,
        search: search || undefined
      });
    }
  );
```

(c) Push into `context.subscriptions`.

- [ ] **Step 2: `package.json`.**

`contributes.commands`:

```json
      {
        "command": "atGrafana.openDashboardWithTimeRange",
        "title": "%atGrafana.command.openDashboardWithTimeRange.title%",
        "icon": "$(clock)"
      }
```

`menus."view/item/context"` (works on plain and favorited dashboards — this regex is why T21 is serial after T20):

```json
        {
          "command": "atGrafana.openDashboardWithTimeRange",
          "when": "view == atGrafana.dashboards && viewItem =~ /^atGrafana\\.(dashboard|dashboardFavorite)$/",
          "group": "2_open@3"
        }
```

`menus.commandPalette`: `{ "command": "atGrafana.openDashboardWithTimeRange", "when": "false" }`.

- [ ] **Step 3: nls + l10n.**

`package.nls.json`: `"atGrafana.command.openDashboardWithTimeRange.title": "Open with Time Range..."`
`package.nls.zh-cn.json`: `"atGrafana.command.openDashboardWithTimeRange.title": "按时间范围打开…"`

`l10n/bundle.l10n.zh-cn.json`:

```json
  "Last 5 minutes": "最近 5 分钟",
  "Last 1 hour": "最近 1 小时",
  "Last 6 hours": "最近 6 小时",
  "Last 24 hours": "最近 24 小时",
  "Last 7 days": "最近 7 天",
  "Custom range...": "自定义范围…",
  "Open \"{title}\" with which time range?": "以哪个时间范围打开「{title}」？",
  "From (Grafana time, e.g. now-2d or an ISO timestamp)": "起始（Grafana 时间语法，例如 now-2d 或 ISO 时间戳）",
  "To (Grafana time, e.g. now)": "结束（Grafana 时间语法，例如 now）",
  "Right-click a dashboard in the AT Grafana sidebar to pick a time range.": "请在 AT Grafana 侧边栏中右键点击一个仪表盘以选择时间范围。",
```

- [ ] **Step 4: tests** — extend `test/extension/PanelCommands.test.ts` (it already captures `registerCommand` handlers into a Map and runs against the `test-fixtures/vscode.ts` alias):

```typescript
import { DashboardTreeItem } from '../../src/tree/GrafanaTreeItems';

describe('atGrafana.openDashboardWithTimeRange (NEXT-U-04)', () => {
  const instance = {
    id: 'inst-1',
    label: 'Grafana One',
    url: 'http://127.0.0.1:3000',
    allowBackgroundAccess: false,
    createdAt: 1,
    updatedAt: 1
  };

  it('opens via atGrafana.openDashboard with the preset from/to in search', async () => {
    activate(extensionContext());
    const executeCommand = vi
      .spyOn(vscode.commands, 'executeCommand')
      .mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(
      async (items: readonly unknown[]) => (items as Array<{ label: string }>).find((i) => i.label === 'Last 1 hour')
    );

    await registeredCommands.get('atGrafana.openDashboardWithTimeRange')?.(
      new DashboardTreeItem(instance, 'uid-1', 'My Dashboard')
    );

    expect(executeCommand).toHaveBeenCalledWith('atGrafana.openDashboard', {
      instanceId: 'inst-1',
      uid: 'uid-1',
      title: 'My Dashboard',
      search: 'from=now-1h&to=now'
    });
  });

  it('aborts without opening when the QuickPick is dismissed', async () => {
    activate(extensionContext());
    const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as never);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);

    await registeredCommands.get('atGrafana.openDashboardWithTimeRange')?.(
      new DashboardTreeItem(instance, 'uid-1', 'My Dashboard')
    );

    expect(executeCommand).not.toHaveBeenCalledWith('atGrafana.openDashboard', expect.anything());
  });
});
```

(Adapt spies to whatever `test-fixtures/vscode.ts` exposes — `showQuickPick`/`showInputBox` must exist or be added there as `vi.fn()`-backed stubs following the fixture's existing conventions. Note `vscode.commands.executeCommand` is also called by the provider's `setContext`; assert on the `'atGrafana.openDashboard'` call specifically, as above.)

- [ ] **Step 5: verify + commit**

```bash
npm run typecheck && npm test && npx vitest run test/i18n/nls.test.ts
git add src/extension.ts package.json package.nls.json package.nls.zh-cn.json \
  l10n/bundle.l10n.zh-cn.json test/extension/PanelCommands.test.ts
git commit -m "$(cat <<'EOF'
feat(tree): right-click open dashboard with a time range preset

NEXT-U-04. QuickPick presets 5m/1h/6h/24h/7d plus a custom from/to path;
delegates to atGrafana.openDashboard so the existing deeplink search
pipeline, TLS gate, and recents recording are reused unchanged.
EOF
)"
```

---

## Task 22 — Default instance + `list_instances.isDefault` (NEXT-U-08)

**Goal.** With several instances configured, both humans and agents currently have to guess which one is "the" one. Add an `isDefault` marker: config schema field, single-default invariant in `GrafanaInstanceConfigManager`, a `Default` badge on the instance tree item, a toggle context-menu command, and `isDefault` in the `grafana_list_instances` projection (always a boolean) with a catalog-description nudge to prefer it.

**Runs after Task 21** (shares `extension.ts`, `package.json`, nls, `GrafanaTreeItems.ts`; shares `GrafanaAgentToolService.ts` with Task 19).

**DoD.** `setDefaultInstance`/`clearDefaultInstance` maintain at-most-one default; persisted pre-`isDefault` configs still parse; tree badge renders; toggle command works from both tree views; `grafana_list_instances` rows carry `isDefault`; skill mentions it; typecheck+test green.

### Files

| Path | Action |
|---|---|
| `src/config/schema.ts` | Patch |
| `src/config/GrafanaInstanceConfigManager.ts` | Patch (2 methods) |
| `src/tree/GrafanaTreeItems.ts` | Patch (`InstanceTreeItem`) |
| `src/agent/GrafanaAgentToolService.ts` | Patch (`listInstances` projection) |
| `src/mcp/toolCatalog.ts` | Patch (`grafana_list_instances` description) |
| `src/extension.ts` | Patch (toggle command) |
| `package.json` | Patch (command + menu) |
| `package.nls.json` / `package.nls.zh-cn.json` | Patch |
| `l10n/bundle.l10n.zh-cn.json` | Patch |
| `skills/at-grafana-mcp/references/tool-selection.md` | Patch |
| `test/config/schema.test.ts`, `test/config/GrafanaInstanceConfigManager.test.ts`, `test/tree/GrafanaTreeItems.test.ts`, `test/agent/GrafanaAgentToolService.test.ts`, `test/mcp/toolCatalog.test.ts`, `test/extension/InstanceCommands.test.ts` | Patch |

- [ ] **Step 1: schema** — `src/config/schema.ts`. The field must be **optional**: every already-persisted instance list lacks it, and the schema is `.strict()`-parsed on every read, so a required field would brick existing installs.

```typescript
export const grafanaInstanceConfigSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    url: z.string().url(),
    allowBackgroundAccess: z.boolean(),
    /**
     * At most one instance should carry `true` -- enforced by
     * GrafanaInstanceConfigManager.setDefaultInstance, not by this schema
     * (a schema can't see the sibling entries). Absent means "not default".
     */
    isDefault: z.boolean().optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative()
  })
  .strict();
```

**Why this must land before the manager change:** `updateInstance` re-parses `{ ...existing, ...patch }` through `parseGrafanaInstanceConfig`; once any instance carries `isDefault`, a schema without the field makes *every subsequent edit throw* on the strict parse.

- [ ] **Step 2: manager** — `src/config/GrafanaInstanceConfigManager.ts`, after `deleteInstance`:

```typescript
  /**
   * Marks `id` as the single default instance (NEXT-U-08), clearing the flag
   * everywhere else in the same write so the invariant can't be observed
   * broken. Deliberately does not bump `updatedAt`: the default marker is a
   * pointer at an instance, not an edit of one.
   */
  async setDefaultInstance(id: string): Promise<void> {
    const instances = await this.listInstances();
    if (!instances.some((instance) => instance.id === id)) {
      throw new Error(`Unknown Grafana instance: ${id}`);
    }
    const next = instances.map(({ isDefault: _ignored, ...instance }) =>
      instance.id === id ? { ...instance, isDefault: true } : instance
    );
    await this.globalState.update(INSTANCES_KEY, next);
  }

  /** Removes the default marker from every instance. */
  async clearDefaultInstance(): Promise<void> {
    const instances = await this.listInstances();
    await this.globalState.update(
      INSTANCES_KEY,
      instances.map(({ isDefault: _ignored, ...instance }) => instance)
    );
  }
```

(The destructuring drop — rather than `isDefault: undefined` — keeps the persisted JSON clean; `Memento.update` serializes to JSON where an explicit `undefined` key is at the mercy of the serializer.)

- [ ] **Step 3: tree badge** — `src/tree/GrafanaTreeItems.ts`, `InstanceTreeItem` (lines 63–77). Replace the description/tooltip assembly:

```typescript
    const agentAccessLabel = instance.allowBackgroundAccess ? t('Agent access on') : t('Agent access off');
    const description = instance.isDefault === true ? `${t('Default')} · ${agentAccessLabel}` : agentAccessLabel;
    this.iconPath = new vscode.ThemeIcon(instance.allowBackgroundAccess ? 'server-environment' : 'lock');
    this.description = description;
    this.tooltip = `${instance.url}\n${description}`;
```

- [ ] **Step 4: agent projection** — `src/agent/GrafanaAgentToolService.ts`, `listInstances` (lines 396–398). The mapped row gains a **normalized boolean** (never `undefined` — agents branch on it, and a missing key invites re-derivation heuristics):

```typescript
    const authorized = instances
      .filter((instance) => instance.allowBackgroundAccess)
      .map((instance) => ({
        id: instance.id,
        label: instance.label,
        url: instance.url,
        isDefault: instance.isDefault === true
      }));
```

(No `bridgeSchemas.ts` change: `grafana_list_instances` takes `{}` and output shapes are not schema'd.)

- [ ] **Step 5: catalog description** — `src/mcp/toolCatalog.ts`, `grafana_list_instances` (lines 64–68), replace the description with:

```typescript
    description:
      'List configured Grafana instances that have "Allow Agent background access" enabled, as ' +
      '{ instances: [{id, label, url, isDefault}] } (never the auth token, never a toggled-off instance). When ' +
      'several instances are returned, prefer the one with isDefault: true unless the user names another. When ' +
      'instances is empty a hint field explains that the user must enable access per instance. Call this first to ' +
      'discover which instanceId values the other grafana_* management tools will accept.',
```

- [ ] **Step 6: toggle command** — `src/extension.ts` (next to `toggleAgentAccessCommand`, which it mirrors):

```typescript
  const setDefaultInstanceCommand = vscode.commands.registerCommand(
    'atGrafana.setDefaultInstance',
    async (arg?: unknown) => {
      const instance = await requireInstance(arg);
      if (!instance) {
        return;
      }
      if (instance.isDefault === true) {
        await configManager.clearDefaultInstance();
        showTimedNotification(t('"{label}" is no longer the default instance.', { label: instance.label }));
      } else {
        await configManager.setDefaultInstance(instance.id);
        showTimedNotification(t('"{label}" is now the default instance.', { label: instance.label }));
      }
      refreshTreeViews();
    }
  );
```

Push into `context.subscriptions`.

- [ ] **Step 7: `package.json`.**

`contributes.commands`:

```json
      {
        "command": "atGrafana.setDefaultInstance",
        "title": "%atGrafana.command.setDefaultInstance.title%"
      }
```

`menus."view/item/context"` (same `when` as the other instance rows):

```json
        {
          "command": "atGrafana.setDefaultInstance",
          "when": "view =~ /^atGrafana\\.(dashboards|alerts)$/ && viewItem == atGrafana.instance",
          "group": "1_manage@4"
        }
```

`menus.commandPalette`: `{ "command": "atGrafana.setDefaultInstance", "when": "false" }`.

- [ ] **Step 8: nls + l10n.**

`package.nls.json`: `"atGrafana.command.setDefaultInstance.title": "Set as Default Instance"`
`package.nls.zh-cn.json`: `"atGrafana.command.setDefaultInstance.title": "设为默认实例"`

`l10n/bundle.l10n.zh-cn.json`:

```json
  "Default": "默认",
  "\"{label}\" is now the default instance.": "「{label}」现在是默认实例。",
  "\"{label}\" is no longer the default instance.": "「{label}」不再是默认实例。",
```

- [ ] **Step 9: skill** — `skills/at-grafana-mcp/references/tool-selection.md`, "Always" item 1, append:

```markdown
   If several instances are returned, prefer the one with `isDefault: true` unless the user names another.
```

- [ ] **Step 10: tests.**

`test/config/schema.test.ts`: parses with `isDefault: true`, with the field absent, rejects `isDefault: 'yes'`, still rejects unknown keys.

`test/config/GrafanaInstanceConfigManager.test.ts` (Map-backed memento pattern already in the file):

- `setDefaultInstance(b)` after `setDefaultInstance(a)` leaves exactly one `isDefault: true` (on `b`) — assert via `listInstances()`.
- `clearDefaultInstance()` leaves zero.
- `setDefaultInstance('nope')` rejects with `Unknown Grafana instance`.
- `updateInstance(a, { label })` **preserves** `isDefault` (regression for the strict-parse trap in Step 1).
- `setDefaultInstance` does not change any `updatedAt`.

`test/tree/GrafanaTreeItems.test.ts`: `InstanceTreeItem` with `isDefault: true` has a description starting with the Default label; without it, unchanged.

`test/agent/GrafanaAgentToolService.test.ts`: `grafana_list_instances` rows carry `isDefault: false` when the config has no flag, `true` when set; the projection still never includes tokens.

`test/mcp/toolCatalog.test.ts`: `grafana_list_instances` description contains `isDefault`.

`test/extension/InstanceCommands.test.ts`: invoking `atGrafana.setDefaultInstance` with an `InstanceTreeItem`-shaped arg flips the flag on and (second call) off, following the file's existing command-invocation pattern.

- [ ] **Step 11: verify + commit**

```bash
npm run typecheck && npm test && npx vitest run test/i18n/nls.test.ts
git add src/config/ src/tree/GrafanaTreeItems.ts src/agent/GrafanaAgentToolService.ts src/mcp/toolCatalog.ts \
  src/extension.ts package.json package.nls.json package.nls.zh-cn.json l10n/bundle.l10n.zh-cn.json \
  skills/at-grafana-mcp/references/tool-selection.md test/
git commit -m "$(cat <<'EOF'
feat(config): default instance flag in tree and grafana_list_instances

NEXT-U-08. Single-default invariant lives in the config manager; the
tree shows a Default badge; list_instances projects isDefault as an
always-present boolean and the catalog tells agents to prefer it.
EOF
)"
```

---

## Task 23 — Folders fetch soft-fail: flatten dashboards instead of killing the tree (NEXT-U-07)

**Goal.** Today `DashboardTreeProvider.fetchInstanceData` runs `getAllFolders` and `searchAll` inside one `Promise.all` — a folders failure (permissions, a flaky `/api/folders`, an RBAC change) rejects the whole promise and the entire instance renders as a single red `ErrorTreeItem`, even though every dashboard was fetched fine. Same story in `AlertTreeProvider.fetchInstanceGroups`. Degrade instead: dashboards flatten into the `General` bucket under a one-line warning; alert groups fall back to `folderUid` as the label.

**Runs after Task 22** (tree provider files shared with T20/T22).

**DoD.** A rejecting `getAllFolders` no longer produces an `ErrorTreeItem` in either tree; the dashboard tree shows a warning row + `General` with **all** dashboards (including ones that have a `folderUid`); alert groups render with uid labels; a `searchAll` failure still error-renders as before (that one *is* fatal — no dashboards, nothing to show); `sharedGrafanaReads`' self-evicting failed promise means the next refresh retries; typecheck+test green.

### Files

| Path | Action |
|---|---|
| `src/tree/DashboardTreeProvider.ts` | Patch |
| `src/tree/AlertTreeProvider.ts` | Patch |
| `l10n/bundle.l10n.zh-cn.json` | Patch (1 string) |
| `test/tree/DashboardTreeProvider.test.ts` | Patch |
| `test/tree/AlertTreeProvider.test.ts` | Patch |

- [ ] **Step 1: data shape** — `src/tree/DashboardTreeProvider.ts`, `InstanceDashboardData` (lines 49–57) gains:

```typescript
  /** Set when /api/folders failed: dashboards are flattened into General and a warning row renders (NEXT-U-07). */
  foldersError?: string;
```

- [ ] **Step 2: fetch soft-fail** — replace the head of `fetchInstanceData` (currently lines 254–259):

```typescript
  private async fetchInstanceData(instance: GrafanaInstanceConfig): Promise<InstanceDashboardData> {
    const client = await this.createClient(instance);
    // NEXT-U-07: a folders failure must not reject the pair -- dashboards
    // are independently useful. searchAll failing is still fatal (nothing
    // to render), and Promise.all keeps that behavior for it.
    const [foldersOutcome, dashboards] = await Promise.all([
      this.sharedReads.getFolders(instance.id, () => client.getAllFolders()).then(
        (folders) => ({ ok: true as const, folders }),
        (error: unknown) => ({ ok: false as const, message: describeTreeError(error) })
      ),
      client.searchAll({ type: 'dash-db' })
    ]);
    const folders = foldersOutcome.ok ? foldersOutcome.folders : [];
    const foldersError = foldersOutcome.ok ? undefined : foldersOutcome.message;
```

(`describeTreeError` is already imported at the top of the file. `sharedReads.getFolders` self-evicts a failed promise — see `sharedGrafanaReads.ts` — so a later `refresh()`/expand retries the fetch instead of caching the degradation forever.)

In the dashboard-bucketing loop (currently lines 280–294), flatten in degraded mode:

```typescript
    for (const dashboard of dashboards) {
      // Degraded mode: without a folder listing, a real folderUid would
      // bucket dashboards under folder nodes that don't exist -- flatten
      // everything into the synthetic General bucket instead.
      const key = foldersError !== undefined ? undefined : dashboard.folderUid || undefined;
      if (key === undefined) {
        hasFolderlessDashboards = true;
      }
      // ... rest of the loop unchanged ...
    }
```

and thread the field through the return:

```typescript
    return { folders, rootFolders, childFoldersByParent, dashboardsByFolder, hasFolderlessDashboards, foldersError };
```

(With `folders = []`, `rootFolders`/`childFoldersByParent` come out empty and the existing `data.folders.length === 0` condition in `getInstanceChildren` already forces the `General` bucket — no extra branch needed there.)

- [ ] **Step 3: warning row** — in `getInstanceChildren`, right after the successful `loadInstanceData` (before the `needle` computation), build the warning; then prepend it to every non-error return of the method:

```typescript
    const warning =
      data.foldersError !== undefined
        ? new MessageTreeItem(
            t('Folders could not be loaded; dashboards are shown without folders. {message}', {
              message: data.foldersError
            })
          )
        : undefined;
```

and change the method's return sites to include it (pattern: `return warning ? [warning, ...items] : items;` — including the two `MessageTreeItem`-only returns, which become `[warning, message]`). If Task 20's bookmark groups are present, the warning goes **before** them (first row of the instance).

- [ ] **Step 4: alert tree fallback** — `src/tree/AlertTreeProvider.ts`, `fetchInstanceGroups` (lines 173–179). Two edits:

(a) Add `GrafanaFolder` to the type import:

```typescript
import type { GrafanaApiClient, GrafanaFolder } from '../grafana/GrafanaApiClient';
```

(b) Catch the folders leg:

```typescript
    const [rules, states, folders] = await Promise.all([
      client.listAlertRules(),
      client.listAlertRuleStates(),
      // NEXT-U-07: an alerts view that dies because /api/folders is down
      // helps nobody -- group labels fall back to the folderUid via the
      // existing `?? rule.folderUid` below. SharedGrafanaReads self-evicts
      // the failed fetch, so the next refresh retries titles.
      this.sharedReads.getFolders(instance.id, () => client.getAllFolders()).catch((): GrafanaFolder[] => [])
    ]);
```

No other change: the label line `folderTitleByUid.get(rule.folderUid) ?? rule.folderUid` (line 211) already handles the empty map.

- [ ] **Step 5: l10n** — `l10n/bundle.l10n.zh-cn.json`:

```json
  "Folders could not be loaded; dashboards are shown without folders. {message}": "无法加载文件夹；仪表盘将以无文件夹方式平铺显示。{message}",
```

- [ ] **Step 6: tests.**

`test/tree/DashboardTreeProvider.test.ts` — `describe('folders soft-fail (NEXT-U-07)')` with a fake client whose `getAllFolders` rejects (e.g. `new GrafanaApiError('network', 'ECONNREFUSED')`) and `searchAll` returns two dashboards, one with `folderUid: 'f1'`:

- Instance children contain **no** `ErrorTreeItem`; the first item is a `MessageTreeItem` whose label mentions folders; a `General` `FolderTreeItem` is present; no `FolderTreeItem` for `f1`.
- `getChildren(generalFolder)` returns **both** dashboards (the `folderUid: 'f1'` one included).
- Control: `searchAll` rejecting still returns an `ErrorTreeItem` (existing behavior, now guarded by a test).
- Each provider instance in these tests gets its **own** `SharedGrafanaReads` (the failed-promise self-eviction makes reuse across tests order-sensitive).

`test/tree/AlertTreeProvider.test.ts` — with `getAllFolders` rejecting and one rule in `folderUid: 'f9'`, group children still render and the group label is `` `f9 / <ruleGroup>` ``; no `ErrorTreeItem`.

- [ ] **Step 7: verify + commit**

```bash
npm run typecheck && npm test
git add src/tree/DashboardTreeProvider.ts src/tree/AlertTreeProvider.ts \
  l10n/bundle.l10n.zh-cn.json test/tree/
git commit -m "$(cat <<'EOF'
feat(tree): soft-fail the folder listing instead of failing the whole tree

NEXT-U-07. Dashboards flatten into General under a one-line warning when
/api/folders fails; alert groups fall back to folderUid labels. A
searchAll failure remains fatal for the instance subtree.
EOF
)"
```

---

## Task 24 — ADR-008: Alertmanager silence write gate (**Proposed** — document only, NO code)

**Goal.** Write the decision record that scopes the *only* write operation V2 may ever consider — creating/expiring an Alertmanager silence — and the gate it would require. This task ships **zero runtime code**: no schema, no tool entry, no HTTP call, no `POST`. The ADR exists so that when someone proposes "just add a silence button", the boundary and its acceptance conditions are already written down.

**DoD.** `docs/decisions/ADR-008-alertmanager-silence-write-gate.md` exists with Status **Proposed**; ADR-004's "V1 write scope" section points at it; `rg -n "risk: 'write'|risk: \"write\"" src/` still returns nothing; no `src/` or `test/` file changed.

### Files

| Path | Action |
|---|---|
| `docs/decisions/ADR-008-alertmanager-silence-write-gate.md` | **Create** |
| `docs/decisions/ADR-004-mcp-tool-catalog-and-permission-model.md` | Patch (1 sentence) |

- [ ] **Step 1: create the ADR** — `docs/decisions/ADR-008-alertmanager-silence-write-gate.md`, full contents:

```markdown
# ADR-008: Alertmanager silence as the single V2 write entry, behind an independent write gate

## Status
Proposed — **no implementation may land while this line reads Proposed.**
Acceptance requires: (1) the live smoke DoD 1/2/3/9 executed by a human,
(2) a security review of this document, (3) revisiting ADR-002 (see
Consequences), and (4) a human explicitly asking for the feature.

## Date
2026-08-27

## Context

Every tool in the AT Grafana catalog is `risk: read` (ADR-004), and ADR-004's
"V1 write scope" section is a hard boundary: nothing creates, updates,
deletes, silences, or pauses anything. That boundary has been load-bearing
three times over: it is why the per-instance `allowBackgroundAccess` toggle
is a sufficient authorization model, why every tool qualifies for the Hub
installer's default `autoApprove` set, and why ADR-002 could choose a single
build variant.

The follow-up roadmap (NEXT-P-11) identifies exactly one write operation
whose absence users actually feel during an incident: **silencing a firing
alert**. The incident playbook in `skills/at-grafana-mcp/SKILL.md` today ends
with a copy-paste JSON body the user must POST themselves — correct, but a
seam where an agent will eventually be asked to "just do it".

This ADR pre-answers that request. It deliberately does NOT approve it.

## Decision (what a V2 implementation would be allowed to look like)

1. **Scope: silences only.** The single write surface is Grafana's
   Alertmanager API: `POST /api/alertmanager/grafana/api/v2/silences`
   (create) and `DELETE /api/alertmanager/grafana/api/v2/silence/{id}`
   (expire). No dashboard writes, no rule pause, no annotation writes, no
   datasource writes ride along. A second write kind reopens this ADR.
2. **Independent write gate, default off.** A new per-instance toggle
   (working name `allowAgentWrites`), separate from and additional to
   `allowBackgroundAccess`. Both must be true for a silence tool call to be
   authorized. The instance form must present it with the same weight as the
   existing Agent toggle; it defaults to `false` and is never flipped
   programmatically.
3. **Never auto-approved.** The tool(s) carry `risk: 'write'` and are
   excluded from the Hub installer's `autoApprove` set. Every invocation
   goes through the MCP client's per-call approval UI. If the Hub protocol
   ever grows a stronger consent primitive for writes, use it.
4. **Required arguments, no defaults that widen blast radius.** `comment`
   (non-empty) and at least one non-catch-all matcher are mandatory;
   `endsAt` is mandatory and capped (proposal: ≤ 24 h from `startsAt`) so a
   forgotten silence cannot mute an alert forever. A catch-all matcher set
   (every matcher matching everything) is rejected at the schema layer.
5. **Token role is the operator's problem, stated honestly.** The Viewer
   role the docs recommend today cannot POST silences. The docs must say:
   enabling the write gate requires a token with Editor (or an
   Alerting-scoped RBAC role), and that this widens what a leaked token can
   do — which is precisely why the gate is per-instance and default-off.
6. **Read-back included.** A `grafana_list_silences` (`GET`, `risk: read`)
   may accompany the write pair so an agent can verify its own action; it is
   in scope for this ADR but NOT for the current catalog either.

## What is explicitly forbidden until Accepted

- Any code that POSTs to an Alertmanager endpoint, in any module.
- Any `risk: 'write'` entry in `src/mcp/toolCatalog.ts`.
- Any schema in `src/mcp/bridgeSchemas.ts` for silence bodies.
- Any UI copy that implies the agent can silence alerts.
- The skill keeps its text-only silence helper (copy-paste JSON, "Do not
  POST it") — that stays the V1/0.2.x answer.

## Consequences

- **ADR-002 must be revisited before acceptance.** Its single-build-variant
  reasoning leaned on "every tool is read-only"; a write tool re-raises the
  base/mcp dual-variant question ADR-004's V1 write scope section already
  flags. Re-litigating it belongs to the acceptance review of this ADR, not
  to the implementation PR.
- The permission model gains a second axis (read gate × write gate). The
  authorization matrix in `GrafanaAgentToolService` stays the single
  enforcement point; the write gate must be enforced there, not only in UI.
- Documentation debt is created deliberately: README/usage must not mention
  silences until acceptance, except to say writes are out of scope.
```

- [ ] **Step 2: ADR-004 pointer** — in `docs/decisions/ADR-004-mcp-tool-catalog-and-permission-model.md`, the "V1 write scope" section currently ends (line 78):

```76:78:docs/decisions/ADR-004-mcp-tool-catalog-and-permission-model.md
### V1 write scope

No tool in this catalog creates, updates, deletes, silences, or pauses anything. This is a hard V1 boundary (`docs/requirements.md` §6, non-goals #1–#2); any future write/exec tool requires a new ADR and revisits [ADR-002](ADR-002-single-build-variant.md)'s single-build-variant reasoning.
```

Append one sentence to that paragraph:

```markdown
The only write candidate so far — Alertmanager silences — is scoped (and *not yet approved*) in [ADR-008](ADR-008-alertmanager-silence-write-gate.md).
```

- [ ] **Step 3: verify + commit** — assert no code slipped in:

```bash
rg -n "alertmanager|silence" src/ test/ --ignore-case   # expect: no new hits vs. git HEAD
npm run typecheck && npm test                            # unchanged, still green
git add docs/decisions/ADR-008-alertmanager-silence-write-gate.md \
  docs/decisions/ADR-004-mcp-tool-catalog-and-permission-model.md
git commit -m "$(cat <<'EOF'
docs: add ADR-008 (Proposed) scoping a future Alertmanager silence write gate

NEXT-P-11. Document only -- no schemas, no catalog entry, no POST code.
Acceptance requires live-smoke DoD, security review, an ADR-002 revisit,
and an explicit human request.
EOF
)"
```

---

## Task 25 — Document the Grafana Live WebSocket refusal (revise ADR-003 notes only — NO tunnel code)

**Goal.** ADR-003's Decision/Consequences text mentions WebSocket proxying as part of the design ("and WebSocket upgrade requests used by Grafana Live where applicable", "WebSocket proxying for Grafana Live features"), but the shipped `GrafanaEmbedProxy` deliberately **refuses** upgrades — `server.on('upgrade', (_request, socket) => { socket.destroy(); })` (see the "Known limitation: no WebSocket proxying (Grafana Live)" section of the class doc in `src/webview/GrafanaEmbedProxy.ts`). Close the gap between the ADR text and reality with a dated revision note, and make the refusal an explicit 0.2.x decision rather than an omission. **No code changes.**

**DoD.** ADR-003 carries the revision note; no `src/` file touched; `rg -n "upgrade" src/webview/GrafanaEmbedProxy.ts` still shows only the destroy handler.

### Files

| Path | Action |
|---|---|
| `docs/decisions/ADR-003-panel-alert-embedding-via-local-proxy.md` | Patch (append section) |

- [ ] **Step 1: append the revision note** at the end of the file:

```markdown
## Revision note — 2026-08-27: Grafana Live WebSocket proxying remains refused (0.2.x)

The Decision and Consequences sections above mention WebSocket
upgrade/proxying as part of the design. As shipped, that part was **not**
implemented, and 0.2.x keeps it that way deliberately:

- `GrafanaEmbedProxy` destroys `Upgrade: websocket` requests outright
  (`server.on('upgrade', (_request, socket) => socket.destroy())`); see the
  "Known limitation: no WebSocket proxying (Grafana Live)" section of the
  class doc in `src/webview/GrafanaEmbedProxy.ts`.
- **Accepted degradation:** dashboards load and stay fully interactive over
  plain HTTP; Grafana Live push panels degrade to updating on manual
  refresh. The live smoke checklist records this as expected behavior under
  DoD 2, and requirements PROXY3 documents it.
- **Why the tunnel is refused for now, not merely deferred:**
  1. The HTTP embed itself has not passed live verification (DoD 2 is still
     HUMAN-pending). Tunneling a second transport through an unproven proxy
     multiplies the unproven surface.
  2. A correct tunnel is not a byte forwarder. It must re-inject
     `Authorization` on the upgrade request, re-apply this ADR's admission
     rules (the Referer-based sub-resource attribution scheme has no
     WebSocket equivalent — an ambient, long-lived socket reopens exactly
     the multi-instance confusion the 2026-08-13 cookie fix closed), honor
     TLS TOFU on a long-lived connection, and interact with Webview
     lifecycle (`retainContextWhenHidden`) costs that have not been priced.
  3. The follow-up roadmap (NEXT-P-12) sizes this as L and gates it on a
     revision of this ADR — after HTTP embed live-proof — not on a PR.

Until such a revision is Accepted, "no Grafana Live WebSocket proxying" is a
decision. Do not add `upgrade` handling to `GrafanaEmbedProxy` in 0.2.x.
```

- [ ] **Step 2: verify + commit**

```bash
git diff --stat            # exactly one file: the ADR
npm run typecheck && npm test   # unchanged, still green
git add docs/decisions/ADR-003-panel-alert-embedding-via-local-proxy.md
git commit -m "$(cat <<'EOF'
docs: record the Grafana Live WebSocket refusal as an ADR-003 revision note

NEXT-P-12 stays gated on a future ADR-003 revision after the HTTP embed
is live-proven. No tunnel code in 0.2.x.
EOF
)"
```

---

## Task 26 — Smoke pin follow-through + manual `workflow_dispatch` API smoke

**Goal.** Make the Grafana **11.5.2** pin (established by Part A Task 5) verifiable on demand: a manual GitHub Actions workflow that boots the compose stack, asserts the pinned version via `/api/health`, exercises the two management APIs the extension depends on, and greps the served login HTML for the two rewrite anchors `GrafanaEmbedProxy` depends on (`"appSubUrl"` for `rewriteGrafanaAppSubUrl`, `grafanaBootData` for the boot patch in `injectGrafanaEmbedShim`) — so a future image bump that breaks the rewrite is caught by a button press instead of a bug report. HUMAN DoD 1/2/3/9 remain human-only; this workflow covers the API half and nothing more.

**Canonical pin discipline: `grafana/grafana:11.5.2` from Task 5. Do NOT write `13.2.0` or any other tag anywhere in this task.** A tag bump is a human decision that includes recapturing `docs/fixtures/` per Task 5's runbook.

**DoD.** Compose is pinned to 11.5.2 (via T5's patch, applied here only if T5 hasn't run); `.github/workflows/live-smoke.yml` exists, is `workflow_dispatch`-only, and its steps match the compose reality (ports, credentials); the checklist names what the workflow does and does not close; `ci.yml` untouched.

### Files

| Path | Action |
|---|---|
| `docker-compose.smoke.yml` | **Conditional** — Step 0 only |
| `.github/workflows/live-smoke.yml` | **Create** |
| `docs/plans/2026-08-27-live-smoke-checklist.md` | Patch (one section) |

- [ ] **Step 0: establish the pin (conditional).** Read `docker-compose.smoke.yml`.
  - **If it already says `image: grafana/grafana:11.5.2`** (Task 5 ran): change nothing in this file; skip to Step 1.
  - **If it still says the unpinned `image: grafana/grafana`** (current state at the time of writing — the file even carries a "Deliberately unpinned" comment): apply **Part A Task 5's compose replacement verbatim** (see [`2026-08-27-agent-implementation-plan-a.md`](./2026-08-27-agent-implementation-plan-a.md), Task 5 — the block starting `services:` / `grafana:` / `image: grafana/grafana:11.5.2` with the admin/admin environment, healthcheck, named volume, and the optional `loki` profile). Do **not** author a third compose variant, do not keep the current `prometheus` deletion vs. addition ambiguous — T5's file is the canonical one and it is authoritative here. Commit it under T5's own commit message (`chore: pin smoke Grafana 11.5.2 and add fixture capture runbook` — minus the fixtures README if you are only applying the compose half, in which case use `chore: pin smoke Grafana 11.5.2 (compose half of Part A Task 5)`).
  - **If it is pinned to anything else**: STOP. That is a human bump; do not touch it and note the discrepancy in the PR.

> Note for Step 1: T5's compose file does **not** publish Prometheus and sets admin/admin explicitly; the workflow below assumes only Grafana on `localhost:3000` with `admin:admin`, which holds for both the T5 file and (by Grafana defaults) the pre-T5 file.

- [ ] **Step 1: create the workflow** — `.github/workflows/live-smoke.yml`:

```yaml
# Manual API-level smoke against the pinned Grafana (11.5.2, Part A Task 5).
#
# Deliberately workflow_dispatch-only, NOT part of ci.yml:
#   - it pulls images from Docker Hub at run time, so it is hostage to an
#     external registry and must never gate PRs;
#   - it verifies the *pinned environment*, not this repo's code -- it runs
#     no npm step at all;
#   - the real Definition-of-Done items (DoD 1/2/3/9) need a human in an
#     Extension Development Host / Webview DevTools / real MCP client and
#     cannot be closed by any workflow (see the live smoke checklist).
#
# What it does cover: the health/search/folders APIs the extension calls,
# and the two HTML anchors GrafanaEmbedProxy's rewrite depends on
# ("appSubUrl" for rewriteGrafanaAppSubUrl, grafanaBootData for the shim's
# boot patch). If a future pin bump breaks either, this fails loudly.
name: Live Smoke (manual)

on:
  workflow_dispatch:

jobs:
  api-smoke:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - name: Assert the compose pin is 11.5.2
        run: |
          grep -q 'image: grafana/grafana:11.5.2' docker-compose.smoke.yml \
            || { echo 'docker-compose.smoke.yml is not pinned to grafana/grafana:11.5.2 (Part A Task 5).' >&2; exit 1; }

      - name: Start the pinned stack
        run: docker compose -f docker-compose.smoke.yml up -d

      - name: Wait for Grafana health
        run: |
          for i in $(seq 1 60); do
            if curl -sf http://localhost:3000/api/health > /tmp/health.json; then
              cat /tmp/health.json
              exit 0
            fi
            sleep 2
          done
          echo 'Grafana did not become healthy within 120s.' >&2
          docker compose -f docker-compose.smoke.yml logs grafana >&2 || true
          exit 1

      - name: Assert the served version matches the pin
        run: |
          version=$(jq -r .version /tmp/health.json)
          echo "Grafana reports version: $version"
          case "$version" in
            11.5.*) ;;
            *) echo "Expected 11.5.x per the Task 5 pin, got $version." >&2; exit 1 ;;
          esac

      - name: Assert the management APIs the extension calls answer
        run: |
          curl -sfu admin:admin 'http://localhost:3000/api/search?type=dash-db&limit=1' | jq -e 'type == "array"'
          curl -sfu admin:admin 'http://localhost:3000/api/folders' | jq -e 'type == "array"'

      - name: Assert the embed rewrite anchors still exist in served HTML
        run: |
          html=$(curl -sf http://localhost:3000/login)
          echo "$html" | grep -q '"appSubUrl"' \
            || { echo 'Login HTML lost the "appSubUrl" boot-JSON key (rewriteGrafanaAppSubUrl anchor).' >&2; exit 1; }
          echo "$html" | grep -q 'grafanaBootData' \
            || { echo 'Login HTML lost grafanaBootData (injectGrafanaEmbedShim boot-patch anchor).' >&2; exit 1; }

      - name: Tear down
        if: always()
        run: docker compose -f docker-compose.smoke.yml down -v
```

- [ ] **Step 2: checklist note** — in `docs/plans/2026-08-27-live-smoke-checklist.md`, after the Environment section (below the T5 HUMAN banner if Task 5 already inserted it), add:

```markdown
## Semi-automated API half (manual workflow)

`.github/workflows/live-smoke.yml` (`workflow_dispatch` only — run it from the
Actions tab) boots the pinned compose stack and asserts: `/api/health`
reports 11.5.x, `/api/search` and `/api/folders` answer, and the served HTML
still contains the `"appSubUrl"` / `grafanaBootData` anchors
`GrafanaEmbedProxy`'s rewrite depends on. Run it before and after any pin
bump. It does **not** close DoD 1/2/3/9 — those need a human in an Extension
Development Host, Webview DevTools, and a real MCP client. It is deliberately
not part of `ci.yml`: it depends on Docker Hub at run time and verifies the
pinned environment, not this repo's code.
```

- [ ] **Step 3: local verification (best-effort).**

```bash
docker compose -f docker-compose.smoke.yml config   # must parse; skip with a PR note if Docker is unavailable
npx --yes yaml-lint .github/workflows/live-smoke.yml 2>/dev/null || node -e "
  const fs=require('fs');
  // minimal sanity: the file must mention workflow_dispatch and must not mention 13.
  const y=fs.readFileSync('.github/workflows/live-smoke.yml','utf8');
  if(!y.includes('workflow_dispatch')) process.exit(1);
  if(/grafana:(1[23]|[2-9][0-9])\./.test(y)) { console.error('forbidden newer pin'); process.exit(1); }
"
npm run typecheck && npm test   # unchanged, still green
```

If the runner has Docker, optionally execute the workflow's steps by hand once (`up -d`, the four curl/grep assertions, `down -v`) and note the outcome in the PR. Do **not** tick any DoD row.

**Forbidden in this task:** editing `.github/workflows/ci.yml`; pinning any tag other than `11.5.2`; adding `push`/`pull_request`/`schedule` triggers to the new workflow; marking DoD 1/2/3/9 complete.

- [ ] **Step 4: commit**

```bash
git add .github/workflows/live-smoke.yml docs/plans/2026-08-27-live-smoke-checklist.md
# plus docker-compose.smoke.yml ONLY if Step 0 applied T5's patch (commit that separately, first)
git commit -m "$(cat <<'EOF'
ci: add manual live-smoke workflow asserting the Grafana 11.5.2 pin

workflow_dispatch only -- checks /api/health version, the search/folders
management APIs, and the appSubUrl/grafanaBootData rewrite anchors.
DoD 1/2/3/9 remain HUMAN-only per the live smoke checklist.
EOF
)"
```

---

## Part D final verification

- [ ] `npm run typecheck` — clean.
- [ ] `npm test` — all suites green (expect the count to grow from T19/T20/T21/T22/T23 additions; do not hand-edit README test counts here — that is Part A Task 1's job).
- [ ] `npx vitest run test/i18n/nls.test.ts` — nls twins consistent after T20/T21/T22.
- [ ] `rg -n "starred|/api/user/stars" src/` — **zero** hits (favorites are local).
- [ ] `rg -n "import \* as vscode|from 'vscode'" src/agent/GrafanaAgentToolService.ts src/tree/dashboardBookmarks.ts src/grafana/` — **zero** hits.
- [ ] `rg -n "risk: 'write'" src/` — **zero** hits (ADR-008 is a document).
- [ ] `rg -n "13\.2|grafana:12|grafana:13" docker-compose.smoke.yml .github/workflows/` — **zero** hits; the only pin is `11.5.2`.
- [ ] ADR-008 Status is `Proposed`; ADR-003 and ADR-006 each carry a dated 2026-08-27 revision note.
- [ ] HUMAN rows (live smoke DoD 1/2/3/9) remain unchecked everywhere.
