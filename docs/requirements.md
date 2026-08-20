# AT-Grafana 需求说明（grill 收敛版）

**Status:** Accepted（产品 + 架构需求，V1 范围）
**Date:** 2026-07-29
**Source:** grill-me 两轮拷打会话（用户 + Agent）
**Normative upstream protocol:** [`@at-series/mcp-hub` Protocol v1](../../at-series-mcp-hub/docs/protocol/v1.md)
**ADR:** [decisions/](./decisions/)
**实施计划:** [plans/2026-07-29-at-grafana-v1-implementation-plan.md](./plans/2026-07-29-at-grafana-v1-implementation-plan.md)

本文档记录 AT-Grafana 插件 V1 **已拍板的需求与边界**，供实现与验收时反复核对。
Hub 侧接口字段级细节以 `@at-series/mcp-hub` 的 `protocol/v1.md` 为准；本文偏「要什么 / 不要什么 / 为什么」。

---

## 1. 背景与定位

AT-Grafana 是 **AT 系列**的新成员（同系列已有 `at-terminal-series` / `at-jumpserver-series`），面向 VSCode 生态（VS Code、Cursor、Kiro、Antigravity、Qoder、Trae 等）。

与既有 AT 插件不同：既有插件的核心价值是「让 Agent 操作/巡检远程服务器」，UI（终端/SFTP）本身也有独立价值，因此拆成 base/mcp 双构建变体。AT-Grafana 的核心价值被明确定义为**把 Grafana 里配置的监控数据（Prometheus/Loki 等数据源）和 Grafana 自身的配置信息（面板、告警规则）都提供给 Agent 分析**；IDE 内的可视化（面板/告警视图）是 Agent 能力之外的**附加体验**，而不是反过来。这个定位直接决定了下面多条决策（D1、D10、D13）。

---

## 2. 用户与场景

### 2.1 主用户

- 在 Cursor / Kiro / VS Code 等 IDE 中使用 Agent 的 SRE / 后端工程师
- 已经在公司/团队内部署了 Grafana（通常自建，可能带自签名证书），配置了 Prometheus、Loki 等数据源
- 可能同时维护多个 Grafana 实例（prod / staging，或多团队）

### 2.2 关键场景

| ID | 场景 | 期望 |
|----|------|------|
| S1 | 首次配置一个 Grafana 实例 | 填写 URL + Service Account Token，首连提示证书指纹确认，保存后侧边栏出现该实例的 dashboard/alert 树 |
| S2 | 浏览面板 | 点击树上的 dashboard，IDE 内 Webview 直接展示该 dashboard 的完整原生页面（可交互，缩放/tooltip/时间范围选择器都在） |
| S3 | 查看告警 | 侧边栏展示所有告警规则及状态（Firing 置顶），点击后 Webview 展示该规则的原生详情页 |
| S4 | Agent 后台分析监控数据 | 用户未打开任何面板，Agent 通过 MCP 直接查询某实例下 Prometheus 的 `query_range` / Loki 的 `query_range`，用于排障或生成报告 |
| S5 | Agent 理解一个 dashboard 在监控什么 | Agent 通过 MCP 拉取某 dashboard 的完整 JSON model，读出每个 panel 用的 PromQL/LogQL 和数据源引用 |
| S6 | Agent 巡检告警配置 | Agent 通过 MCP 列出所有告警规则的完整定义（condition/for/labels/annotations）和历史状态变化，判断规则是否合理 |
| S7 | 用户不希望某实例被 Agent 后台访问 | 该实例默认不开放；用户需要在实例编辑页显式勾选「允许 Agent 后台访问」后，Agent 才能对该实例调用任何 MCP 工具 |
| S8 | 多实例场景 | Agent 先调用发现工具拿到所有已授权实例列表，再按 `instanceId` 对特定实例发起查询/读取 |
| S9 | 自签名证书的自建 Grafana | 首次连接提示证书指纹，用户确认后记住信任；证书变化时阻止连接并提示 |
| S10 | 大范围日志/指标查询 | Agent 请求了过大的时间范围或返回数据量，插件按内置上限截断并在结果中提示 agent 缩小范围 |

---

