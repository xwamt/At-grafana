# AT Grafana 0.1.4/0.2.0 可执行计划 · Part B（Tasks 7–12）

> **Parent corrections (must follow):**
> 1. SKILL lives at `skills/at-grafana-mcp/SKILL.md` (not `.cursor/skills/`).
> 2. ADR files live in `docs/decisions/` (not `docs/adr/`).
> 3. Task 9 introduces `GrafanaEmbedProxyStrings` for the 401 page. Task 13 (Part C) introduces `GrafanaEmbedProxyCopy` for all proxy error pages. **If T9 lands first, T13 MUST extend the same injection table** (add 401 fields to `GrafanaEmbedProxyCopy`, do not keep a parallel `strings` vs `copy` deps field). If T13 lands first, T9 adds `unauthorizedTitle`/`unauthorizedBody`/`retryLabel` into that copy table.
> 4. T7→T8→T9→T10 are serial on `src/extension.ts`.

> 执行前先读 [索引](./2026-08-27-agent-implementation-plan.md)。本文件覆盖 **Part B：0.2.0 IDE / Agent / consent（Tasks 7–12）**。
> 分支：stack on `cursor/implement-optimizations-ef26`（或其后继）。**禁止从 `master`/`main` 开始。**
>
> 所有代码片段基于该分支当前真实代码（已逐文件核对）。若行号漂移，按片段中给出的**唯一上下文字符串**定位，不要按行号定位。

---

## 全局规则（每个任务都适用）

1. 用户可见字符串一律走 `t()`，并同步在 `l10n/bundle.l10n.zh-cn.json` 增加 zh-cn 翻译（bundle 以**英文原文**为 key）。`package.json` contributes 的 title/description 用 `%nls%` 占位符，且 **`package.nls.json` 与 `package.nls.zh-cn.json` 两边都要加**（`test/i18n/nls.test.ts` 强制两边 key 集合一致，且 `package.nls.json` 中**不允许存在 package.json 未引用的 key**）。NLS 改动后运行：`npx vitest run test/i18n/nls.test.ts`。
2. 不得把 `vscode` import 进 `GrafanaHttpClient`、`GrafanaEmbedProxy`（只能注入已本地化的纯字符串）、`grafanaDeeplink.ts`、`GrafanaAgentToolService`。
3. 每个任务完成后：`npm run typecheck && npm test`，然后按任务给出的 commit message 单独提交。
4. 标记 **HUMAN** 的 DoD 项保持未勾选，如实上报，不得伪造（live smoke 见 `2026-08-27-live-smoke-checklist.md`）。
5. 不要重做 Wave 0–3（keep-alive TOFU、`get_alert_rule.data`、Test Connection TOFU、context menus、embed cache 等——见 `docs/plans/2026-08-27-perf-completeness-ux-optimization.md`）。

## 共享文件与执行顺序（Part B 内部）

```
T7 → T8 → T9 → T10   ── 串行。四个任务都改 src/extension.ts 和 l10n/bundle.l10n.zh-cn.json。
T11                  ── 逻辑上独立，但它和 T7 同时改 package.json + package.nls*.json。
                        建议放在 T10 之后执行，避免 contributes 合并冲突。
T12                  ── 最后执行（文档要描述 T7 的 alert filter、T9 的 401 页、T10 的 opt-in、T11 的 walkthrough）。
```

| 热点文件 | 本 Part 中改它的任务 |
|---|---|
| `src/extension.ts` | 7, 8, 9, 10 |
| `l10n/bundle.l10n.zh-cn.json` | 7, 9, 10 |
| `package.json` + `package.nls.json` + `package.nls.zh-cn.json` | 7, 11 |
| `src/mcp/bridgeSchemas.ts` / `src/mcp/toolCatalog.ts` | 8 |
| `src/webview/GrafanaEmbedProxy.ts` | 9（Part C 的 T13/T16 还会再改——见 Parent correction #3） |
| `src/mcp/McpConfigInstaller.ts` | 10 |
| `test/extension/*.test.ts` 里 `vi.mock('../../src/mcp/McpConfigInstaller')` 的 4 个文件 | 10 |

前一个任务**提交之后**再开始下一个任务。

## 全局禁止（本 Part 明确不做）

- **不做静默写入**：T10 之后，首次激活在没有 consent、没有既存 `AT Series` 条目时**必须弹窗**，不允许回退到旧的静默 `ensure`。
- **不做 Explore in-IDE**：`grafana_generate_deeplink` 的 `kind: 'explore'` 保持 URL-only，直到 Part C 的 Task 16。T8 只放开 `alertRule`。
- **不做 d-solo 单面板嵌入**、不做多 org `X-Grafana-Org-Id`、不做写工具（全目录保持 `risk: 'read'`）。
- **不改 `webview/html.ts`**：T9 的 401 页由代理自绘（`respondError` 同款自包含 HTML），不经过 Webview shell 渲染层。

---

## Task 7 — Alert 树标题过滤 + 状态过滤（NEXT-U-01）

**Goal.** Alerts 树获得与 Dashboards 树对称的标题过滤，外加一个状态多选过滤（`firing`/`pending`/`normal`/`unknown`——与 MCP 工具 `grafana_list_alert_rules` 的 `states` 参数完全同一套值，见 `src/mcp/bridgeSchemas.ts` 的 `grafanaListAlertRulesSchema`）。两个过滤都用 `workspaceState` 持久化、用 `setContext` + `when` 子句驱动 Clear 按钮，复刻 `DashboardTreeProvider` 的成熟模式（`DASHBOARD_FILTER_STATE_KEY` / `atGrafana.dashboardFilterActive`）。

**DoD.**

- [ ] Alerts 视图标题栏出现「按标题过滤」「按状态过滤」按钮；任一过滤激活时出现「清除过滤」按钮（`when: atGrafana.alertFilterActive`）。
- [ ] 过滤按组内规则粒度生效：组内无匹配规则的组被隐藏；存活组的 `worstState` 按**过滤后**的规则重算（组图标不得声称一个被过滤掉的 firing）。
- [ ] 过滤状态写入 `workspaceState`，window reload 后恢复；树顶 `TreeView.message` 显示当前过滤（复用已有 `Filter: "{filterText}"` key + 新增 `States: {states}`）。
- [ ] 全部匹配为空时显示 `No alert rules match the current filter.`（区别于无过滤时的 `No alert rules found.`）。
- [ ] `npm run typecheck && npm test` 通过；`npx vitest run test/i18n/nls.test.ts` 通过。
- [ ] **HUMAN**：真实 Grafana 实例上肉眼确认按钮、过滤、badge、reload 恢复（live smoke DoD）。

### Files

| Path | Action |
|---|---|
| `src/tree/AlertTreeProvider.ts` | Patch（过滤字段 + 方法 + `getInstanceChildren` 应用过滤） |
| `src/extension.ts` | Patch（传 `workspaceState`、`attachTreeView`、注册 3 个命令） |
| `package.json` | Patch（3 个 command + 3 条 `view/title` menu） |
| `package.nls.json` / `package.nls.zh-cn.json` | Patch（3 个 title key） |
| `l10n/bundle.l10n.zh-cn.json` | Patch（5 条新 runtime 字符串） |
| `test/tree/AlertTreeProvider.test.ts` | Patch（新增 describe 块） |

### Exact edits

#### 1. `src/tree/AlertTreeProvider.ts`

**imports**（现有第 4 行的 import 已含 `ALERT_STATE_RANK` 与 `NormalizedAlertState`，只需新增一行——插在 `import { SharedGrafanaReads } ...` 之前）：

```ts
import type { FilterMemento } from './DashboardTreeProvider';
```

**模块级常量**（插在 `export type AlertApiClient ...` 之前）：

```ts
export const ALERT_TITLE_FILTER_STATE_KEY = 'atGrafana.alertTitleFilter';
export const ALERT_STATE_FILTER_STATE_KEY = 'atGrafana.alertStateFilter';
const ALERT_FILTER_ACTIVE_CONTEXT_KEY = 'atGrafana.alertFilterActive';
```

**`AlertTreeProviderOptions`** — 在 `sharedReads?: SharedGrafanaReads;` 上方加：

```ts
  /** `context.workspaceState`; when set, both alert filters survive a window reload (NEXT-U-01). */
  workspaceState?: FilterMemento;
```

**类字段** — 在 `private readonly sharedReads: SharedGrafanaReads;` 后加：

```ts
  private readonly workspaceState: FilterMemento | undefined;
  private titleFilter: string | undefined;
  private stateFilter: NormalizedAlertState[] | undefined;
  private treeView: Pick<vscode.TreeView<GrafanaTreeItem>, 'message'> | undefined;
```

**构造函数** — 现在的构造体是：

```ts
    this.sharedReads = options.sharedReads ?? new SharedGrafanaReads();
    this.getRefreshIntervalSeconds = options.getRefreshIntervalSeconds;
    this.scheduleAutoRefresh();
```

在 `this.scheduleAutoRefresh();` 之前插入（与 `DashboardTreeProvider` 构造器同款「恢复 + 初始化 context」逻辑）：

```ts
    this.workspaceState = options.workspaceState;
    const persistedTitle = this.workspaceState?.get<string | undefined>(ALERT_TITLE_FILTER_STATE_KEY, undefined);
    this.titleFilter =
      typeof persistedTitle === 'string' && persistedTitle.trim().length > 0 ? persistedTitle.trim() : undefined;
    this.stateFilter = normalizePersistedStates(
      this.workspaceState?.get<unknown>(ALERT_STATE_FILTER_STATE_KEY, undefined)
    );
    // Initialize the `when`-clause context even when nothing was restored, so
    // the Clear Filters button starts hidden rather than stale (same rationale
    // as DashboardTreeProvider's constructor).
    this.syncFilterContext();
```

**公开方法** — 在 `refresh()` 之前插入：

