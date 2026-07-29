# AT Grafana

[English](../README.md)

AT-Grafana 是 **AT 系列** VS Code 生态扩展的最新成员（同系列已有 `at-terminal-series`、`at-jumpserver-series`）。它把 Grafana 的 dashboard 与告警规则原生集成到 IDE 内，并通过 AT 系列共享的 [`@at-series/mcp-hub`](https://www.npmjs.com/package/@at-series/mcp-hub) Protocol v1，把 Grafana 的配置元数据以及一个通用的数据源查询代理（Prometheus、Loki 等）提供给 Agent。

**当前状态：** Phase 0–7 已完成 —— 实例配置与鉴权、dashboard/告警树形 UI、通过本地反向代理嵌入的原生 dashboard/告警 Webview，以及完整的 9 工具 `at.grafana` MCP 目录（管理类 + 监控数据类，全部 `risk: read`，已接入 AT Series 共享 Hub）均已实现并通过单元/集成测试。发布 `0.1.0` 前只剩 Phase 8（最终打包 + 针对真实 Grafana 实例的端到端验证）—— 具体哪些检查点仍需人工在真实 Grafana 实例上手动验证，见实施计划文档。文档地图：

- [`docs/requirements.md`](requirements.md) —— 完整需求规格（grill-me 决策记录，中文）
- [`docs/features.zh-CN.md`](features.zh-CN.md)（[English](features.md)）—— 面向最终用户/管理员的功能概览
- [`docs/usage.zh-CN.md`](usage.zh-CN.md)（[English](usage.md)）—— 如何添加实例、开启 Agent 访问、连接 MCP 客户端
- [`skills/at-grafana-mcp/SKILL.md`](../skills/at-grafana-mcp/SKILL.md) —— 面向 Agent 的 MCP 工具目录使用指南（英文）
- [`docs/decisions/`](decisions) —— ADR-001 至 ADR-005（英文）
- [`docs/plans/2026-07-29-at-grafana-v1-implementation-plan.md`](plans/2026-07-29-at-grafana-v1-implementation-plan.md) —— 分阶段实施计划与进度勾选（英文）

以 `at-terminal-series` 为脚手架新建（独立 git 历史，已删除全部 SSH/SFTP/终端相关代码），详见 [ADR-001](decisions/ADR-001-scaffold-from-at-terminal-series.md)。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run build      # 打包 dist/extension.js
npm run package    # 生成 at-grafana-<version>.vsix
```

在 VS Code 中打开本目录后按 `F5` 即可启动 Extension Development Host。