## 3. 已拍板决策一览（D1–D13）

实现时以本表为「需求真源」；若与代码冲突，先改代码或显式修订本文档。

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 打包形态 | **单一构建变体**，不做 base/mcp 双变体；始终包含 Bridge + Hub 注册能力（详见 [ADR-002](decisions/ADR-002-single-build-variant.md)） |
| D2 | 实例与鉴权 | 支持**多个 Grafana 实例**；每实例 URL + **Service Account Token**（Grafana 9.1+ 推荐方式），Token 存 SecretStorage |
| D3 | 证书信任 | **Trust-On-First-Use**：类比 SSH host key，首连确认指纹并记住信任，指纹变化时阻止连接 |
| D4 | 后台访问权限模型 | 每实例一个**「允许 Agent 后台访问」开关**（默认关）。开启后，该实例下**所有 `risk=read` 工具**均可被 Agent 随时后台调用，**不要求**用户先在 IDE 打开对应的 dashboard/alert 视图（详见 [ADR-004](decisions/ADR-004-mcp-tool-catalog-and-permission-model.md)） |
| D5 | Dashboard 展示粒度 | 只做 **dashboard 级别**：侧边栏按 Grafana 文件夹结构展示 dashboard 树（可搜索过滤），点击后 Webview 嵌入**完整**原生 dashboard 页面；V1 **不做**单 panel 下钻 |
| D6 | Alert 展示范围 | 基于 **Unified Alerting**（不做 legacy alerting 兼容），展示**全部规则**及状态（Normal/Pending/Firing），按文件夹/命名空间分组，**默认 Firing 置顶**；点击后 Webview 嵌入原生告警详情页；V1 **不做**任何写操作（silence/pause/ack） |
| D7 | iframe 鉴权注入 | 扩展宿主起**本地反向代理**（`127.0.0.1`，复用/扩展现有 Bridge 基础设施），Webview iframe 请求本地代理地址，由代理注入 `Authorization: Bearer <token>` 转发给真实 Grafana；token **不进入** Webview/网络前端（详见 [ADR-003](decisions/ADR-003-panel-alert-embedding-via-local-proxy.md)） |
| D8 | 数据源聚合 API 范围 | **传输层仍是通用透传代理**（`/api/datasources/proxy/uid/<uid>/...`，GET/POST + path 禁锢）。Agent 面对 Prometheus/Loki 时走类型化工具 `grafana_query_prometheus` / `grafana_query_loki`；其它数据源或不寻常路径仍用 `grafana_query_datasource` 自拼 path。详见 [ADR-006](decisions/ADR-006-typed-query-tools-and-context-defaults.md) |
| D9 | 数据源查询安全边界 | 通用代理工具只放行 **`GET`/`POST`**，阻止 `PUT`/`DELETE`/`PATCH`；工具整体标记 `risk=read`；内置**默认时间范围/返回体积硬上限**，Agent 可传参覆盖但不能超过插件设定的绝对上限，超限自动截断并提示缩小范围 |
| D10 | MCP 工具族划分 | 明确拆成两组，都在 V1 提供，都是 `risk=read`：**Grafana 管理类**（`grafana_list_dashboards`、`grafana_get_dashboard`、`grafana_list_folders`、`grafana_list_alert_rules`、`grafana_get_alert_rule`、`grafana_get_alert_history`）服务于「理解/巡检 Grafana 配置」场景；**监控数据类**（`grafana_list_datasources`、`grafana_query_prometheus`、`grafana_query_loki`、`grafana_query_datasource`）服务于「查询实际监控数据」场景 |
| D11 | 写操作范围 | **V1 全部只读**。Dashboard/告警规则/数据源的创建、修改、删除、静默、暂停/恢复等写操作**全部推迟到 V2**，不在本期范围内 |
| D12 | Hub 协议接入方式 | 全新插件，**无历史包袱**，直接以 `@at-series/mcp-hub` **Protocol v1** 接入：`pluginId = at.grafana`，工具前缀 `grafana_`（详见 [ADR-005](decisions/ADR-005-at-series-hub-protocol-v1-adoption.md)） |
| D13 | 仓库脚手架 | 以 `at-terminal-series` 为脚手架新建**独立仓库** `at-grafana-series`（独立 git 历史），复用 ConfigManager/SecretStorage 存储模式、TreeProvider 模式、BridgeServer、esbuild 打包脚本、Hub 集成代码、测试基建；**删除**全部 SSH/SFTP/终端/资产导入导出相关代码（详见 [ADR-001](decisions/ADR-001-scaffold-from-at-terminal-series.md)） |