```ts
  attachTreeView(treeView: Pick<vscode.TreeView<GrafanaTreeItem>, 'message'>): void {
    this.treeView = treeView;
    this.updateTreeViewMessage();
  }

  setTitleFilter(text: string): void {
    const trimmed = text.trim();
    this.titleFilter = trimmed.length > 0 ? trimmed : undefined;
    this.onFiltersChanged();
  }

  /** An empty selection clears the state filter -- "show nothing" is never a useful tree. */
  setStateFilter(states: NormalizedAlertState[]): void {
    this.stateFilter = states.length > 0 ? [...new Set(states)] : undefined;
    this.onFiltersChanged();
  }

  clearFilters(): void {
    if (this.titleFilter === undefined && this.stateFilter === undefined) {
      return;
    }
    this.titleFilter = undefined;
    this.stateFilter = undefined;
    this.onFiltersChanged();
  }

  getTitleFilter(): string | undefined {
    return this.titleFilter;
  }

  getStateFilter(): NormalizedAlertState[] | undefined {
    return this.stateFilter;
  }
```

**`getInstanceChildren`** — 现在的结尾是：

```ts
    if (groups.length === 0) {
      return [new MessageTreeItem(t('No alert rules found.'))];
    }
    return groups.map(
      (group) => new AlertGroupTreeItem(instance, group.folderUid, group.ruleGroup, group.label, group.worstState, group.rules)
    );
```

替换为：

```ts
    if (groups.length === 0) {
      return [new MessageTreeItem(t('No alert rules found.'))];
    }
    const visible = this.hasActiveFilters() ? this.applyFilters(groups) : groups;
    if (visible.length === 0) {
      return [new MessageTreeItem(t('No alert rules match the current filter.'))];
    }
    return visible.map(
      (group) => new AlertGroupTreeItem(instance, group.folderUid, group.ruleGroup, group.label, group.worstState, group.rules)
    );
```

**私有辅助** — 在 `scheduleAutoRefresh()` 之前插入：

```ts
  private onFiltersChanged(): void {
    this.persistFilters();
    this.syncFilterContext();
    this.updateTreeViewMessage();
    this.onDidChangeTreeDataEmitter.fire();
  }

  private hasActiveFilters(): boolean {
    return this.titleFilter !== undefined || this.stateFilter !== undefined;
  }

  /**
   * NEXT-U-01: filters rules inside each group (title substring,
   * case-insensitive, AND allowed normalized states -- the same four values
   * grafana_list_alert_rules accepts as `states`), drops groups left empty,
   * and recomputes each surviving group's `worstState` from the rules that
   * remain so the group icon cannot claim a firing rule the filter hid.
   * Purely presentational: the fetched groups cache is never mutated, so
   * clearing the filter needs no refetch.
   */
  private applyFilters(groups: InstanceAlertGroup[]): InstanceAlertGroup[] {
    const needle = this.titleFilter?.toLowerCase();
    const allowed = this.stateFilter ? new Set<NormalizedAlertState>(this.stateFilter) : undefined;
    const result: InstanceAlertGroup[] = [];
    for (const group of groups) {
      const rules = group.rules.filter(
        (rule) =>
          (needle === undefined || rule.title.toLowerCase().includes(needle)) &&
          (allowed === undefined || allowed.has(rule.state))
      );
      if (rules.length === 0) {
        continue;
      }
      let worstState: NormalizedAlertState = rules[0]!.state;
      for (const rule of rules) {
        if (ALERT_STATE_RANK[rule.state] < ALERT_STATE_RANK[worstState]) {
          worstState = rule.state;
        }
      }
      result.push({ ...group, worstState, rules });
    }
    return result;
  }

  private persistFilters(): void {
    void this.workspaceState?.update(ALERT_TITLE_FILTER_STATE_KEY, this.titleFilter);
    void this.workspaceState?.update(ALERT_STATE_FILTER_STATE_KEY, this.stateFilter);
  }

  private syncFilterContext(): void {
    // `setContext` is the only channel a `when` clause can read; drives the
    // Clear Filters button's visibility (same pattern as
    // DashboardTreeProvider's FILTER_ACTIVE_CONTEXT_KEY).
    void vscode.commands.executeCommand('setContext', ALERT_FILTER_ACTIVE_CONTEXT_KEY, this.hasActiveFilters());
  }

  private updateTreeViewMessage(): void {
    if (!this.treeView) {
      return;
    }
    const parts: string[] = [];
    if (this.titleFilter !== undefined) {
      parts.push(t('Filter: "{filterText}"', { filterText: this.titleFilter }));
    }
    if (this.stateFilter !== undefined) {
      parts.push(t('States: {states}', { states: this.stateFilter.join(', ') }));
    }
    this.treeView.message = parts.length > 0 ? parts.join(' · ') : undefined;
  }
```

**模块级函数** — 文件末尾（`AlertTreeProvider` 类之后）追加：

```ts
/**
 * Accepts only a persisted array of known normalized states; anything else
 * (older extension versions, hand-edited storage) reads as "no state filter"
 * rather than throwing during activation.
 */
function normalizePersistedStates(value: unknown): NormalizedAlertState[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const known = new Set<string>(['firing', 'pending', 'normal', 'unknown']);
  const states = value.filter(
    (entry): entry is NormalizedAlertState => typeof entry === 'string' && known.has(entry)
  );
  return states.length > 0 ? [...new Set(states)] : undefined;
}
```

#### 2. `src/extension.ts`

**import**（在 `import { AlertRuleTreeItem, ... } from './tree/GrafanaTreeItems';` 附近加）：

```ts
import type { NormalizedAlertState } from './grafana/correlateAlertState';
```

**构造 `AlertTreeProvider`** — 现在是：

```ts
  const alertTreeProvider = new AlertTreeProvider(
    configManager,
    (instance) => createGrafanaClient(configManager, instance, certTrustStore, log),
    {
      sharedReads: sharedGrafanaReads,
```

在 `sharedReads: sharedGrafanaReads,` 前插一行：

```ts
      workspaceState: context.workspaceState,
```

**attach**：定位

```ts
  const alertTreeView = vscode.window.createTreeView<GrafanaTreeItem>('atGrafana.alerts', {
    treeDataProvider: alertTreeProvider
  });
```

紧随其后加：

```ts
  alertTreeProvider.attachTreeView(alertTreeView);
```

**命令注册** — 定位 `const clearDashboardFilterCommand = ...` 块（`dashboardTreeProvider.clearFilter();` 结束处），其后插入：

```ts
  const filterAlertsCommand = vscode.commands.registerCommand('atGrafana.filterAlerts', async () => {
    const value = await vscode.window.showInputBox({
      prompt: t('Filter alert rules by title'),
      placeHolder: t('e.g. cpu'),
      value: alertTreeProvider.getTitleFilter() ?? ''
    });
    if (value !== undefined) {
      alertTreeProvider.setTitleFilter(value);
    }
  });
  const filterAlertsByStateCommand = vscode.commands.registerCommand('atGrafana.filterAlertsByState', async () => {
    // Labels stay the raw normalized state ids on purpose -- the tree itself
    // renders rawState untranslated, and these are Grafana's own state names.
    const allStates: NormalizedAlertState[] = ['firing', 'pending', 'normal', 'unknown'];
    const current = new Set(alertTreeProvider.getStateFilter() ?? []);
    const picked = await vscode.window.showQuickPick(
      allStates.map((state) => ({ label: state, picked: current.has(state), state })),
      {
        canPickMany: true,
        placeHolder: t('Select alert states to show (select none to clear the state filter)')
      }
    );
    if (picked !== undefined) {
      alertTreeProvider.setStateFilter(picked.map((item) => item.state));
    }
  });
  const clearAlertFiltersCommand = vscode.commands.registerCommand('atGrafana.clearAlertFilters', () => {
    alertTreeProvider.clearFilters();
  });
```

**subscriptions** — 在 `context.subscriptions.push(` 列表中 `clearDashboardFilterCommand,` 之后加：

```ts
    filterAlertsCommand,
    filterAlertsByStateCommand,
    clearAlertFiltersCommand,
```

#### 3. `package.json`

**`contributes.commands`** — 在 `atGrafana.refreshAlerts` 条目之后插入：

```json
      {
        "command": "atGrafana.filterAlerts",
        "title": "%atGrafana.command.filterAlerts.title%",
        "icon": "$(filter)"
      },
      {
        "command": "atGrafana.filterAlertsByState",
        "title": "%atGrafana.command.filterAlertsByState.title%",
        "icon": "$(settings)"
      },
      {
        "command": "atGrafana.clearAlertFilters",
        "title": "%atGrafana.command.clearAlertFilters.title%",
        "icon": "$(clear-all)"
      },
```

**`menus."view/title"`** — 现有 alerts 排布是 `addInstance@1`、`refreshAlerts@2`、`manageInstances@9`。在 `atGrafana.refreshAlerts` 条目之后插入：

```json
        {
          "command": "atGrafana.filterAlerts",
          "when": "view == atGrafana.alerts",
          "group": "navigation@3"
        },
        {
          "command": "atGrafana.filterAlertsByState",
          "when": "view == atGrafana.alerts",
          "group": "navigation@4"
        },
        {
          "command": "atGrafana.clearAlertFilters",
          "when": "view == atGrafana.alerts && atGrafana.alertFilterActive",
          "group": "navigation@5"
        },
```

#### 4. NLS 文件

**`package.nls.json`** — 在 `"atGrafana.command.refreshAlerts.title"` 之后加：

```json
  "atGrafana.command.filterAlerts.title": "AT Grafana: Filter Alert Rules",
  "atGrafana.command.filterAlertsByState.title": "AT Grafana: Filter Alert Rules by State",
  "atGrafana.command.clearAlertFilters.title": "AT Grafana: Clear Alert Filters",
```

**`package.nls.zh-cn.json`** — 同位置加：

