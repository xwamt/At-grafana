# AT Grafana — 后续完善路线图（初始产品 → 可发布）

**Status:** Proposed（建议文档，本文件不改运行时代码）  
**Date:** 2026-08-27  
**Baseline:** 当前工作树 = v0.1.3 + [`2026-08-27-perf-completeness-ux-optimization.md`](2026-08-27-perf-completeness-ux-optimization.md) Wave 0–3 已落地（709 单测）。**本路线图不再把那些项列为待办。**  
**Method:** 三个子代理并行审阅，模型均为 `claude-fable-5-thinking-xhigh`：

| 维度 | 子代理 | 焦点 |
|---|---|---|
| 产品能力 | `bc-3b7c224a-cbcf-525e-9935-0321052496f2` | SRE 日常 / 与官方 mcp-grafana 边界 / 版本切片 |
| 发布与质量 | `bc-1591ee19-7377-5780-ae10-8cd74bc0bc02` | CI、VSIX、活体验证、IDE 矩阵、首启同意 |
| 用户与 Agent | `bc-034c9176-0ba9-5867-ac72-2b4ec3cf22df` | 优化后旅程剩余流失、SKILL、嵌入 401 |

**约束：** 不重开 V1 非目标，除非单独写 ADR。写操作、Live WebSocket、多 Org 真实现、`d-solo`、50 工具复刻、Tempo 类型化工具均默认保持关闭。

---

## 1. 成熟度判断

代码成熟度已经超过多数 0.x 扩展：17 个只读 MCP 工具、SecretStorage / TOFU / 路径禁锢、实例级 Agent 闸门、709 单测。**产品成熟度落在「内部可用」，还没到「可发布」。**

| 阶段 | 状态 | 依据 |
|---|---|---|
| 原型 | 已越过 | 契约、安全边界、单测、CI typecheck+test |
| 内部可用 | **当前位置** | 会装 VSIX 的工程师可以日常用；Wave 0–3 清掉了 HTTPS 挂起、告警规则丢 PromQL、自签名第一天死胡同 |
| 可发布 | 未达到 | DoD 1/2/3/9 从未在真实 Grafana / 真实 MCP 客户端执行；`publisher: "local"`；CI 不产 VSIX；激活静默写 `mcp.json` |

一句话：**后续重心不是再堆能力，而是把已写的承诺变成已证明的承诺，再打通安装与上架。**

---

## 2. 建议版本切片

```
0.1.4  验证收尾     跑活体清单、校准上限、诚实文档、publisher/CHANGELOG 准备
0.2.0  可安装体验   walkthrough、告警树过滤、openInIde 告警、401 错误页、CI 产 VSIX、首启同意
0.2.x  顺手体验     收藏/最近、时间范围打开、Explore-in-IDE、E2E 半自动、逃生舱配方
V2     需新 ADR     silence 写操作、Live WS、单实例多 Org（仅当文档解法不够）
```

`master` 上的 0.1.3 若尚未合并 Wave 0–3，应**先合那个实现分支**，再按本路线图推进。不要在 0.1.3 上重复修 keep-alive / `get_alert_rule.data`。

---

## 3. 优先顺序（跨维度合并 Top 10）