---

## 4. 功能需求

### 4.1 实例配置与鉴权（Config/Auth）

| ID | 需求 | 优先级 |
|----|------|--------|
| CFG1 | 支持添加/编辑/删除多个 Grafana 实例配置（label、URL、Service Account Token） | P0 |
| CFG2 | Token 通过 VS Code SecretStorage 存储，不写入明文配置文件 | P0 |
| CFG3 | 每实例提供「允许 Agent 后台访问」开关，默认关闭 | P0 |
| CFG4 | 首次连接展示 TLS 证书指纹，用户确认后记住信任；指纹变化时阻止连接并提示 | P0 |
| CFG5 | 实例列表/编辑表单可测试连通性（health check：调用 Grafana `/api/health` 或等价接口） | P1 |

### 4.2 Dashboard / Alert 树形 UI

| ID | 需求 | 优先级 |
|----|------|--------|
| UI1 | 侧边栏按 Grafana 文件夹结构展示 dashboard 树，支持展开/折叠、名称过滤 | P0 |
| UI2 | 侧边栏展示所有告警规则及状态，Firing 置顶，按文件夹/命名空间分组 | P0 |
| UI3 | 点击 dashboard 节点 → Webview 嵌入完整原生 dashboard 页面 | P0 |
| UI4 | 点击告警规则节点 → Webview 嵌入原生告警详情页 | P0 |
| UI5 | 树视图提供刷新命令 | P1 |

### 4.3 本地反向代理（iframe 鉴权注入）

| ID | 需求 | 优先级 |
|----|------|--------|
| PROXY1 | 扩展宿主起本地 HTTP 代理，仅绑定 `127.0.0.1` | P0 |
| PROXY2 | 代理按 instanceId 注入对应实例的 `Authorization: Bearer <token>` | P0 |
| PROXY3 | 代理转发 Grafana 页面所需的子资源请求（JS/CSS/API/WebSocket，若涉及 Grafana Live） | P0 |
| PROXY4 | Webview CSP 仅允许连接本地代理源，不直接暴露真实 Grafana 源和 token | P0 |
| PROXY5 | 代理遵循 D3 的证书信任状态（未信任的实例不代理） | P0 |

### 4.4 MCP Bridge — Grafana 管理类工具

| ID | 需求 | 优先级 |
|----|------|--------|
| MGT1 | `grafana_list_instances` — 列出已开启后台访问的实例（不含凭据） | P0 |
| MGT2 | `grafana_list_dashboards` — 列出 dashboard（uid/title/tags/folder）；可选 `query` / `tag` / `folderUid` 下推到 Grafana `/api/search` | P0 |
| MGT3 | `grafana_get_dashboard` — 按 uid 获取 dashboard；可选 `fields=full\|summary\|targets`（缺省 `targets`）及 `panelIds`/`titleContains` 服务端过滤；完整 model 需传 `fields=full` | P0 |
| MGT4 | `grafana_list_folders` — 列出文件夹结构 | P0 |
| MGT5 | `grafana_list_alert_rules` — 列出所有告警规则及当前状态 | P0 |
| MGT6 | `grafana_get_alert_rule` — 获取单条规则完整定义（condition/for/labels/annotations/通知策略） | P0 |
| MGT7 | `grafana_get_alert_history` — 获取某规则的历史状态变化/事件记录 | P0 |

### 4.5 MCP Bridge — 监控数据类工具