```json
  "atGrafana.command.filterAlerts.title": "AT Grafana: 过滤告警规则",
  "atGrafana.command.filterAlertsByState.title": "AT Grafana: 按状态过滤告警规则",
  "atGrafana.command.clearAlertFilters.title": "AT Grafana: 清除告警过滤器",
```

**`l10n/bundle.l10n.zh-cn.json`** — 追加 5 条（**不要**重复添加 `Filter: "{filterText}"`，它已随 dashboard filter 存在）：

```json
  "No alert rules match the current filter.": "没有符合当前过滤条件的告警规则。",
  "Filter alert rules by title": "按标题过滤告警规则",
  "e.g. cpu": "例如 cpu",
  "Select alert states to show (select none to clear the state filter)": "选择要显示的告警状态（不选任何项即清除状态过滤）",
  "States: {states}": "状态：{states}"
```

### Tests

`test/tree/AlertTreeProvider.test.ts` 新增 describe（用一个 `Map` 假 `FilterMemento`，模式照抄 `test/tree/DashboardTreeProvider.test.ts` 的 filter 测试）：

```ts
describe('title and state filters (NEXT-U-01)', () => {
  function memento(initial: Record<string, unknown> = {}) {
    const store = new Map<string, unknown>(Object.entries(initial));
    return {
      get: <T>(key: string, defaultValue: T): T => (store.has(key) ? (store.get(key) as T) : defaultValue),
      update: async (key: string, value: unknown) => void store.set(key, value),
      store
    };
  }
  // 用例（每条一个 it）：
  // 1. restores persisted title + state filters and getTitleFilter/getStateFilter report them
  // 2. setTitleFilter('CPU') matches rule titles case-insensitively; groups with no match disappear
  // 3. setStateFilter(['firing']) hides normal-only groups (symmetric with MCP `states`)
  // 4. a group's worstState is recomputed from surviving rules (firing rule filtered out
  //    by title -> group icon state drops to the best remaining rank)
  // 5. everything filtered out -> single MessageTreeItem 'No alert rules match the current filter.'
  //    (and WITHOUT filters the empty message stays 'No alert rules found.')
  // 6. clearFilters() persists undefined for both keys and restores full tree
  // 7. attachTreeView + setTitleFilter/setStateFilter set treeView.message; clearFilters clears it
  // 8. normalizePersistedStates path: persisted garbage (['bogus', 42]) reads as no state filter
});
```

运行：

```bash
npx vitest run test/tree/AlertTreeProvider.test.ts
npx vitest run test/i18n/nls.test.ts
npm run typecheck && npm test
```

### Commit

```
feat(alerts): title and state filters on the alert tree (NEXT-U-01)
```

**Out of scope.** 不给 Dashboards 树加状态过滤（无意义）；不做服务端过滤（Grafana 无该 API，客户端过滤与 dashboard 树一致）；不改 `grafana_list_alert_rules`（已有 `states`）；不持久化到 `globalState`（跟 dashboard filter 一样 per-workspace）。

---

## Task 8 — `grafana_generate_deeplink` 的 `openInIde` 支持 `alertRule`（NEXT-U-12①）

**Goal.** `grafana_generate_deeplink` 目前只在 `kind: 'dashboard'` 时支持 `openInIde: true`（打开 `DashboardPanel`）；`alertRule` 的 URL 早已能生成（`buildGrafanaDeeplink` 的 `/alerting/grafana/{uid}/view` 分支），但 Agent 无法把它开进 IDE。本任务给 `alertRule` variant 加 `openInIde`/`title` 字段，注入 `openAlertRuleInIde` 回调（走 `AlertDetailPanel` + FUNC-14 非交互 TLS 门），`explore` 保持 URL-only 到 Task 16。

**DoD.**

- [ ] `grafanaGenerateDeeplinkSchema` 的 `alertRule` variant 接受 `openInIde`（默认 false）与可选 `title`；`explore` variant 依旧 **strict 拒绝** `openInIde`。
- [ ] `openInIde: true` + `kind: 'alertRule'` 在 opener 注入时打开 `AlertDetailPanel` 并返回 `{ grafanaUrl, openedInIde: true }`；opener 抛错（例如 TLS 未信任）时返回 `{ grafanaUrl, openedInIde: false, message }`——**URL 永远返回**。
- [ ] catalog 描述更新为 dashboards **and alert rules** 可 openInIde、Explore URL-only。
- [ ] `GrafanaAgentToolService.ts` 仍然不 import `vscode`。
- [ ] `npm run typecheck && npm test` 通过。

### Files

| Path | Action |
|---|---|
| `src/mcp/bridgeSchemas.ts` | Patch（Zod alertRule variant + JSON Schema twin 描述） |
| `src/agent/GrafanaAgentToolService.ts` | Patch（deps + dispatch 重写） |
| `src/extension.ts` | Patch（注入 `openAlertRuleInIde`） |
| `src/mcp/toolCatalog.ts` | Patch（描述一句话） |
| `test/mcp/bridgeSchemas.test.ts` | Patch |
| `test/agent/GrafanaAgentToolService.test.ts` | Patch |
| `test/mcp/toolCatalog.test.ts` | Patch |

### Exact edits

#### 1. `src/mcp/bridgeSchemas.ts`

**Zod**：`grafanaGenerateDeeplinkSchema` 的第三个 variant，现在是：

```ts
  z
    .object({
      instanceId: z.string().min(1),
      kind: z.literal('alertRule'),
      uid: z.string().min(1)
    })
    .strict()
```

替换为：

```ts
  z
    .object({
      instanceId: z.string().min(1),
      kind: z.literal('alertRule'),
      uid: z.string().min(1),
      openInIde: z.boolean().default(false),
      title: z.string().min(1).optional()
    })
    .strict()
```

**JSON Schema twin**：`GRAFANA_GENERATE_DEEPLINK_INPUT_SCHEMA` 的 `openInIde` 描述，现在是：

```ts
    openInIde: {
      type: 'boolean',
      description: 'Dashboard only. Default false. Opens the AT Grafana Webview.'
    },
```

替换为：

```ts
    openInIde: {
      type: 'boolean',
      description: 'Dashboard and alertRule only. Default false. Opens the AT Grafana Webview.'
    },
```

（提醒：该文件类注释明确要求 Zod 与 JSON Schema twin **同一 commit 内同步**，没有自动检查。）

#### 2. `src/agent/GrafanaAgentToolService.ts`

**deps** — `GrafanaAgentToolServiceDependencies` 内，`openDashboardInIde` 之后追加：

```ts
  /**
   * Optional IDE opener for `grafana_generate_deeplink` with
   * `kind: 'alertRule'` and `openInIde: true` (NEXT-U-12). Injected by
   * `src/extension.ts` (AlertDetailPanel behind the same FUNC-14
   * non-interactive TLS gate as openDashboardInIde) so this class stays
   * vscode-free.
   */
  openAlertRuleInIde?: (args: { instanceId: string; uid: string; title?: string }) => Promise<void>;
```

**dispatch** — `case 'grafana_generate_deeplink':` 整块（从 `return await this.withAuthorizedClient(grafanaGenerateDeeplinkSchema, ...` 到该 case 结束）替换为：

```ts
        case 'grafana_generate_deeplink':
          return await this.withAuthorizedClient(grafanaGenerateDeeplinkSchema, args, async (_client, parsed) => {
            const instance = await this.deps.configManager.getInstance(parsed.instanceId);
            const grafanaUrl = buildGrafanaDeeplink(instance!.url, parsed);
            // Explore stays URL-only until Task 16; dashboard/alertRule both
            // carry openInIde (default false) after Task 8's schema change.
            if (parsed.kind === 'explore' || parsed.openInIde !== true) {
              return { grafanaUrl, openedInIde: false };
            }
            if (parsed.kind === 'dashboard') {
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
            }
            const opener = this.deps.openAlertRuleInIde;
            if (!opener) {
              return { grafanaUrl, openedInIde: false, message: 'IDE opener is not available.' };
            }
            try {
              await opener({ instanceId: parsed.instanceId, uid: parsed.uid, title: parsed.title });
              return { grafanaUrl, openedInIde: true };
            } catch (error) {
              return { grafanaUrl, openedInIde: false, message: formatError(error) };
            }
          });
```

（`grafanaDeeplink.ts` **不需要改**：`buildGrafanaDeeplink` 的 `GrafanaAlertRuleDeeplinkInput` 只消费 `kind`/`uid`，Zod parse 出的多余字段是结构化超集，TypeScript 兼容。）

#### 3. `src/extension.ts`

`grafanaAgentToolService` 构造对象里，`openDashboardInIde: async (...) => { ... }` 整段之后（同级）追加：

```ts
    // NEXT-U-12: same FUNC-14 rules as openDashboardInIde -- Agent-initiated,
    // so `interactiveTls: false` (throws instead of prompting TOFU) and the
    // thrown message surfaces as the tool's `message` with openedInIde: false.
    openAlertRuleInIde: async ({ instanceId, uid, title }) => {
      await openGrafanaEmbedPanel(
        configManager,
        certTrustStore,
        instanceId,
        uid,
        title ?? t('Alert Rule'),
        (panelInstanceId, panelUid, panelTitle) =>
          AlertDetailPanel.open(grafanaEmbedProxy, panelInstanceId, panelUid, panelTitle),
        undefined,
        undefined,
        { interactiveTls: false }
      );
    }
```

（`AlertDetailPanel`、`t('Alert Rule')`、`openGrafanaEmbedPanel` 均已在本文件中存在——对照 `atGrafana.openAlertRule` 命令的写法。）

#### 4. `src/mcp/toolCatalog.ts`

`grafana_generate_deeplink` 条目的 description，现在含：

```ts
      'openInIde (default false) opens the AT Grafana Webview for dashboards only and requires the instance TLS ' +
      'fingerprint to already be trusted in the sidebar; Explore and alertRule are URL-only.' +
```

替换为：

