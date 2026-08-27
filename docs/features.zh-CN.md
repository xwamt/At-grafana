# AT Grafana — 功能概览

**面向对象：** 配置/使用本扩展的最终用户与管理员（面向 Agent 的工具契约见 [`skills/at-grafana-mcp/SKILL.md`](../skills/at-grafana-mcp/SKILL.md)；完整需求规格见 [`requirements.md`](requirements.md)）。

## 概述

AT Grafana 把 Grafana 的 dashboard 与告警规则原生集成到 IDE 内，并通过 AT 系列共享的 [`@at-series/mcp-hub`](https://www.npmjs.com/package/@at-series/mcp-hub) Protocol v1，把 Grafana 的配置信息以及其背后的监控数据（Prometheus、Loki 等）提供给 Agent —— 无需单独配置一个 MCP server，除了添加 Grafana 实例外不需要任何额外插件级配置。

## 实例配置

- 支持添加/编辑多个 Grafana 实例（label、URL、Service Account Token）。Token 存储在 VS Code 加密的 `SecretStorage` 中，不会写入明文配置文件。
- 首次连接一个新的 host 会弹出 TLS 证书指纹确认（Trust-On-First-Use，与 SSH host key 同一模型）；之后若指纹发生变化，连接会被阻止而不是静默放行。
- 每个实例都有独立的**「允许 Agent 后台访问」**开关（默认关闭）。只有开启该开关的实例才会对 Agent 通过 MCP 可见/可调用 —— 具体开启方式见[使用指南](usage.zh-CN.md)。
- 实例编辑表单上的「测试连接」会区分网络错误、证书不受信任、鉴权失败三类结果。

## 侧边栏树形界面

- **Dashboards** 视图：按 Grafana 文件夹结构展示，支持名称过滤。点击某个 dashboard 会在 Webview 中打开。
- **Alerts** 视图：展示全部 Unified Alerting 规则及当前状态，按文件夹分组，**Firing（触发中）**规则置顶排序。点击某条规则会在 Webview 中打开其详情。
- 两个视图都提供刷新命令；Dashboards 视图额外支持标题过滤。

## 嵌入式 Dashboard 与告警详情页

点击某个 dashboard 或告警规则，会在 VS Code Webview 中打开**真实、完全可交互的原生 Grafana 页面**——面板缩放、tooltip、原生时间范围选择器均与浏览器直接打开时完全一致。其实现方式是扩展宿主起一个仅绑定 `127.0.0.1` 的本地反向代理，由扩展端注入 Service Account Token；该 token 不会被发送到 Webview，也不会出现在 Webview 自身发出的任何网络请求中。

## MCP 工具目录（面向 Agent）

共 17 个工具，全部 `risk: read`，安装 AT Series MCP 配置后自动进入 autoApprove —— 无需逐个工具手动批准。分三组：

- **发现类** —— `grafana_list_instances` 只会返回已开启后台访问的实例，且从不包含 token。
- **管理类工具** —— `grafana_list_dashboards`（可选 `query` / `tag` / `folderUid`）、`grafana_get_dashboard`、`grafana_list_folders`、`grafana_list_alert_rules`（可选 `states`：`firing` / `pending` / `normal` / `unknown`）、`grafana_get_alert_rule`、`grafana_get_alert_history`、`grafana_list_annotations`、`grafana_generate_deeplink`（`openInIde` 缺省 false；Explore 只返回 URL）。服务于想知道「**配置了什么**」的 Agent：有哪些 dashboard/文件夹、某个面板实际查询的是什么（`grafana_get_dashboard` 缺省 `fields: "targets"`；完整 model 需传 `fields: "full"`）、某条告警规则如何定义以及历史上是如何触发的、发布窗口 annotation、以及可打开的 Grafana URL。
- **监控数据类工具** —— `grafana_list_datasources`、`grafana_query_prometheus`、`grafana_query_loki`、`grafana_list_prometheus_metric_names`、`grafana_list_prometheus_label_values`、`grafana_list_loki_label_names`、`grafana_list_loki_label_values`，以及作为兜底的 `grafana_query_datasource`。优先用类型化 Prometheus/Loki 工具；写查询前用四个 list 工具发现 metric/label。服务于想知道「**实际发生了什么**」的 Agent：查询某个数据源背后真实的 PromQL/LogQL 数据。

`grafana_query_datasource` 是其它数据源类型或不寻常路径的通用代理。它只放行 `GET`/`POST`（绝不允许写操作），并把 `path` 限制在 `/api/datasources/proxy/uid/<datasourceUid>/` 之内——`..`、`\` 与百分号编码的分隔符一律拒绝，拼接后还会在 URL 规范化之后重新校验一次前缀，因此即便 Agent 被注入的输入牵引，也无法借这个工具触达 Grafana 自身的 API。此外还强制执行可配置的时间范围与返回体积上限——超限的请求会在结果中标记 `truncated: true` 并被截断，而不是直接失败，方便 Agent 缩小查询范围后重试。

## 查询计量

数据源流量按**实例**计量，且这些上限作用于所有触达数据源的工具——类型化的 `grafana_query_prometheus` / `grafana_query_loki` 以及四个 metric/label 发现类工具与 `grafana_query_datasource` 走同一套计量，并非只限通用代理。默认值：

- **时间范围上限** —— 12 小时（`atGrafana.queryLimits.maxRangeMs`）。超限范围会被收窄（start 前移、保留请求的 end），结果携带 `truncated: true` 与原因说明。
- **返回体积上限** —— 5 MiB（`atGrafana.queryLimits.maxResponseBytes`）。超限响应会被整体丢弃而不是部分返回，同样标记 `truncated: true`。
- **速率限制** —— 每实例每分钟 60 次查询（连续回填的令牌桶，允许从空闲状态一次性打满一整桶）。
- **并发限制** —— 每实例同时最多 4 个查询在途。

速率/并发拒绝是临时的资源限制而非权限拒绝：错误信息会明确说明这一点，并给出重试等待时间，等待后相同调用即可成功。

## Hub / IDE 集成

- **AT Grafana: Install/Repair AT Series MCP Config** 与 **AT Grafana: Uninstall AT Series MCP Config** 命令管理的是 AT 系列所有插件共用的同一条 `AT Series` MCP 入口（Cursor、Kiro、Continue）——安装 AT Grafana 不会创建第二个插件专属的 MCP server 入口。
- V1 不存在任何写/执行类工具：所有工具均设计为只读（dashboard/告警规则/数据源的创建、编辑、删除、静默、暂停/恢复均不在本次发布范围内）。

## 当前版本的非目标

- 单 panel 下钻（仅支持嵌入完整 dashboard）
- Legacy Alerting（仅支持 Unified Alerting）
- 任何针对 Grafana 或数据源的写操作
- 多 Org（组织）支持
- 经嵌入代理的 Grafana Live / WebSocket 推送（页面可加载，需手动刷新）
