# Phase P1 — grafana_get_dashboard 投影（本仓执行）

在 **本仓库** `at-grafana-series` 实现 dashboard 响应投影，砍掉排障时 ~50KB+ 整板 JSON。不要 commit，除非用户另说。

## 背景

`grafana_get_dashboard` 返回完整 dashboard model（UI chrome 占大部分）。Agent 只需 panel `targets`/`expr` + datasource uid。实测整板 ~56KB，targets 投影 ~22KB，加 title 过滤可到数 KB。

## 必做

### 1. 扩展 `grafana_get_dashboard` 入参

```ts
{
  instanceId: string;
  uid: string;
  fields?: "full" | "summary" | "targets"; // 缺省保持 full（兼容）
  panelIds?: number[];
  titleContains?: string;
}
```

- `full`：现状完整 model
- `summary`：uid/title/time + panels 的 id/title/type/datasource
- `targets`：去掉 fieldConfig/options/gridPos 等；保留 expr + datasource；递归 row panels
- `panelIds` / `titleContains`：服务端过滤（大小写不敏感包含即可）

在 **AgentToolService 出站前投影**（仍可调 Grafana 全量 API）。

### 2. 同步契约（同一变更集）

- Zod + JSON Schema（`bridgeSchemas` / toolCatalog inputSchema）
- toolCatalog description：排障推荐 `fields: "targets"`
- ADR-004 / requirements 相关条文（若存在）
- 测试：投影体积、过滤、row 嵌套、缺省 full 兼容
- skill：`skills/at-grafana-mcp/SKILL.md`；若存在 `~/.agents/skills/at-grafana-mcp` 同步

**不需要**本阶段必须新增 `grafana_get_panel_query`（可选；优先 fields）。

### 3. 协议边界

本仓是插件 Bridge，不是 Hub。不要改 `@at-series/mcp-hub` 除非类型导出必需（通常不需要）。

## 验收

- `fields=full` 与旧行为一致
- `fields=targets` + `titleContains` 明显小于 full
- 测试通过
- skill 示例改为推荐 targets

## 完成后

简体中文总结改动与如何调用。不要 push/PR，除非用户要求。
