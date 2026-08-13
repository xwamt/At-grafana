# AT Grafana

[English](../README.md)

AT Grafana 是 **AT 系列** VS Code / Cursor 扩展的一员（同系列还有 `at-terminal-series`、`at-jumpserver-series`）。它把 Grafana 的 dashboard 与 Unified Alerting 原生集成到 IDE，并通过共享的 [`@at-series/mcp-hub`](https://www.npmjs.com/package/@at-series/mcp-hub) Protocol v1，把只读的 Grafana 配置元数据以及数据源查询（Prometheus、Loki 等）提供给 Agent。

**当前版本：`0.1.0`** —— V1 功能已齐。自动化验证：typecheck + **292** 项测试。针对真实 Grafana / 真实 MCP 客户端的冒烟项仍见 [`releases/0.1.0.md`](releases/0.1.0.md)。

## 功能

- **多实例配置** — label、URL、Grafana Service Account Token（9.1+）；Token 存在 VS Code `SecretStorage`，不写明文配置
- **TLS Trust-On-First-Use** — 首次连接确认证书指纹；指纹变更后拒绝连接
- **Dashboards 侧边栏** — 文件夹树、标题过滤、刷新；点击在 Webview 中打开
- **Alerts 侧边栏** — Unified Alerting 规则与实时状态，按文件夹分组，Firing 置顶
- **原生嵌入页面** — 通过仅绑定 `127.0.0.1` 的本地反向代理注入 `Authorization`，在 Webview 中打开可交互的原生 Grafana dashboard / 告警详情（Token 不会出现在 Webview 网络层）
- **按实例的 Agent 开关** — 「允许 Agent 后台访问」（默认关）；仅开启的实例对 MCP 工具可见
- **9 个 MCP 工具**（全部 `risk: read`，安装 AT Series MCP 配置后自动批准）：
  - 发现：`grafana_list_instances`
  - 管理：`grafana_list_dashboards`、`grafana_get_dashboard`、`grafana_list_folders`、`grafana_list_alert_rules`、`grafana_get_alert_rule`、`grafana_get_alert_history`
  - 监控：`grafana_list_datasources`、`grafana_query_datasource`（仅 `GET`/`POST`；`path` 被限制在 `/api/datasources/proxy/uid/<uid>/` 之内，无法触达 Grafana 自身 API；可配置时间范围 / 响应体积上限）
- **共享 AT Series Hub** — Cursor / Kiro / Continue 共用一条 `AT Series` MCP 入口，不单独再建插件专属 MCP server

## 当前版本不包含

- 单 panel 下钻（仅完整 dashboard）
- Legacy Alerting（仅 Unified Alerting）
- 对 Grafana 或数据源的任何写 / 静默 / 暂停操作
- 多 Org 支持
- 经嵌入代理的 Grafana Live / WebSocket 推送

## 安装

1. 本地打包（或使用发布后的 Release 资源）：

   ```bash
   npm install
   npm run package   # 生成 at-grafana-0.1.0.vsix
   ```

2. 在 VS Code / Cursor：**扩展 → ⋯ → 从 VSIX 安装…**，选择生成的文件。

3. 打开 **AT Grafana** 活动栏视图，执行 **AT Grafana: Add Instance**。

## 快速开始

1. 在 Grafana 创建 **Viewer** 角色的 **Service Account** 并复制 Token。
2. **AT Grafana: Add Instance** → 填写 label、base URL、Token → **Test connection** → 确认 TLS 指纹 → 保存。
3. 在 **Dashboards** / **Alerts** 中浏览；点击节点即可在 Webview 打开原生页面。
4. （可选，给 Agent 用）编辑实例并开启 **Allow background Agent access**。
5. （可选）执行 **AT Grafana: Install/Repair AT Series MCP Config**，然后重连 MCP 客户端。

完整步骤见 [`usage.zh-CN.md`](usage.zh-CN.md) · [English](usage.md)

## Agent Skill

| Skill | 用途 |
| --- | --- |
| [`at-grafana-mcp`](../skills/at-grafana-mcp/SKILL.md) | 通过 AT Grafana MCP 查看 dashboard / 告警规则，并查询 Prometheus/Loki 类监控数据 |

可用 skills CLI 安装：

```bash
npx skills add xwamt/At-grafana --skill at-grafana-mcp
```

## 开发

```bash
npm install
npm run typecheck
npm test
npm run build
npm run package
```

在本目录打开 VS Code / Cursor 后按 `F5` 启动 Extension Development Host。

需要 Node.js 20+，以及满足 `engines.vscode`（`^1.85.0`）的宿主。

## 文档

| 文档 | 说明 |
| --- | --- |
| [`features.zh-CN.md`](features.zh-CN.md)（[English](features.md)） | 功能概览 |
| [`usage.zh-CN.md`](usage.zh-CN.md)（[English](usage.md)） | 配置实例、开启 Agent、连接 MCP |
| [`releases/0.1.0.md`](releases/0.1.0.md) | 发布说明与验收记录 |
| [`requirements.md`](requirements.md) | 完整需求规格（中文） |
| [`skills/at-grafana-mcp/SKILL.md`](../skills/at-grafana-mcp/SKILL.md) | 面向 Agent 的 MCP 工具指南（英文） |
| [`decisions/`](decisions) | ADR-001 … ADR-005 |
| [`plans/2026-07-29-at-grafana-v1-implementation-plan.md`](plans/2026-07-29-at-grafana-v1-implementation-plan.md) | 分阶段实施记录 |

以 `at-terminal-series` 为脚手架新建（独立 git 历史，已删除 SSH/SFTP/终端相关代码），见 [ADR-001](decisions/ADR-001-scaffold-from-at-terminal-series.md)。

## 许可证

[MIT](../LICENSE)