| ID | 需求 | 优先级 |
|----|------|--------|
| MON1 | `grafana_list_datasources` — 列出数据源（uid/name/type/url，不含凭据） | P0 |
| MON2 | `grafana_query_datasource` — 通用透传代理：`instanceId` + `datasourceUid` + `method`(GET/POST) + `path` + `query`/`body`，转发到 `/api/datasources/proxy/uid/<uid>/<path>` | P0 |
| MON2a | `grafana_query_prometheus` — `instanceId` + `datasourceUid` + `expr` + `queryType` (`instant`\|`range`，缺省 `range`) + 可选 `start`/`end`/`step`/`time`；内部只构造 `api/v1/query` 或 `api/v1/query_range` 再走与 MON2 同一套计量 | P0 |
| MON2b | `grafana_query_loki` — `instanceId` + `datasourceUid` + `expr` + `queryType`（缺省 `range`）+ 可选 `start`/`end`/`time`/`limit`/`direction`；内部只构造 `loki/api/v1/query` 或 `loki/api/v1/query_range` | P0 |
| MON3 | MON2 内置默认时间范围/返回体积硬上限，超限自动截断并在结果中提示 | P0 |
| MON4 | MON2 仅放行 `GET`/`POST`，其余 method 直接拒绝（`VALIDATION_ERROR`） | P0 |

### 4.6 Hub 集成

| ID | 需求 | 优先级 |
|----|------|--------|
| HUB1 | Bridge 实现 `GET /health`、`GET /tools`、`POST /invoke`，鉴权头 `x-at-series-token` | P0 |
| HUB2 | 注册记录发布到 `~/.at-series/bridges/<hostApp>/<bridgeId>.json` | P0 |
| HUB3 | 心跳 ≤30s，deactivate 时 unpublish（只删自身记录） | P0 |
| HUB4 | activate 时参与 Hub bundle 版本竞选同步（`syncHubBundle`） | P0 |
| HUB5 | 提供 `AT Series: Install/Repair MCP Config`、`Uninstall MCP Config` 命令，复用 `ensureAtSeriesMcpConfig` / `uninstallAtSeriesMcpConfig` | P0 |
| HUB6 | 全部工具声明 `risk=read`，install 时全部进入 autoApprove | P0 |
| HUB7 | 工具结果禁止返回 token / SecretStorage 原文 | P0 |

---

## 5. 非功能需求

### 5.1 安全

- 本地代理与 Bridge 均只绑定 `127.0.0.1`
- Token 高熵存储于 SecretStorage，不落盘明文，不进日志，诊断输出打码
- 工具结果、健康检查响应、错误信息中不得出现 token/Service Account 密钥
- `grafana_query_datasource` 的 method 白名单校验必须在 Bridge 层强制执行，不能只依赖 agent 自律
- TLS 证书信任状态与 SSH host key 存储遵循同等强度（拒绝静默降级为不校验）

### 5.2 性能与限流

- `grafana_query_datasource` 默认时间范围与最大返回字节数需可在插件设置中查看当前生效值；超限时截断而非报错，附带截断说明文字，方便 agent 自行缩小范围重试
- 树视图刷新、健康检查等操作不应阻塞 UI 线程

### 5.3 兼容性

- 面向 Grafana **9.1+**（Service Account Token 与成熟的 Unified Alerting 均要求较新版本）；不兼容更早版本的 legacy alerting 是已知的 non-goal（见第 6 节）
- IDE 兼容性沿用 AT 系列既有约定：VS Code / Cursor / Kiro / Antigravity / Qoder / Trae 等基于 VS Code 扩展生态的产品

### 5.4 可运维/可诊断

- 实例编辑页可测试连通性，明确区分「网络不通」「证书不信任」「鉴权失败（401/403）」三类错误
- MCP 工具调用失败时返回标准错误体（`code`/`message`/`details`），复用 Hub Protocol v1 的错误码约定

---

## 6. 明确不做（V1 Non-goals）

1. Dashboard / 告警规则 / 数据源的创建、修改、删除
2. 告警静默（silence）、确认（ack）、暂停/恢复规则
3. 单 panel 级别的下钻查看（`d-solo` 嵌入）
4. Legacy Alerting（老版本告警引擎）兼容
5. Grafana 匿名访问 / Public Dashboards 作为鉴权手段
6. 多 Org（组织）支持
7. base/mcp 双构建变体拆分
8. 除 Prometheus/Loki 常见查询路径之外的数据源类型专属封装（仍可用 `grafana_query_datasource` 通用透传访问，只是不做专属高阶工具）
9. 自定义图表渲染引擎（如用 ECharts 重新渲染面板）