```ts
      'openInIde (default false) opens the AT Grafana Webview for dashboards and alert rules and requires the ' +
      'instance TLS fingerprint to already be trusted in the sidebar; Explore is URL-only.' +
```

### Tests

- `test/mcp/bridgeSchemas.test.ts`：在现有 `grafana_generate_deeplink` 用例旁加：
  - `alertRule` + `openInIde: true` + `title` parse 成功，且 `openInIde` 缺省时默认 `false`；
  - `explore` + `openInIde: true` 被 strict 拒绝（这是「Explore 仍 URL-only」的回归锚点）。
- `test/agent/GrafanaAgentToolService.test.ts`：`makeService`（或等价工厂）加可选 `openAlertRuleInIde`，新增：
  - opener 成功 → `{ openedInIde: true }` 且 opener 收到 `{ instanceId, uid, title }`；
  - opener 抛 `new Error('TLS not trusted')` → `ok: true`、`openedInIde: false`、`message` 含该文案、`grafanaUrl` 仍是 `/alerting/grafana/<uid>/view`；
  - 未注入 opener → `openedInIde: false, message: 'IDE opener is not available.'`；
  - 回归：`kind: 'alertRule'` 不带 `openInIde` 的旧调用行为不变（`openedInIde: false`，无 message… 注意实现返回无 `message` 字段）。
- `test/mcp/toolCatalog.test.ts`：断言描述含 `dashboards and alert rules` 且仍含 `Explore is URL-only`。

```bash
npx vitest run test/mcp/bridgeSchemas.test.ts test/agent/GrafanaAgentToolService.test.ts test/mcp/toolCatalog.test.ts
npm run typecheck && npm test
```

### Commit

```
feat(agent): openInIde support for alertRule deeplinks (NEXT-U-12)
```

**Out of scope.** Explore in-IDE（Task 16）；d-solo 面板嵌入；给 alertRule deeplink 加 from/to（Grafana rule view 页不接受时间参数）；改 `AlertDetailPanel` 本身。

---

## Task 9 — Embed 401 自绘页 + 401/403 文案区分（NEXT-U-13）

**Goal.** token 被轮换/吊销后，嵌入面板里当前会渲染 Grafana 自己的登录页（在代理注入 Bearer 的架构下登录**永远不可能成功**——死路）。改为：文档路由收到 401（或被重定向到 `/login`）时，代理自绘一页「去侧边栏编辑实例、更新 token」的指引页。同时在树错误与 Test Connection 文案中区分 401（token 无效）与 403（权限不足）。文案由 `extension.ts` 用 `t()` 本地化后**以纯字符串注入**——代理不 import `vscode`。

> **Parent correction #3 适用于本任务**：本任务引入 `GrafanaEmbedProxyStrings`。若 Part C 的 T13 已先落地 `GrafanaEmbedProxyCopy`，则**不要**新建 `strings` 字段——把 `unauthorizedTitle`/`unauthorizedBody`/`retryLabel` 三个 key 加进那张 copy 表并复用其注入路径，本节其余逻辑（检测、拦截、自绘页）不变。

**DoD.**

- [ ] 文档路由（`sec-fetch-dest: document/iframe` 或 `Accept: text/html`）上游 401 → 代理返回自绘 401 页（注入文案 + Retry 链接）；上游 3xx 且 `Location` 指向 `/login` → 同样拦截。
- [ ] API/子资源的 401 **原样透传**（Grafana 自己的 JS 需要看到它们）；credential cache 失效逻辑（`invalidateInstance`）保持不变。
- [ ] 树错误：`GrafanaApiError.kind === 'auth'` 且 `status === 403` 时给「权限不足，给 service account Viewer 角色」文案；401/无 status 保持原「rejected the token」文案。
- [ ] Test Connection：401 与 403 显示不同的本地化消息。
- [ ] `GrafanaEmbedProxy.ts` 无 `vscode` import（`rg "from 'vscode'" src/webview/GrafanaEmbedProxy.ts` 零命中）。
- [ ] `npm run typecheck && npm test`、`npx vitest run test/i18n/nls.test.ts` 通过。
- [ ] **HUMAN**：真实实例上吊销 token，确认面板出现自绘 401 页，更新 token 后 Retry 恢复。

### Files

| Path | Action |
|---|---|
| `src/webview/GrafanaEmbedProxy.ts` | Patch（strings 注入 + 401 检测 + 自绘页） |
| `src/extension.ts` | Patch（构造代理时注入 `t()` 文案） |
| `src/tree/GrafanaTreeItems.ts` | Patch（`describeTreeError` 403 分支） |
| `src/grafana/testGrafanaConnection.ts` | Patch（结果带 `status`） |
| `src/webview/GrafanaInstanceFormPanel.ts` | Patch（tester 透传 status + 消息映射） |
| `l10n/bundle.l10n.zh-cn.json` | Patch（6 条新字符串） |
| `test/webview/GrafanaEmbedProxy.test.ts` | Patch |
| `test/tree/GrafanaTreeItems.test.ts` | Patch |
| `test/grafana/testGrafanaConnection.test.ts` | Patch |
| `test/webview/GrafanaInstanceFormPanel.test.ts` | Patch |

**明确不改**：`src/webview/html.ts`（401 页自绘于代理内，与 `respondError` 同层）。

### Exact edits

#### 1. `src/webview/GrafanaEmbedProxy.ts`

**接口与默认值** — 插在 `GrafanaEmbedProxyDependencies` 定义之前：

```ts
/**
 * NEXT-U-13: user-facing copy for the self-drawn 401 page. Injected as plain,
 * already-localized strings from src/extension.ts because this module must
 * never import vscode (and therefore cannot reach t()). Task 13 (Part C)
 * generalizes this into a GrafanaEmbedProxyCopy table covering every proxy
 * error page -- extend THIS injection point there; do not add a second,
 * parallel deps field.
 */
export interface GrafanaEmbedProxyStrings {
  unauthorizedTitle: string;
  unauthorizedBody: string;
  retryLabel: string;
}

/** English fallbacks for tests and any caller that injects nothing (UX-12's accepted limitation). */
export const DEFAULT_EMBED_PROXY_STRINGS: GrafanaEmbedProxyStrings = {
  unauthorizedTitle: 'Grafana rejected the token (HTTP 401).',
  unauthorizedBody: 'Edit this instance in the AT Grafana sidebar and update its Service Account Token, then retry.',
  retryLabel: 'Retry'
};
```

**deps** — `GrafanaEmbedProxyDependencies` 内 `log?: AtGrafanaLog;` 之后加：

```ts
  /** Localized copy for the self-drawn 401 page; see GrafanaEmbedProxyStrings. */
  strings?: Partial<GrafanaEmbedProxyStrings>;
```

**类字段/构造** — `private readonly log: AtGrafanaLog;` 之后加字段：

```ts
  private readonly strings: GrafanaEmbedProxyStrings;
```

构造函数（现为两行）追加一行：

```ts
    this.strings = { ...DEFAULT_EMBED_PROXY_STRINGS, ...deps.strings };
```

**拦截点** — `forward()` 的上游响应回调，现在的开头是：

```ts
      (proxyResponse) => {
        if (proxyResponse.statusCode === 401) {
          // A token Grafana rejects must not stay pinned in the credential
          // cache: the user may have just rotated it, and the next request
          // should re-read SecretStorage rather than replay the stale one.
          this.invalidateInstance(instanceId);
        }
        if (cachedRewrite && proxyResponse.statusCode === 304) {
```

在 `invalidateInstance` 的 `}` 与 `if (cachedRewrite ...` 之间插入：

```ts
        if (isUnauthorizedDocumentResponse(clientRequest, proxyResponse)) {
          // NEXT-U-13: rendering Grafana's login page inside the panel is a
          // dead end (this proxy injects the Bearer token; a form login can
          // never fix it). Drain the upstream body and draw the recovery
          // page instead. API/sub-resource 401s above deliberately still
          // pass through so Grafana's own JS sees them.
          proxyResponse.resume();
          respondUnauthorizedPage(clientResponse, this.strings);
          return;
        }
```

**模块级函数** — 在 `respondError` 之前插入（`firstHeaderValue`/`escapeHtml` 已存在）：

```ts
/**
 * NEXT-U-13: whether an upstream response to a *document* navigation says the
 * token is no good -- a literal 401, or the redirect onto Grafana's /login
 * page that an expired session produces on document routes. Sub-resource and
 * API requests never match (fetchDest/accept gate), so Grafana's own error
 * handling keeps working for XHR traffic.
 */
export function isUnauthorizedDocumentResponse(
  clientRequest: Pick<http.IncomingMessage, 'headers'>,
  proxyResponse: Pick<http.IncomingMessage, 'statusCode' | 'headers'>
): boolean {
  const fetchDest = firstHeaderValue(clientRequest.headers['sec-fetch-dest']) ?? '';
  const accept = firstHeaderValue(clientRequest.headers.accept) ?? '';
  const isDocument = /^(?:document|iframe|frame)$/i.test(fetchDest) || /\btext\/html\b/i.test(accept);
  if (!isDocument) {
    return false;
  }
  if (proxyResponse.statusCode === 401) {
    return true;
  }
  const location = firstHeaderValue(proxyResponse.headers.location);
  return (
    proxyResponse.statusCode !== undefined &&
    proxyResponse.statusCode >= 300 &&
    proxyResponse.statusCode < 400 &&
    location !== undefined &&
    /(?:^|\/)login(?:$|[/?#])/.test(location)
  );
}

/**
 * The self-drawn 401 page (NEXT-U-13). Same visual shell as respondError
 * (system font, prefers-color-scheme), but the copy arrives pre-localized via
 * GrafanaEmbedProxyStrings and the status is always 401.
 */
function respondUnauthorizedPage(response: http.ServerResponse, strings: GrafanaEmbedProxyStrings): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1.0">` +
      `<title>AT Grafana Proxy</title>` +
      `<style>` +
      `:root{color-scheme:light dark}` +
      `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
      `font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3f3f3;color:#1f1f1f}` +
      `main{max-width:36rem;padding:2rem;text-align:center}` +
      `h1{font-size:1.05rem;font-weight:600}` +
      `p{line-height:1.5;overflow-wrap:anywhere}` +
      `a{color:#005fb8}` +
      `@media (prefers-color-scheme:dark){body{background:#1f1f1f;color:#cccccc}a{color:#4daafc}}` +
      `</style></head>` +
      `<body><main><h1>${escapeHtml(strings.unauthorizedTitle)}</h1>` +
      `<p>${escapeHtml(strings.unauthorizedBody)}</p>` +
      `<p><a href="javascript:location.reload()">${escapeHtml(strings.retryLabel)}</a></p></main></body></html>`,
    'utf8'
  );
  response.writeHead(401, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length.toString()
  });
  response.end(body);
}
```

#### 2. `src/extension.ts`

`grafanaEmbedProxy` 构造，现在是：

```ts
  const grafanaEmbedProxy = new GrafanaEmbedProxy({ configManager, certTrustStore, log });
