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

共 9 个工具，全部 `risk: read`，安装 AT Series MCP 配置后自动进入 autoApprove —— 无需逐个工具手动批准。分两组：

- **管理类工具** —— `grafana_list_dashboards`、`grafana_get_dashboard`、`grafana_list_folders`、`grafana_list_alert_rules`、`grafana_get_alert_rule`、`grafana_get_alert_history`。服务于想知道「**配置了什么**」的 Agent：有哪些 dashboard/文件夹、某个面板实际查询的是什么（排障推荐 `grafana_get_dashboard` 的 `fields: "targets"`）、某条告警规则如何定义以及历史上是如何触发的。
- **监控数据类工具** —— `grafana_list_datasources`、`grafana_query_datasource`。服务于想知道「**实际发生了什么**」的 Agent：通过 Grafana 自身的代理 API，查询某个数据源背后真实的 Prometheus/Loki 等数据。
- `grafana_list_instances`（发现类）只会返回已开启后台访问的实例，且从不包含 token。

`grafana_query_datasource` 只放行 `GET`/`POST`（绝不允许写操作），并强制执行可配置的时间范围与返回体积上限——超限的请求会在结果中标记 `truncated: true` 并被截断，而不是直接失败，方便 Agent 缩小查询范围后重试。

## Hub / IDE 集成

- **AT Grafana: Install/Repair AT Series MCP Config** 与 **AT Grafana: Uninstall AT Series MCP Config** 命令管理的是 AT 系列所有插件共用的同一条 `AT Series` MCP 入口（Cursor、Kiro、Continue）——安装 AT Grafana 不会创建第二个插件专属的 MCP server 入口。
- V1 不存在任何写/执行类工具：所有工具均设计为只读（dashboard/告警规则/数据源的创建、编辑、删除、静默、暂停/恢复均不在本次发布范围内）。

## 当前版本的非目标

- 单 panel 下钻（仅支持嵌入完整 dashboard）
- Legacy Alerting（仅支持 Unified Alerting）
- 任何针对 Grafana 或数据源的写操作
- 多 Org（组织）支持
- 经嵌入代理的 Grafana Live / WebSocket 推送（页面可加载，需手动刷新）