| # | ID | 一句话 | 切片 | 量 | 新 ADR |
|---|---|---|---|---|---|
| 1 | NEXT-Q-02 / P-01 | **执行** `docker-compose.smoke.yml` + [活体清单](2026-08-27-live-smoke-checklist.md)，关闭 DoD 1/2/3/9 与 alert history / 嵌入重写 / 12h·5MiB 校准 | 0.1.4 | M（人工） | 否 |
| 2 | NEXT-Q-03 / P-03 | 真实 `publisher`、根目录 `CHANGELOG.md`、tag→VSIX（先不自动 publish） | 0.1.4 | S–M | 否 |
| 3 | NEXT-Q-05 | 首次激活改为「安装 MCP 配置 / 暂不」，已有 AT Series 条目可静默 ensure | 0.2.0 上架前 | S–M | 否 |
| 4 | NEXT-Q-01 | CI 跑 `npm run package` 并上传 VSIX + 内容断言 | 0.2.0 | S | 否 |
| 5 | NEXT-U-05 | SKILL 增加 incident playbook（告警→定义→dashboard→Prom→annotations→deeplink） | 可提前 | S | 否 |
| 6 | NEXT-U-01 | 告警树标题过滤 + 状态筛选（对称 MCP `states`） | 0.2.0 | M | 否 |
| 7 | NEXT-U-12① | `grafana_generate_deeplink` 的 `openInIde` 支持 `alertRule`（面板已存在） | 0.2.0 | S | 否 |
| 8 | NEXT-U-13 | 嵌入文档路由 401 自绘「去编辑实例更新 Token」；树/测试区分 401 vs 403 | 0.2.0 | S–M | 否 |
| 9 | NEXT-U-02 / P-10 | `contributes.walkthroughs`：加实例 → TOFU → 开闸门 → 装 MCP | 0.2.0 | M | 否 |
| 10 | NEXT-P-11 | **只写 ADR-008**：V2 唯一写入口 = Alertmanager silence；重审 ADR-002 单构建变体 | V2 文本先行 | ADR S | **是** |

---

## 4. 产品能力（NEXT-P）

### 0.1.4

| ID | 主题 | 价值 | 量 | 说明 |
|---|---|---|---|---|
| NEXT-P-01 | 活体冒烟关闭 DoD | 发布第一闸门 | M | 清单与 compose 已在仓内，缺一次真实执行。嵌入正则 vs 真实前端是最高实操风险 |
| NEXT-P-02 | Grafana 9.1 / 10 / 11 / 12 矩阵 | 诚实兼容声明 | M | 至少 latest + 9.1；嵌套文件夹、`folderUIDs`、`notification_settings`、state history 有版本下限 |
| NEXT-P-03 | publisher / CHANGELOG / Release VSIX | 别人能装 | M | Marketplace/Open VSX 放到 0.2、活体通过之后 |
| NEXT-P-04 | 多 Org **文档解法** | 消除「不能用」误读 | S | Token 本就是 org 作用域：每 org 一个实例。单实例 `X-Grafana-Org-Id` 留 V2 |
| NEXT-P-14 | 书面拒绝 OnCall / Incident / Sift | 边界清晰 | S | 用户画像是自建 Grafana；Cloud IRM 指向官方 mcp-grafana |

### 0.2

| ID | 主题 | 价值 | 量 | ADR |
|---|---|---|---|---|
| NEXT-P-05 | `@vscode/test-electron` + compose 半自动 E2E | 每次版本能重跑冒烟 | L | 否；先本地可跑，CI 可选 |
| NEXT-P-06 | Agent `list_dashboards` / `list_folders` 显式 `limit`/`page` + `truncated` | 大 org「找不到 ≠ 不存在」 | S | 修订 ADR-006 说明即可 |
| NEXT-P-07 | Explore-in-IDE | Agent 查完 PromQL 交还 IDE | M | **修订 ADR-007**（原文写明 Explore 不能 openInIde） |
| NEXT-P-08 | 树：本地收藏、tags 展示、右键带时间范围打开 | 日常盯盘 | S–M | 否。**不要**用 Grafana `starred=true`（Service Account 无星标） |
| NEXT-P-09 | 技能里 Tempo/ES 等 escape-hatch **配方** | Agent 不再猜 path | S | 新类型化工具才需要 ADR |
| NEXT-P-10 | walkthrough + 嵌入 loader i18n | 市场新用户第一小时 | S–M | 否 |
| NEXT-P-13 | `viewPanel` UI 入口，**不做 `d-solo`** | 「只看这一块图」 | S | `d-solo` 维持非目标 |

### V2（先 ADR）