```

替换为：

```ts
  const grafanaEmbedProxy = new GrafanaEmbedProxy({
    configManager,
    certTrustStore,
    log,
    // NEXT-U-13: the proxy renders its 401 page itself and must not import
    // vscode, so the localized copy crosses the boundary as plain strings.
    strings: {
      unauthorizedTitle: t('Grafana rejected the token (HTTP 401).'),
      unauthorizedBody: t('Edit this instance in the AT Grafana sidebar and update its Service Account Token, then retry.'),
      retryLabel: t('Retry')
    }
  });
```

#### 3. `src/tree/GrafanaTreeItems.ts`

`describeTreeError` 的 `case 'auth':`，现在是：

```ts
      case 'auth':
        return t('Grafana rejected the token. Edit the instance to update the token.');
```

替换为：

```ts
      case 'auth':
        // NEXT-U-13: 401 (bad token) and 403 (valid token, missing role) are
        // opposite fixes; only a literal 403 gets the permissions message.
        return error.status === 403
          ? t('Grafana denied access (HTTP 403). The token works but lacks permission. Grant the service account the Viewer role.')
          : t('Grafana rejected the token. Edit the instance to update the token.');
```

（`GrafanaApiError` 已带公开 `status`——`GrafanaAgentToolService.toFailure` 就在用它。）

#### 4. `src/grafana/testGrafanaConnection.ts`

结果类型（第 4–6 行）改为：

```ts
export type GrafanaConnectionTestResult =
  | { ok: true }
  | { ok: false; reason: 'network' | 'tls' | 'auth' | 'error'; message: string; status?: number };
```

auth 分支（`if (status === 401 || status === 403) {`）改为：

```ts
        if (status === 401 || status === 403) {
          resolve({ ok: false, reason: 'auth', message: `Grafana rejected the token (HTTP ${status}).`, status });
          return;
        }
```

#### 5. `src/webview/GrafanaInstanceFormPanel.ts`

**tester 透传 status** — `createTofuConnectionTester` 的 `GrafanaApiError` 分支，现在是：

```ts
      if (error instanceof GrafanaApiError) {
        const reason =
          error.kind === 'auth' ? 'auth' : error.kind === 'tls' ? 'tls' : error.kind === 'network' ? 'network' : 'error';
        return { ok: false, reason, message: error.message };
      }
```

`return` 行替换为：

```ts
        return { ok: false, reason, message: error.message, status: error.kind === 'auth' ? error.status : undefined };
```

**消息映射** — `handleConnectionTest` 的收尾，现在是：

```ts
  const result = await runTest(url, token);
  await panel.webview.postMessage({
    type: 'connectionTestResult',
    payload: result.ok ? { ok: true, message: t('Connection succeeded.') } : { ok: false, message: result.message }
  });
```

替换为：

```ts
  const result = await runTest(url, token);
  await panel.webview.postMessage({
    type: 'connectionTestResult',
    payload: result.ok
      ? { ok: true, message: t('Connection succeeded.') }
      : { ok: false, message: describeConnectionFailure(result) }
  });
```

并在 `handleConnectionTest` 之后加模块级 helper：

```ts
/**
 * NEXT-U-13: 401 (paste a valid token) and 403 (grant the Viewer role) used
 * to share one English message from the tester. Only auth failures with a
 * recognized status are re-worded; every other failure keeps the tester's
 * own classified message (network/tls copy is already distinct).
 */
function describeConnectionFailure(result: { reason: string; message: string; status?: number }): string {
  if (result.reason === 'auth' && result.status === 401) {
    return t('Grafana rejected the token (HTTP 401). Paste a valid Service Account Token.');
  }
  if (result.reason === 'auth' && result.status === 403) {
    return t('Grafana denied access (HTTP 403). Grant the service account the Viewer role.');
  }
  return result.message;
}
```

#### 6. `l10n/bundle.l10n.zh-cn.json` — 追加 6 条

```json
  "Grafana rejected the token (HTTP 401).": "Grafana 拒绝了该 token（HTTP 401）。",
  "Edit this instance in the AT Grafana sidebar and update its Service Account Token, then retry.": "请在 AT Grafana 侧边栏编辑该实例并更新其 Service Account Token，然后重试。",
  "Retry": "重试",
  "Grafana denied access (HTTP 403). The token works but lacks permission. Grant the service account the Viewer role.": "Grafana 拒绝访问（HTTP 403）。token 有效但权限不足。请为该 service account 授予 Viewer 角色。",
  "Grafana rejected the token (HTTP 401). Paste a valid Service Account Token.": "Grafana 拒绝了该 token（HTTP 401）。请粘贴有效的 Service Account Token。",
  "Grafana denied access (HTTP 403). Grant the service account the Viewer role.": "Grafana 拒绝访问（HTTP 403）。请为该 service account 授予 Viewer 角色。"
```

### Tests

- `test/webview/GrafanaEmbedProxy.test.ts` 新增 describe `'self-drawn 401 page (NEXT-U-13)'`（复用该文件既有的「起一个假上游 http server + 起代理 + fetch」基建）：
  - 上游对文档请求（发 `accept: text/html`）回 401 → 代理响应 401、`content-type: text/html`，body 含注入的 `unauthorizedTitle`/`unauthorizedBody`/`retryLabel`（构造代理时传自定义 `strings` 断言注入生效），**不含**上游 body；
  - 上游对 `/api/...`（`accept: application/json`）回 401 → 原样 401 透传（body 为上游 body）；
  - 上游对文档请求回 302 `Location: /login` → 拦截为自绘 401 页；
  - `isUnauthorizedDocumentResponse` 单元用例：非文档 + 401 → false；文档 + 302 `Location: /d/xyz` → false。
- `test/tree/GrafanaTreeItems.test.ts`：`describeTreeError(new GrafanaApiError('auth', 'x', 403))` 命中 403 文案；`('auth', 'x', 401)` 与无 status 保持旧文案。
- `test/grafana/testGrafanaConnection.test.ts`：401/403 用例断言 `status` 字段（新增 403 假服务器用例，如缺）。
- `test/webview/GrafanaInstanceFormPanel.test.ts`：注入 `options.testConnection` 返回 `{ ok: false, reason: 'auth', status: 401, message: 'raw' }` → postMessage payload.message 为 401 专用文案；403 同理；`status` 缺失 → 保留原 message。

```bash
npx vitest run test/webview/GrafanaEmbedProxy.test.ts test/tree/GrafanaTreeItems.test.ts test/grafana/testGrafanaConnection.test.ts test/webview/GrafanaInstanceFormPanel.test.ts
npx vitest run test/i18n/nls.test.ts
npm run typecheck && npm test
```

### Commit

```
feat(embed): self-drawn 401 page and 401/403 copy split (NEXT-U-13)
```

**Out of scope.** 其他代理错误页（502/504/TLS）的本地化归 Part C Task 13（见 Parent correction #3）；自动重试/自动刷新 token；在 401 页内嵌「打开实例编辑表单」按钮（iframe 内无法调 VS Code 命令，链接只能 Retry）。

---

## Task 10 — MCP 配置首次安装改为 opt-in 弹窗（NEXT-Q-05）

**Goal.** 现状：首次激活时 `hubReady.then(() => ensureAtSeriesConfigForCurrentIde(...))` **静默写入**用户的 `mcp.json`（事后才有一次性 UX-17 通知）。改为：没有 consent 记录、且当前 IDE 配置里**不存在** `AT Series` 条目时，弹 modal「Install MCP Config / Not now」；已有 `AT Series` 条目（本插件或兄弟 AT 插件写过）时静默 ensure 仍然合法（那是对既有条目的修复，不是首次写入）。

**DoD.**

- [ ] 新装环境首次激活：出现 modal；点 Install → 写配置（UX-17 通知保留）并记录 consent；点 Not now → 不写、记录 declined、以后不再弹；按 Esc → 不写、**不记录**（下次激活再问一次）。
- [ ] `~/.cursor/mcp.json`（或对应 IDE 文件）已含 `AT Series` 条目时：不弹窗，静默 ensure（drift 修复）。
- [ ] 不支持的 IDE（plain VS Code / 无 workspace 的 Continue）：不弹窗、不写、无告警（安装命令仍会按 UX-03 解释原因）。
- [ ] 手动运行 `atGrafana.installMcpConfig` 视为 consent，之后激活恢复静默 ensure。
- [ ] `McpConfigInstaller.ts` 的新检测函数**只读**，任何失败（无文件、坏 JSON、不支持的 IDE）都视为「未安装」。
- [ ] `npm run typecheck && npm test`、nls 测试通过。
- [ ] **HUMAN**：干净的 Cursor profile 中验证首个激活弹窗与三种选择的行为。

### Files

| Path | Action |
|---|---|
| `src/mcp/McpConfigInstaller.ts` | Patch（新增 `hasAtSeriesConfigForCurrentIde`） |
| `src/extension.ts` | Patch（consent key + 流程替换 + 命令记录 consent） |
| `l10n/bundle.l10n.zh-cn.json` | Patch（3 条新字符串） |
| `test/mcp/McpConfigInstaller.test.ts` | Patch（新 describe） |
| `test/extension/ExtensionLifecycle.test.ts` | Patch（mock 工厂补导出 + 新用例） |
| `test/extension/McpInstallCommand.test.ts` | Patch（mock 工厂补导出） |
| `test/extension/InstanceCommands.test.ts` | Patch（mock 工厂补导出） |
| `test/extension/PanelCommands.test.ts` | Patch（mock 工厂补导出） |

### Exact edits

#### 1. `src/mcp/McpConfigInstaller.ts`

**imports** — 现有的 `@at-series/mcp-hub` import 块替换为（全部符号已核实存在于 `dist/index.d.ts`；`MCP_SERVER_DISPLAY_NAME === 'AT Series'`）：

```ts
import {
  continueMcpConfigPath,
  cursorMcpConfigPath,
  detectHostApp,
  ensureAtSeriesMcpConfig,
  hubJsPath,
  kiroMcpConfigPath,
  MCP_SERVER_DISPLAY_NAME,
  uninstallAtSeriesMcpConfig,
  type HostApp,
  type McpInstallerTarget
} from '@at-series/mcp-hub';
import { readFile } from 'node:fs/promises';
```

**新函数** — 加在 `ensureAtSeriesConfigForCurrentIde` 之前：

```ts
/**
 * NEXT-Q-05: read-only detection of an existing `AT Series` entry in the
 * current IDE's MCP config, so first activation can tell "already installed
 * -> silent ensure is repair, not a first write" apart from "never installed
 * -> ask before touching the user's config". Never writes. Every failure
 * mode (missing file, unparseable JSON, unsupported IDE) reads as `false`,
 * which at worst asks the user once.
 */
export async function hasAtSeriesConfigForCurrentIde(options: AtSeriesIdeMcpConfigOptions): Promise<boolean> {
  const hostApp = detectHostApp(options);
  const target = resolveMcpInstallerTarget(hostApp, options.workspaceFolder);
  if (!target) {
    return false;
  }
  if (target === 'continue') {
    // Continue's config is YAML and this repo deliberately has no YAML
    // parser; the installer writes MCP_SERVER_DISPLAY_NAME verbatim, so a
    // substring check is the honest fidelity available here.
    const text = await readFileOrUndefined(continueMcpConfigPath(options.workspaceFolder ?? ''));
    return text !== undefined && text.includes(MCP_SERVER_DISPLAY_NAME);
  }
  // cursor: ~/.cursor/mcp.json; kiro: ~/.kiro/settings/mcp.json -- both are
  // `{ "mcpServers": { "AT Series": ... } }` JSON (see mcp-hub's
  // ensureJsonIdeMcpConfig, shared by both targets).
  const path = target === 'cursor' ? cursorMcpConfigPath(options.home) : kiroMcpConfigPath(options.home);
  const text = await readFileOrUndefined(path);
  if (text === undefined) {
    return false;
  }
  try {
    const parsed = JSON.parse(text) as { mcpServers?: unknown };
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.mcpServers === 'object' &&
      parsed.mcpServers !== null &&
      Object.prototype.hasOwnProperty.call(parsed.mcpServers, MCP_SERVER_DISPLAY_NAME)
    );
  } catch {
    return false;
  }
}

