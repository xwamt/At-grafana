# AT Grafana — 使用指南

**面向对象：** 配置和使用本扩展的最终用户。功能概览见 [`features.zh-CN.md`](features.zh-CN.md)，完整需求规格见 [`requirements.md`](requirements.md)。

## 1. 添加一个 Grafana 实例

### 在 Grafana 中创建 Service Account Token

AT Grafana 使用 Grafana 的 **Service Account Token**（Grafana 9.1+）进行鉴权，而不是个人登录账号：

1. 在 Grafana 中进入 **Administration → Users and access → Service accounts**。
2. 点击 **Add service account**，起一个名字（例如 `at-grafana-agent`），角色选择 **Viewer**。
   - 本扩展 V1 用到的全部只读接口（dashboard、文件夹、告警规则/历史、数据源以及数据源代理查询）**Viewer 角色已经足够**，不需要 Editor 或 Admin。
3. 打开这个新建的 service account，点击 **Add service account token**。立即复制生成的 token —— Grafana 只会显示一次。

### 在扩展中添加实例

1. 从命令面板运行 **「AT Grafana: 添加实例」**（英文界面下为 **AT Grafana: Add Instance**）。
2. 填写 label、实例的 base URL（如 `https://grafana.example.com`），并粘贴 Service Account Token。
3. 保存前点击 **Test connection** 确认 URL/token 是否有效。它会分别报告网络错误、TLS 证书不受信任、鉴权失败（401/403）三类不同结果。
4. 首次成功连接一个新 host 时，会要求你确认展示的 TLS 证书指纹（Trust-On-First-Use）。此后若指纹发生变化，连接会被阻止直到你重新显式确认——这不是一个可以跳过的警告。
5. 保存。该实例会出现在 **AT Grafana** 侧边栏的 Dashboards/Alerts 视图中。

之后可通过 **「AT Grafana: 管理实例」**（英文界面下为 **AT Grafana: Manage Instances**）编辑或删除已有实例。

## 2. 开启 Agent 后台访问（可选）

默认情况下，新添加的实例**不会**被 Agent 通过 MCP 访问到，即使已经安装了 AT Series MCP 配置。要开启：

1. 运行 **「AT Grafana: 管理实例」**（AT Grafana: Manage Instances），选中该实例，选择 **Edit**。
2. 勾选 **Allow background Agent access** 并保存。

开启后，全部 17 个 MCP 工具都可以随时针对该实例的 `instanceId` 调用——Agent 无需先打开任何 dashboard/告警的 Webview 面板。关闭该开关会立即阻止针对该实例的后续所有工具调用，并且该实例也不会再出现在 `grafana_list_instances` 的结果中。

## 3. 浏览 Dashboard 与告警

- 展开 **Dashboards** 视图查看 Grafana 的文件夹树；使用过滤图标按标题搜索。
- 展开 **Alerts** 视图查看全部 Unified Alerting 规则，按文件夹分组，**Firing（触发中）**规则排在最前面。
- 点击任意 dashboard 或告警规则，会在 Webview 标签页中打开与浏览器直接访问一致的、完全可交互的原生 Grafana 页面。

## 4. 连接支持 MCP 的 IDE 客户端

AT Grafana 本身不运行独立的 MCP server —— 它注册到 AT 系列共享的 **AT Series** Hub，与其他 AT 系列插件（AT Terminal、AT JumpServer 等）共用同一条入口。

1. 从命令面板运行 **「AT Grafana: 安装/修复 AT Series MCP 配置」**（英文界面下为 **AT Grafana: Install/Repair AT Series MCP Config**）。
2. 该命令会在你的 IDE MCP 配置中写入（或修复）唯一一条 `AT Series` MCP server 条目（Cursor 对应 `~/.cursor/mcp.json`，Kiro 对应 `~/.kiro/settings/mcp.json`，或工作区本地的 Continue 配置），指向共享的 Hub bundle。如果你还安装了其他 AT 系列插件，它们会共用同一条入口——不会为 Grafana 单独再生成一个 MCP server。
3. 如果你的 MCP 客户端没有自动感知到新配置，重新加载/重连一下。此时应该能看到全部 17 个 `grafana_*` 工具，且均已预先批准（无需逐个手动批准，因为每个工具都是 `risk: read`）。
4. 如需移除 AT Grafana 的接入而不影响其他插件的条目，运行 **「AT Grafana: 卸载 AT Series MCP 配置」**（英文界面下为 **AT Grafana: Uninstall AT Series MCP Config**）。如果其他 AT 系列插件仍需要共享的 `AT Series` 条目，该命令不会删除这条共享入口本身。

工具目录为发现类（`grafana_list_instances`）、8 个管理类工具、8 个监控数据类工具。`grafana_list_dashboards` 接受可选的 `query` / `tag` / `folderUid`。`grafana_get_dashboard` 缺省 `fields: "targets"`（完整 model 需传 `fields: "full"`）。`grafana_list_alert_rules` 接受可选 `states`。`grafana_generate_deeplink` 始终返回 `grafanaUrl`（`openInIde` 缺省 false）。优先在四个 Prom/Loki list 工具之后用 `grafana_query_prometheus` / `grafana_query_loki`；`grafana_query_datasource` 作为仅 `GET`/`POST`、带 path 禁锢的兜底，超限结果带 `truncated: true`。

连接成功后，关于如何高效使用工具目录的 Agent 侧指南，见 [`skills/at-grafana-mcp/SKILL.md`](../skills/at-grafana-mcp/SKILL.md)。