| ID | 主题 | ADR | 量 | 备注 |
|---|---|---|---|---|
| NEXT-P-11 | 告警 silence（创建/过期）为**唯一**写入口 | ADR-008 + 重审 ADR-002 | 实现 L | Viewer 角色不够写；需独立「允许 Agent 写」开关，默认关，不进 autoApprove |
| NEXT-P-12 | Grafana Live WebSocket 隧道 | 修订 ADR-003 | L | 依赖 HTTP 嵌入已被活体证明；与 `retainContextWhenHidden` 成本一起重估 |

---

## 5. 发布与质量（NEXT-Q）

| ID | 主题 | 切片 | 量 |
|---|---|---|---|
| NEXT-Q-01 | CI `npm run package` + VSIX artifact + unzip 断言（hub.js、l10n、无 .map） | 0.2.0 | S |
| NEXT-Q-02a | **人**跑一遍活体清单并回填 `docs/releases/0.1.0.md` Pending | 0.1.4 硬前置 | S |
| NEXT-Q-02b | CI 用 pin 住的 Grafana 镜像跑无 UI 的 API+重写断言 | 0.2.x | M |
| NEXT-Q-03 | 真实 publisher；越晚改扩展 ID 代价越大 | 立刻准备 | S–M |
| NEXT-Q-04 | IDE 口径：已验证 Cursor/Kiro/Continue；VS Code 仅 UI；Antigravity/Qoder/Trae 改为「未验证」。原生 MCP 在 hub 仓 | 口径 0.2.0 | S / 原生 M |
| NEXT-Q-05 | MCP 首启 opt-in（上架硬门槛） | 0.2.0 | S–M |
| NEXT-Q-06 | `@vscode/test-electron`：写**一个**激活冒烟，或删掉死依赖 | 0.2.x | S–M |
| NEXT-Q-07 | 12h/5MiB 对真实 Prom 跑一次，结论写进决策（哪怕「维持默认」） | 随 smoke | S |
| NEXT-Q-08 | 收一份真实 Grafana `index.html`（记版本）进 `test-fixtures/` 喂给重写测试 | 0.2.0 | S |
| NEXT-Q-09 | 活体确认 `/api/v1/rules/history`；可能是 17 工具里唯一从未在真环境工作过的 | 随 smoke | S–M |
| NEXT-Q-10 | **保持零遥测**，README + ADR 写成承诺 | 0.2.0 | S |
| NEXT-Q-11 | 信任列表只读 UI；路径 token 熵测试；安全模型一页（TOFU 首连 MITM 风险写进 usage） | 0.2.x | S–M |
| NEXT-Q-12 | README 删精确测试数（现写 559，实际 709），改为 CI badge | 0.1.4 | S |
| NEXT-Q-13 | 嵌入错误页文案由 `extension.ts` 注入 `t()`，代理继续不 import vscode | 0.2.x | S |
| NEXT-Q-14 | `engines.vscode` / `@types/node` / CI Node 对齐（现 types=20、宿主可能 18） | 0.2.0 | S |

---

## 6. 用户与 Agent（NEXT-U）

优化后旅程：**第一天死胡同已清除**。剩余是引导、告警树不对称、Agent「查完交还人」半径、文档尾巴。