async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
```

#### 2. `src/extension.ts`

**import** — 更新为：

```ts
import {
  ensureAtSeriesConfigForCurrentIde,
  hasAtSeriesConfigForCurrentIde,
  resolveMcpInstallerTarget,
  uninstallAtSeriesConfigForCurrentIde
} from './mcp/McpConfigInstaller';
```

**consent key** — 紧跟 `MCP_CONFIG_NOTIFIED_KEY` 常量之后加：

```ts
/** `context.globalState` key: MCP install consent -- 'granted' | 'declined' (NEXT-Q-05). */
const MCP_INSTALL_CONSENT_KEY = 'atGrafana.mcpInstallConsent';
```

**流程替换** — 整块替换现有的（以下面两行为锚点定位起止）：

```ts
  void hubReady
    .then(() => ensureAtSeriesConfigForCurrentIde({ ...hostEnv, workspaceFolder: currentWorkspaceFolder() }))
    ...（中间 UX-17 通知逻辑）...
    .catch((error) => {
      log.error(`mcp-config: could not be updated: ${formatError(error)}`);
      ...
    });
```

替换为：

```ts
  // NEXT-Q-05: silent ensure survives in exactly two cases -- consent was
  // recorded earlier, or an `AT Series` entry already exists (then ensure is
  // a repair of something the user already has, not a first write). A brand
  // new environment gets a modal instead; an unsupported IDE gets nothing
  // (the install command still explains why on demand, UX-03).
  const ensureMcpConfigSilently = (): Promise<void> =>
    ensureAtSeriesConfigForCurrentIde({ ...hostEnv, workspaceFolder: currentWorkspaceFolder() }).then((result) => {
      // UX-17 unchanged: the first successful write still gets one visible,
      // dismissible mention -- once per machine, never again while the
      // config stays up to date.
      if (result?.updated === true && context.globalState.get<boolean>(MCP_CONFIG_NOTIFIED_KEY, false) !== true) {
        void context.globalState.update(MCP_CONFIG_NOTIFIED_KEY, true);
        const uninstallActionTitle = t('How to Undo');
        void vscode.window
          .showInformationMessage(
            t(
              'AT Grafana installed the AT Series MCP config for this IDE so AI agents can query your Grafana instances (read-only, per-instance opt-in).'
            ),
            uninstallActionTitle
          )
          .then((picked) => {
            if (picked === uninstallActionTitle) {
              showTimedNotification(
                t('Run "AT Grafana: Uninstall AT Series MCP Config" from the Command Palette to remove it.'),
                'info',
                8000
              );
            }
          });
      }
    });

  const promptForMcpInstallConsent = async (): Promise<void> => {
    const installTitle = t('Install MCP Config');
    const notNowTitle = t('Not now');
    const picked = await vscode.window.showInformationMessage(
      t(
        'AT Grafana can install the shared AT Series MCP config for this IDE so AI agents can query your Grafana instances (read-only, per-instance opt-in). Install it now?'
      ),
      { modal: true },
      installTitle,
      notNowTitle
    );
    if (picked === installTitle) {
      void context.globalState.update(MCP_INSTALL_CONSENT_KEY, 'granted');
      await ensureMcpConfigSilently();
      return;
    }
    // "Not now" means "stop asking"; Esc records nothing, so a user who
    // dismissed by accident is asked once more on the next activation.
    if (picked === notNowTitle) {
      void context.globalState.update(MCP_INSTALL_CONSENT_KEY, 'declined');
    }
  };

  void hubReady
    .then(async () => {
      if (!resolveMcpInstallerTarget(hostApp, currentWorkspaceFolder())) {
        return;
      }
      const consent = context.globalState.get<string>(MCP_INSTALL_CONSENT_KEY);
      if (consent === 'granted') {
        await ensureMcpConfigSilently();
        return;
      }
      if (await hasAtSeriesConfigForCurrentIde({ ...hostEnv, workspaceFolder: currentWorkspaceFolder() })) {
        await ensureMcpConfigSilently();
        return;
      }
      if (consent === 'declined') {
        return;
      }
      await promptForMcpInstallConsent();
    })
    .catch((error) => {
      log.error(`mcp-config: could not be updated: ${formatError(error)}`);
      showWarningNotification(
        t('AT Series MCP config could not be updated: {message}', { message: formatError(error) }),
        [repairMcpAction, openLogAction]
      );
    });