---

## 7. 验收标准（Definition of Done 方向）

1. 用户可添加一个 Grafana 实例（URL + Service Account Token），首连出现证书指纹确认弹窗，确认后侧边栏出现 dashboard/alert 树
2. 点击任意 dashboard 节点，Webview 内可见与浏览器直接打开该 dashboard 一致的完整交互式页面，且开发者工具网络面板中看不到真实 Grafana token
3. 点击任意告警规则节点，Webview 内可见原生告警详情页
4. 未开启「允许 Agent 后台访问」的实例，`grafana_list_instances` 不返回该实例，其余工具对该 `instanceId` 调用返回明确的授权错误
5. 开启后台访问后，无需打开任何面板，Agent 可直接调用全部 7 个管理类工具（含发现类 `grafana_list_instances`）+ 4 个监控数据类工具（共 11 个）
6. `grafana_get_dashboard` 缺省 `fields=targets`，可见每个 panel 的查询语句与数据源引用；`fields=full` 才返回完整 model
7. `grafana_query_datasource` 对超出上限的时间范围/返回体积做截断，响应中包含截断提示
8. `grafana_query_datasource` 对 `PUT`/`DELETE`/`PATCH` 请求返回 `VALIDATION_ERROR`
9. 通过 `AT Series: Install/Repair MCP Config` 后，IDE MCP 配置中只有一条 `AT Series` 入口，本插件工具全部出现在 `tools/list` 且默认 autoApprove
10. 卸载/禁用扩展后，本插件的 Bridge 注册记录被删除，`hub.js` 与其他插件记录不受影响

---

## 8. 决策追溯（grill 问答摘要）

### 第一轮（架构/鉴权/可视化/数据/打包）

1. 实例与鉴权 → 多实例 + Service Account Token
2. 面板渲染策略 → Webview iframe 嵌入原生页面
3. iframe 鉴权注入 → 本地反向代理注入 Authorization 头
4. TLS 信任 → Trust-On-First-Use
5. 告警范围 → 仅 Unified Alerting，只读
6. 数据源聚合范围 → 通用透传代理，不分类型
7. 查询结果限制 → 内置硬上限，可覆盖但不超绝对上限
8. 打包形态 → 单一构建，始终含 MCP
9. 视图粒度 → dashboard 级别，不下钻 panel
10. 告警点击视图 → 嵌入原生告警详情页
11. 告警列表范围 → 全部规则+状态，Firing 置顶
12. Dashboard 列表范围 → 全量文件夹树

### 第二轮（工具目录 + 权限模型，用户指出第一轮遗漏）

13. 权限模型 → 仿 AT Terminal：每实例「允许后台访问」开关，开启后无需打开面板即可后台调用
14. 管理类工具写操作范围 → V1 全部只读
15. 具体管理类工具清单 → list_dashboards、get_dashboard、list_folders、list_alert_rules、get_alert_rule、list_datasources、get_alert_history（全选）
16. 仓库脚手架 → 以 at-terminal-series 为脚手架新建独立仓库

---

## 9. 文档地图

| 文档 | 用途 |
|------|------|
| **本文件 `requirements.md`** | 需求真源：已拍板决策、范围、验收 |
| `decisions/ADR-001-*.md` | 为什么以 at-terminal-series 为脚手架 |
| `decisions/ADR-002-*.md` | 为什么不做 base/mcp 双变体 |
| `decisions/ADR-003-*.md` | 为什么用本地反向代理做 iframe 鉴权注入 |
| `decisions/ADR-004-*.md` | MCP 工具目录与权限模型细节 |
| `decisions/ADR-005-*.md` | 为什么直接采用 Hub Protocol v1（无迁移历史包袱） |
| `decisions/ADR-006-*.md` | 类型化 Prom/Loki 查询工具与 dashboard 缺省投影 / 可搜索列表 |
| `plans/2026-07-29-at-grafana-v1-implementation-plan.md` | 分阶段实施计划 |