| ID | 用户 | 主题 | 切片 | 量 | ADR |
|---|---|---|---|---|---|
| NEXT-U-01 | IDE | 告警树搜索 + 状态过滤 | 0.2.0 must | M | 否 |
| NEXT-U-02 | 两者 | walkthrough 五步 | 0.2.0 must | M | 否 |
| NEXT-U-03 | IDE | **本地**收藏 / 最近打开 | 0.2.x | M | 否 |
| NEXT-U-04 | IDE | 右键「打开并选时间范围」（`from`/`to` 管道已通） | 0.2.x | S–M | 否 |
| NEXT-U-05 | Agent | SKILL incident playbook | 可 0.1.5 | S | 否 |
| NEXT-U-06 | Agent | `grafana_query_datasource` 描述 + skill 表：Tempo/ES 起点 path | 可 0.1.5 | S | 否 |
| NEXT-U-07 | IDE | folders 失败时 dashboard 平铺降级，而不是整棵树挂掉 | 0.2.x | M | 否 |
| NEXT-U-08 | 两者 | 默认实例 + `list_instances.isDefault` | 0.2.x | S–M | 否 |
| NEXT-U-09 | IDE | 最多 2 条低冲突快捷键 | 0.2.x | S | 否 |
| NEXT-U-10 | IDE | 嵌入 loader 三句 l10n；`prefers-reduced-motion` | 0.2.0 / .x | S | 否 |
| NEXT-U-11 | IDE | usage 中英：右键开闸门、测试连接、新命令 | 0.2.0 | S | 否 |
| NEXT-U-12① | 两者 | `openInIde` + `alertRule` | 0.2.0 must | S | 否 |
| NEXT-U-12② | 两者 | `openInIde` + Explore | 0.2.x | M | 修订 ADR-007 |
| NEXT-U-13 | 两者 | 嵌入 401 自绘页；401 vs 403 文案 | 0.2.0 must | S–M | 否 |
| NEXT-U-14 | IDE | 告警刷新间隔改设置已立即生效 | **关闭** | — | 已在 `extension.ts` 监听 |

---

## 7. 明确不要做的（除非新 ADR）

1. Dashboard / 规则 / 数据源 CRUD、ack、pause（silence 仅在 ADR-008 通过后）
2. 官方 50 工具目录复刻；Prom/Loki 之外的类型化查询工具
3. Tempo / OnCall / Sift / Incident 专属工具（Cloud 用户用官方 mcp-grafana）
4. Legacy Alerting、匿名 / Public Dashboard 鉴权
5. 自绘图表引擎；`d-solo` 嵌入（用已有 `viewPanel`）
6. 单实例多 Org 头注入（先每 org 一实例）
7. base/mcp 双变体（直到写工具真正出现再重审 ADR-002）
8. Grafana Live WS（直到 HTTP 嵌入被活体证明）
9. 大型 Electron E2E 套件、全版本 Grafana CI 矩阵、遥测管道
10. 为 Antigravity / Qoder / Trae 做未经验证的「支持」宣称

---

## 8. 建议的下一迭代（可执行清单）

**本周（零/少代码）：**

1. 按 [live-smoke-checklist.md](2026-08-27-live-smoke-checklist.md) 对 compose 栈跑 DoD 1/2/3/9，把结果写回 `docs/releases/0.1.0.md`。
2. 同一环境校准 12h/5MiB，确认 `grafana_get_alert_history` 真实 JSON 形状并收夹具。
3. README 去掉过期的「559 tests」；requirements 把 Antigravity/Qoder/Trae 改为未验证。
4. SKILL 补 incident playbook + Tempo/ES escape-hatch 示例（NEXT-U-05/06）。

**下一小版本（0.2.0 能力，仍只读）：**

5. 告警树过滤、walkthrough、`openInIde` 告警、嵌入 401 页、MCP 首启同意。
6. CI 打包 VSIX；注册 publisher；CHANGELOG。

**不要并行铺开 V2 写操作或 Live 代理。** 在活体验证和可安装通道完成前，新能力只会放大未证明的核心路径。

---

## 9. 源码锚点（实施时）

| 主题 | 入口 |
|---|---|
| 活体清单 | `docs/plans/2026-08-27-live-smoke-checklist.md`、`docker-compose.smoke.yml` |
| 激活 / MCP 写入 | `src/extension.ts` |
| 告警树 | `src/tree/AlertTreeProvider.ts`、`package.json` menus |
| deeplink / openInIde | `src/grafana/grafanaDeeplink.ts`、`src/agent/GrafanaAgentToolService.ts` |
| 嵌入 401 / 重写 | `src/webview/GrafanaEmbedProxy.ts`、`src/webview/html.ts` |
| 工具描述 / SKILL | `src/mcp/toolCatalog.ts`、`skills/at-grafana-mcp/` |
| 发布身份 | `package.json` `publisher`、`.github/workflows/ci.yml` |
| Alert history | `src/grafana/GrafanaAlertsApi.ts`（仍标 UNVERIFIED） |