```

**安装命令记录 consent** — `installMcpConfigCommand` 回调体第一行（`try {` 之前）插入：

```ts
    // Running the install command IS consent (NEXT-Q-05): record it so later
    // activations silently keep the entry repaired.
    void context.globalState.update(MCP_INSTALL_CONSENT_KEY, 'granted');
```

#### 3. `l10n/bundle.l10n.zh-cn.json` — 追加 3 条

```json
  "Install MCP Config": "安装 MCP 配置",
  "Not now": "暂不",
  "AT Grafana can install the shared AT Series MCP config for this IDE so AI agents can query your Grafana instances (read-only, per-instance opt-in). Install it now?": "AT Grafana 可以为当前 IDE 安装共享的 AT Series MCP 配置，让 AI Agent 查询你的 Grafana 实例（只读，按实例显式开启）。现在安装吗？"
```

#### 4. 测试 mock 工厂（4 个文件，同一处改法）

`extension.ts` 现在从 `McpConfigInstaller` 多 import 了两个符号，因此 **`vi.mock('../../src/mcp/McpConfigInstaller', ...)` 的每个工厂都必须补齐导出**，否则运行时 undefined。四个文件：`test/extension/ExtensionLifecycle.test.ts`、`test/extension/McpInstallCommand.test.ts`、`test/extension/InstanceCommands.test.ts`、`test/extension/PanelCommands.test.ts`。以 ExtensionLifecycle 为例，`vi.hoisted` 里加：

```ts
  hasAtSeriesConfigForCurrentIde: vi.fn(async () => true),
  resolveMcpInstallerTarget: vi.fn(() => 'cursor' as const)
```

mock 工厂改为：

```ts
vi.mock('../../src/mcp/McpConfigInstaller', () => ({
  ensureAtSeriesConfigForCurrentIde: mocks.ensureAtSeriesConfigForCurrentIde,
  uninstallAtSeriesConfigForCurrentIde: mocks.uninstallAtSeriesConfigForCurrentIde,
  hasAtSeriesConfigForCurrentIde: mocks.hasAtSeriesConfigForCurrentIde,
  resolveMcpInstallerTarget: mocks.resolveMcpInstallerTarget
}));
```

默认 `hasAtSeriesConfigForCurrentIde → true` 使既有的激活类用例继续走「静默 ensure」路径（行为最贴近旧断言）。若个别既有断言依赖「激活即调用 ensure」，此默认值即可保持其通过；如有断言计数差异，按新流程更新断言而不是回退产品逻辑。

### Tests

- `test/mcp/McpConfigInstaller.test.ts` 新 describe `'hasAtSeriesConfigForCurrentIde (NEXT-Q-05)'`（用 `fs.mkdtemp` 临时 home，`appName: 'Cursor'` 等驱动 `detectHostApp`）：
  - 无 `~/.cursor/mcp.json` → false；
  - 写入 `{ "mcpServers": { "AT Series": { "command": "node" } } }` → true；
  - 写入 `{ "mcpServers": { "Other": {} } }` → false；
  - 坏 JSON → false；
  - kiro：`<home>/.kiro/settings/mcp.json` 同上（`appName: 'Kiro'`）；
  - continue（带 workspaceFolder）：YAML 文本含 `AT Series` → true，不含 → false；无 workspaceFolder → false；
  - plain VS Code（`appName: 'Visual Studio Code'`，无 target）→ false。
- `test/extension/ExtensionLifecycle.test.ts`（或新增 `McpConsent` 用例组）：
  - `hasAtSeriesConfigForCurrentIde → false` 且 globalState 无 consent：`vscode.window.showInformationMessage` 以 `{ modal: true }` 被调用；mock 返回 Install 标题 → `ensureAtSeriesConfigForCurrentIde` 被调用且 consent 写为 `'granted'`；
  - mock 返回 Not now 标题 → 不调 ensure，consent 写为 `'declined'`；
  - mock 返回 `undefined`（Esc）→ 不调 ensure、consent 不写；
  - globalState 预置 `'declined'` → 既不弹窗也不 ensure；
  - `hasAtSeriesConfigForCurrentIde → true` → 不弹窗、直接 ensure；
  - `resolveMcpInstallerTarget → undefined` → 什么都不发生。
- `test/extension/McpInstallCommand.test.ts`：运行 `atGrafana.installMcpConfig` 后 `globalState.update` 收到 `('atGrafana.mcpInstallConsent', 'granted')`。

```bash
npx vitest run test/mcp/McpConfigInstaller.test.ts test/extension
npx vitest run test/i18n/nls.test.ts
npm run typecheck && npm test
```

### Commit

```
feat(mcp): first-run install consent prompt instead of silent write (NEXT-Q-05)
```

**Out of scope.** 卸载流程不变；不给 consent 加设置项（globalState 足够，`Not now` 后仍可随时手动运行安装命令）；不做「每 N 天再问」；不改 UX-17 通知文案。

---

## Task 11 — `contributes.walkthroughs` 新手引导（NEXT-U-02 / P-10）

**Goal.** 添加一条 Getting Started walkthrough（VS Code Welcome → Walkthroughs 入口），四步：添加实例 → Test Connection（TOFU）→ 打开 Agent gate → 安装 MCP。标题/描述走 `%nls%` 双语；步骤 media 用仓库内 markdown（英文，媒体 markdown 不经过 nls 机制，与代理错误页同为 UX-12 类已接受限制）。`scripts/package.mjs` 已整目录复制 `media/`，walkthrough 素材自动进包，无需改打包脚本。

**DoD.**

- [ ] `package.json` `contributes.walkthroughs` 含 `atGrafana.gettingStarted`，4 步齐全，每步 media markdown 文件真实存在。
- [ ] 有命令的步骤配置 `completionEvents`（`onCommand:`）；Test Connection 步（表单内按钮，无命令）留空由用户手勾。
- [ ] 全部 title/description 是**整体** `%nls%` 占位符，且 EN/zh 两个 nls 文件同步（`nls.test.ts` 的 `leaves no nls key unused` / `never embeds a placeholder inside a longer string` 都会校验）。
- [ ] 新增 `test/extension/WalkthroughContribution.test.ts` 通过。
- [ ] `npm run typecheck && npm test` 通过。
- [ ] **HUMAN**：VS Code/Cursor 里打开 Welcome 页确认 walkthrough 出现、步骤可完成。

### Files

| Path | Action |
|---|---|
| `package.json` | Patch（`contributes.walkthroughs`） |
| `package.nls.json` / `package.nls.zh-cn.json` | Patch（10 个新 key） |
| `media/walkthrough/add-instance.md` | **Create** |
| `media/walkthrough/test-connection.md` | **Create** |
| `media/walkthrough/agent-access.md` | **Create** |
| `media/walkthrough/install-mcp.md` | **Create** |
| `test/extension/WalkthroughContribution.test.ts` | **Create** |

### Exact edits

#### 1. `package.json` — 在 `"viewsWelcome"` 数组之后、`"configuration"` 之前插入

```json
    "walkthroughs": [
      {
        "id": "atGrafana.gettingStarted",
        "title": "%atGrafana.walkthrough.gettingStarted.title%",
        "description": "%atGrafana.walkthrough.gettingStarted.description%",
        "steps": [
          {
            "id": "atGrafana.walkthrough.addInstance",
            "title": "%atGrafana.walkthrough.addInstance.title%",
            "description": "%atGrafana.walkthrough.addInstance.description%",
            "media": { "markdown": "media/walkthrough/add-instance.md" },
            "completionEvents": ["onCommand:atGrafana.addInstance"]
          },
          {
            "id": "atGrafana.walkthrough.testConnection",
            "title": "%atGrafana.walkthrough.testConnection.title%",
            "description": "%atGrafana.walkthrough.testConnection.description%",
            "media": { "markdown": "media/walkthrough/test-connection.md" }
          },
          {
            "id": "atGrafana.walkthrough.agentAccess",
            "title": "%atGrafana.walkthrough.agentAccess.title%",
            "description": "%atGrafana.walkthrough.agentAccess.description%",
            "media": { "markdown": "media/walkthrough/agent-access.md" },
            "completionEvents": ["onCommand:atGrafana.toggleAgentAccess"]
          },
          {
            "id": "atGrafana.walkthrough.installMcp",
            "title": "%atGrafana.walkthrough.installMcp.title%",
            "description": "%atGrafana.walkthrough.installMcp.description%",
            "media": { "markdown": "media/walkthrough/install-mcp.md" },
            "completionEvents": ["onCommand:atGrafana.installMcpConfig"]
          }
        ]
      }
    ],
```

#### 2. `package.nls.json` — 追加

```json
  "atGrafana.walkthrough.gettingStarted.title": "Get started with AT Grafana",
  "atGrafana.walkthrough.gettingStarted.description": "Connect a Grafana instance, confirm its TLS certificate, open the Agent gate, and install the AT Series MCP config.",
  "atGrafana.walkthrough.addInstance.title": "Add a Grafana instance",
  "atGrafana.walkthrough.addInstance.description": "Connect AT Grafana to your Grafana with a Service Account Token (Viewer role is enough).\n[Add Instance](command:atGrafana.addInstance)",
  "atGrafana.walkthrough.testConnection.title": "Test the connection (Trust-On-First-Use)",
  "atGrafana.walkthrough.testConnection.description": "In the instance form, click Test Connection. On the first HTTPS connection you confirm the certificate fingerprint once; network, TLS, and 401/403 failures are reported as distinct messages.",
  "atGrafana.walkthrough.agentAccess.title": "Allow background Agent access",
  "atGrafana.walkthrough.agentAccess.description": "Right-click the instance in the AT Grafana sidebar and choose Toggle Agent Access (off by default). Only opted-in instances are visible to MCP tools.",
  "atGrafana.walkthrough.installMcp.title": "Install the AT Series MCP config",
  "atGrafana.walkthrough.installMcp.description": "Register the shared AT Series MCP server so AI agents can call the read-only grafana_* tools.\n[Install MCP Config](command:atGrafana.installMcpConfig)"
```

#### 3. `package.nls.zh-cn.json` — 追加

```json
  "atGrafana.walkthrough.gettingStarted.title": "开始使用 AT Grafana",
  "atGrafana.walkthrough.gettingStarted.description": "连接 Grafana 实例、确认 TLS 证书、打开 Agent 访问开关，并安装 AT Series MCP 配置。",
  "atGrafana.walkthrough.addInstance.title": "添加 Grafana 实例",
  "atGrafana.walkthrough.addInstance.description": "使用 Service Account Token（Viewer 角色即可）把 AT Grafana 连接到你的 Grafana。\n[添加实例](command:atGrafana.addInstance)",
  "atGrafana.walkthrough.testConnection.title": "测试连接（TLS 首次信任）",
  "atGrafana.walkthrough.testConnection.description": "在实例表单中点击 Test Connection。首次 HTTPS 连接时需确认一次证书指纹；网络、TLS、401/403 三类失败会分别报告。",
  "atGrafana.walkthrough.agentAccess.title": "允许 Agent 后台访问",
  "atGrafana.walkthrough.agentAccess.description": "在 AT Grafana 侧边栏右键实例，选择「Toggle Agent Access」（默认关闭）。只有显式开启的实例才对 MCP 工具可见。",
  "atGrafana.walkthrough.installMcp.title": "安装 AT Series MCP 配置",
  "atGrafana.walkthrough.installMcp.description": "注册共享的 AT Series MCP 服务器，让 AI Agent 调用只读的 grafana_* 工具。\n[安装 MCP 配置](command:atGrafana.installMcpConfig)"
```

#### 4. media markdown（4 个新文件，简洁英文；示例给出第一个，其余按同风格写）

**`media/walkthrough/add-instance.md`：**

```markdown
# Add a Grafana instance

1. In Grafana: **Administration → Users and access → Service accounts** → add a service
   account with the **Viewer** role, then create a token (shown only once).
2. Run **AT Grafana: Add Instance** from the Command Palette.
3. Enter a label, the base URL (e.g. `https://grafana.example.com`), and paste the token.

The instance appears in the AT Grafana sidebar's Dashboards and Alerts views.
```

**`media/walkthrough/test-connection.md`**：Test Connection 按钮位置、TOFU 指纹确认一次、指纹变化会阻断直到重新确认、401 vs 403 含义（对应 T9 文案）。
**`media/walkthrough/agent-access.md`**：默认关闭、右键 Toggle Agent Access 或表单勾选、开启后 17 个工具可用、关闭立即生效并从 `grafana_list_instances` 消失。
**`media/walkthrough/install-mcp.md`**：共享 `AT Series` 条目（Cursor `~/.cursor/mcp.json` / Kiro / Continue）、与其他 AT 系插件共享同一条目、卸载命令名。

### Tests

**新建 `test/extension/WalkthroughContribution.test.ts`**（读盘校验，风格照 `test/i18n/nls.test.ts`）：

```ts
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface WalkthroughStep {
  id: string;
  title: string;
  description: string;
  media: { markdown?: string };
  completionEvents?: string[];
}
interface Manifest {
  contributes: {
    commands: Array<{ command: string }>;
    walkthroughs?: Array<{ id: string; title: string; description: string; steps: WalkthroughStep[] }>;
  };
}

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as Manifest;
const walkthrough = manifest.contributes.walkthroughs?.find((w) => w.id === 'atGrafana.gettingStarted');

describe('getting-started walkthrough (NEXT-U-02)', () => {
  it('contributes the walkthrough with its four steps in onboarding order', () => {
    expect(walkthrough).toBeDefined();
    expect(walkthrough!.steps.map((step) => step.id)).toEqual([
      'atGrafana.walkthrough.addInstance',
      'atGrafana.walkthrough.testConnection',
      'atGrafana.walkthrough.agentAccess',
      'atGrafana.walkthrough.installMcp'
    ]);
  });

  it('ships every step media markdown file it references', () => {
    for (const step of walkthrough!.steps) {
      expect(step.media.markdown, step.id).toBeDefined();
      expect(existsSync(resolve(process.cwd(), step.media.markdown!)), step.media.markdown).toBe(true);
    }
  });

  it('only names contributed commands in completionEvents', () => {
    const commands = new Set(manifest.contributes.commands.map((entry) => entry.command));
    for (const step of walkthrough!.steps) {
      for (const event of step.completionEvents ?? []) {
        const match = /^onCommand:(.+)$/.exec(event);
        expect(match, `${step.id}: ${event}`).not.toBeNull();
        expect(commands.has(match![1]!), event).toBe(true);
      }
    }
  });

  it('localizes every title and description through whole %nls% placeholders', () => {
    const wholePlaceholder = /^%[\w.-]+%$/;
    expect(walkthrough!.title).toMatch(wholePlaceholder);
    expect(walkthrough!.description).toMatch(wholePlaceholder);
    for (const step of walkthrough!.steps) {
      expect(step.title, step.id).toMatch(wholePlaceholder);
      expect(step.description, step.id).toMatch(wholePlaceholder);
    }
  });
});
```

```bash
npx vitest run test/extension/WalkthroughContribution.test.ts test/i18n/nls.test.ts
npm run typecheck && npm test
```

### Commit

```
feat(onboarding): getting-started walkthrough contribution (NEXT-U-02)
```

**Out of scope.** 截图/GIF 素材（markdown 文本足够，图片留给后续人工补充）；`onView:` 类 completionEvents 实验；把 walkthrough 设为 `featuredFor`。

---

## Task 12 — 同步 `docs/usage.md` / `docs/usage.zh-CN.md`（Wave 0–3 + Tasks 7–11 UX）

**Goal.** usage 文档已是 EN/zh 双文件（`docs/usage.md` + `docs/usage.zh-CN.md`——**不是** English-only，因此主要 patch 这两个；`docs/README.zh-CN.md` 仅在其复述了「MCP 配置自动写入」这类被 T10 推翻的说法时顺带修正）。补齐：context menus、Test Connection TOFU（已有，微调）、Agent gate 右键路径、T7 告警过滤、T9 401 页、T10 opt-in、T11 walkthrough。**概念上依赖 T7–T11 已落地**；若某任务未落地，跳过对应段落并在 commit message 注明。

**DoD.**

- [ ] EN/zh 两个 usage 文件内容对等（zh 不是逐字翻译也要点对点覆盖）。
- [ ] 不再有「首次激活自动/静默写入 MCP 配置」的表述；opt-in 弹窗与「已有条目静默修复」都写清。
- [ ] 告警过滤、401 自绘页、右键菜单、walkthrough 均有对应段落。
- [ ] `rg -n "silently|静默" docs/usage.md docs/usage.zh-CN.md docs/README.zh-CN.md README.md` 无过时表述残留。
- [ ] `npm run typecheck && npm test` 通过（纯文档，应零影响；跑一遍确认没碰坏东西）。

### Files

| Path | Action |
|---|---|
| `docs/usage.md` | Patch |
| `docs/usage.zh-CN.md` | Patch（镜像全部改动） |
| `docs/README.zh-CN.md` | 条件 Patch（仅当复述了被推翻的 MCP 自动写入说法） |

### Exact edits（EN；zh 镜像翻译，风格照 `usage.zh-CN.md` 现有行文）

**§1「Add the instance in the extension」step 3** — 现句保留，句尾追加一句：

```markdown
   Clicking **Test connection** against a new HTTPS host is also what triggers the one-time certificate fingerprint confirmation described in step 4.
```

**§2「Enable background Agent access」** — 在编号列表后追加：

```markdown
You can also right-click the instance in either sidebar view and choose **Toggle Agent Access** — no need to open the edit form.
```

**§3「Browse dashboards and alerts」** — 在现有三个 bullet 后追加：

```markdown
- Use the filter buttons in the **Alerts** view title bar to filter rules by title and/or by state (`firing` / `pending` / `normal` / `unknown` — the same four values `grafana_list_alert_rules` accepts as `states`). Active filters survive a window reload, the current filter is shown above the tree, and a clear-filter button appears while any filter is active. Group icons reflect the worst state among the rules that remain visible.
- Right-click an instance for **Edit Instance**, **Toggle Agent Access**, and **Delete Instance**; right-click a dashboard or alert rule for **Open in Browser** and **Copy Grafana URL**.
- If an embedded dashboard or alert view shows **"Grafana rejected the token (HTTP 401)"**, the instance's Service Account Token was rotated or revoked. Edit the instance in the sidebar, paste the new token, and click **Retry** on that page. A **403** message instead means the token is valid but the service account lacks the Viewer role.
```

**§4「Connect an MCP-capable IDE client」** — 把第 1–2 步之前插入一段（并把原第 1 步的动词从「Run」弱化为「or run … at any time」语气）：

```markdown
On the first activation in a supported IDE (Cursor, Kiro, or Continue with a workspace open), AT Grafana asks before touching your MCP configuration: **Install MCP Config** writes the shared `AT Series` entry; **Not now** records your choice and the prompt never returns (run the install command below whenever you change your mind). If an `AT Series` entry already exists — for example written by another AT-family plugin — AT Grafana keeps it repaired silently, since that maintains an entry you already have rather than installing a new one.
```

**§4 工具目录段** — `grafana_generate_deeplink` 一句更新为：

```markdown
`grafana_generate_deeplink` always returns `grafanaUrl`; `openInIde` (default false) can open dashboards **and alert rules** in the IDE, while Explore links stay URL-only.
```

**新增 §5（原 SKILL 链接段之前）：**

```markdown
## 5. Guided setup (walkthrough)

Open **Help → Welcome → Walkthroughs → Get started with AT Grafana** for a guided version of this page: add an instance, run Test Connection (TLS Trust-On-First-Use), enable background Agent access, and install the AT Series MCP config.
```

**`docs/usage.zh-CN.md`** — 逐段镜像以上全部改动（§1 步骤 3 补一句、§2 右键路径、§3 三个新 bullet、§4 opt-in 段 + deeplink 句、新增 §5）。
**`docs/README.zh-CN.md`** — 先 `rg -n "自动|静默|首次激活" docs/README.zh-CN.md`：若命中「首次激活自动写入 MCP 配置」类表述，改为「首次激活会**询问**是否安装（已存在 AT Series 条目时静默保持修复）」；无命中则不改。

### Tests

无产品测试。验证命令：

```bash
rg -n "openInIde" docs/usage.md docs/usage.zh-CN.md        # 应描述 dashboard+alertRule
rg -n "Not now|暂不" docs/usage.md docs/usage.zh-CN.md      # opt-in 已写入
rg -n "401" docs/usage.md docs/usage.zh-CN.md               # 401 页已写入
npm run typecheck && npm test
```

### Commit

```
docs: sync usage guides with Wave 0-3 and Tasks 7-11 UX
```

**Out of scope.** `README.md`（英文 README 的数字/徽章归 Part A Task 1）；`docs/features*.md`（如需扩展另开任务）；不为 T13–T18 尚未落地的行为预写文档。

---

## Part B 完成检查单

- [ ] T7–T10 按序单独提交，`src/extension.ts` 无合并冲突残留。
- [ ] `npx vitest run test/i18n/nls.test.ts` 最终通过（T7/T9/T10/T11 都动了 NLS 面）。
- [ ] `rg "from 'vscode'" src/webview/GrafanaEmbedProxy.ts src/agent/GrafanaAgentToolService.ts src/grafana/grafanaDeeplink.ts src/grafana/GrafanaHttpClient.ts` 零命中。
- [ ] 全量 `npm run typecheck && npm test` 通过。
- [ ] **HUMAN** DoD（真实 Grafana 上的过滤/401 页/consent 弹窗/walkthrough 目检）如实上报，未伪造。
