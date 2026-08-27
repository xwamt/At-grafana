# AT Grafana 0.1.3 — 性能 / 功能完善性 / 用户友好度 优化建议

**Status:** Proposed（分析结论，尚未实施）  
**Date:** 2026-08-27  
**Scope:** 当前 `master`（v0.1.3，17 工具 MCP 目录，559 单测）  
**Method:** 三个子代理并行审阅，模型均为 `claude-fable-5-thinking-xhigh`：

| 维度 | 子代理 ID | 焦点 |
|---|---|---|
| 性能 | `bc-655b52b7-af99-5853-b70a-9f7d19a49647` | 激活、HTTP/TOFU、树刷新、MCP 查询、嵌入代理、bundle |
| 功能完善性 | `bc-74b07b3c-4990-5a7a-a950-d861e5d5b702` | 对照 `docs/requirements.md` + ADR-001…007 + 17 工具实现 |
| 用户友好度 | `bc-c592e00b-be6c-51d8-af55-bd06dc192587` | 入门旅程、树/表单/嵌入、i18n、Agent 侧文案 |

父代理对 P0/P1 结论做了源码抽查（`GrafanaHttpClient.attachCertVerification`、`GrafanaAlertsApi.toAlertRule`、`testGrafanaConnection`、`toolCatalog`、`notifications.ts`）。性能子代理在 Node 22 上用真实 `GrafanaHttpClient` 复现了 HTTPS keep-alive 挂起。

**约束（本建议不重开 ADR）：** V1 保持只读、无多 Org、无 Legacy Alerting、无单 panel 下钻、无 Grafana Live WebSocket 代理。

---

## 1. 总评

V1 的安全边界与 MCP 契约质量高：Token 在 SecretStorage、日志脱敏、实例级 Agent 门禁默认关、查询限流/截断、17 个 `risk=read` 工具与文档口径一致。产品已经「能用、能给 Agent 用」。

当前短板不在架构，而在三类**兑现缺口**：

1. **HTTPS 热路径每两拍挂 15 秒**（TOFU 延迟写入 × Node ≥19 keep-alive）。这是唯一已实证的 P0，波及树刷新、MCP 查询、嵌入面板。
2. **告警规则工具名不副实**：`grafana_get_alert_rule` 承诺完整定义，却丢掉 `data`（PromQL）和 `notification_settings`，S6「Agent 巡检告警是否合理」做不到。
3. **自签名 Grafana 的第一天体验是死胡同**：表单 Test Connection 不走 TOFU，永远红字；树/Agent 错误不可操作；Agent 闸门在树上不可见。这正是需求里的主用户画像。

559 个单测覆盖纯逻辑层很密；项目自认的最高风险（嵌入重写、alert history 形状、真实 MCP 安装）仍标 *Pending manual verification*，从 0.1.0 起未关闭。

---

## 2. 跨维度交叉项（同一根因，多面受损）

这些条目在三份报告中重复出现，应作为「一次改动、三面收益」优先做。

| 交叉 ID | 根因 | 性能 | 功能 | UX | 建议批次 |
|---|---|---|---|---|---|
| X-01 | TOFU `secureConnect` 只在新握手触发，keep-alive 复用 socket 永不 `onVerified` | PERF-01 P0 | — | 树/嵌入间歇性卡住 | **Wave 0** |
| X-02 | `testGrafanaConnection` 故意不查 TrustStore | — | FUNC-02 P1 | UX-01 P1 | **Wave 1** |
| X-03 | `toAlertRule` 丢 `data` / `notification_settings`；`isPaused` 未透出 | PERF-06 全量 list 再 find | FUNC-01/09 | Agent/树把 paused 当成 unknown | **Wave 1** |
| X-04 | 树 `contextValue` 已设，无 `view/item/context` | — | FUNC-08 | UX-04/05 | **Wave 1** |
| X-05 | 面向用户的错误不走 `t()`，toast 3 秒无按钮 | 双重 redaction 热路径 | FUNC-18 设置描述滞后 | UX-02/03/06/07/08 | **Wave 1** |
| X-06 | 嵌入代理每资产：zod 全量解析 + SecretStorage + identity 编码 + 全量重写 | PERF-02/03/10/11 | FUNC-10/11 活体债 | UX-12 空白 iframe | **Wave 2** |
| X-07 | 管理类 HTTP 无 `maxResponseBytes` | PERF-09 | FUNC-17 | Agent 上下文被巨型 JSON 撑爆 | **Wave 2** |
| X-08 | 活体验证 / 12h·5MiB 校准从未落地 | — | FUNC-04/11 | 文档与产品承诺不对齐 | **Wave 2** |

---

## 3. 优先实施顺序（跨维度合并）

按「影响 / 工作量 / 不破坏 V1 边界」排序。工作量：S ≤ 半天量级改动，M 需跨模块 + 补测，L 需新子系统或活体环境。

### Wave 0 — 止血（建议立刻做）

| 顺位 | ID | 改动 | 工作量 |
|---|---|---|---|
| 1 | PERF-01 | 修复 HTTPS keep-alive × TOFU 挂起；引入模块级共享 `https.Agent`；补「同一 client 连续两次 HTTPS」测试 | M |

### Wave 1 — 兑现承诺 + 第一天体验（建议下一小版本）

| 顺位 | ID | 改动 | 工作量 |
|---|---|---|---|
| 2 | FUNC-01 + FUNC-09 + PERF-06 | `grafana_get_alert_rule` 保留 `data`/`notification_settings`；列表与树透出 `isPaused`；单条走 provisioning `GET .../alert-rules/{UID}` | S–M |
| 3 | FUNC-02 + FUNC-05 + UX-01 | Test Connection 接入 TOFU；新增 Forget Trusted Certificate 命令 | M |
| 4 | UX-02 + UX-03 + UX-07 + UX-08 | 错误改原生 `showErrorMessage` 带「修复 MCP / 打开日志 / 编辑实例」；启用 `FAILED_NOTIFICATION_MS`；VS Code 宿主文案不再指向 Continue；TLS 拒绝给 Agent 恢复指引 | S |
| 5 | UX-04 + UX-05 + FUNC-08（V1 子集） | 消费已有 `contextValue`：编辑/删除/开关 Agent、浏览器打开、复制链接；实例节点标明 Agent 开关 | M |
| 6 | FUNC-16 + FUNC-06 + FUNC-07 + UX-15 | targets/summary 带精简 `templating`；`fields=full` 与过滤器组合禁止静默忽略；Loki instant 透传 limit/direction；`list_instances` 空结果带 hint | S |

### Wave 2 — 嵌入与稳健性

| 顺位 | ID | 改动 | 工作量 |
|---|---|---|---|
| 7 | PERF-02 + PERF-03 | 代理缓存 instance/token；非重写资源透传压缩；重写产物按 ETag LRU | M |
| 8 | PERF-04 + PERF-05 | 两棵树共享 folders 拉取；folder→dashboards 预分组 Map | S |
| 9 | PERF-09 + FUNC-17 + PERF-12 | 管理类读取加宽松字节上限；discovery regex 长度/耗时护栏 | S |
| 10 | FUNC-11 + FUNC-04 + UX-12 | docker Grafana+Prometheus 关掉 DoD 1/2/3/9；校准 12h/5MiB；嵌入 loading/错误页；alert history `from`/`to`/`limit` | M |
| 11 | PERF-07 + PERF-08 + UX-06 + UX-13 + UX-14 | 去掉双重 zod / 双重 redaction；展示层按 `GrafanaApiError.kind` 本地化；删「(ADR-004)」；设置描述走 nls、去掉 pending-calibration 口吻 | S |

### Wave 3 — 体验打磨（可排期）

- UX-09 过滤：`when` 控制清除按钮、`workspaceState` 持久化、隐藏无匹配文件夹；告警树对称过滤  
- UX-10 从命令面板隐藏无参必失败的 `openDashboard` / `openAlertRule`  
- UX-11 告警自动刷新间隔设置 + TreeView badge（firing 计数）  
- UX-17 首次写入 MCP 配置给一次可见提示  
- FUNC-03 嵌套文件夹按 `parentUid` 组装  
- FUNC-13 Explore 深链可带 `expr`；`kind: alertRule`  
- FUNC-14 `openInIde` 不从 Agent 路径弹出 TOFU 模态框  
- PERF-10/11 `retainContextWhenHidden` 策略与空闲代理关闭（先文档化成本，再做产品取舍）

---

## 4. 性能（PERF）

### 4.1 现状

激活走 `onStartupFinished`，同步构造后并行 hub 同步 / Bridge 启动 / MCP ensure，冷启动不是瓶颈。bundle ~303KB minified（src ~95KB，zod / js-yaml / mcp-hub 各 ~60KB）。查询路径已有令牌桶、5MiB 响应上限、分页护栏（1000/页、10000 上限）。

负载下的真实痛点是：**HTTPS 实例在现代宿主上每隔一次请求挂起至 socket 超时**，以及嵌入面板每个子资源都做一次配置解析 + 明文传输 + 全量字符串重写。

### 4.2 问题清单

#### PERF-01 — keep-alive socket 使 TOFU 延迟写入永久挂起 · **P0** · M

- **位置:** `src/grafana/GrafanaHttpClient.ts` `performRequest` / `attachCertVerification`；`src/webview/GrafanaEmbedProxy.ts` `forward`
- **现象:** 有 `certVerifier` 的 HTTPS 请求把 body 写延迟到 `socket.once('secureConnect')`。复用的 keep-alive socket **不会再触发** `secureConnect`，`onVerified` 永不回调，请求空挂到 15s timeout。
- **证据:** Node 22 实测：req1 11ms 成功，req2 在 timeoutMs=3000 时失败，`reusedSocket=true` 且 `secureConnect fired=false`。VS Code / Cursor 宿主 Node ≥19 全局 Agent 默认 keep-alive。
- **影响:** 树分页第 2 页起交替 +15s；MCP `proxyDatasourceRequest` 显式 `retry: false`，Agent 直接拿到网络错误；嵌入资产与 API 客户端还共享同一 host:port 连接池。
- **建议:**  
  1. 根治：`attachCertVerification` 检测复用 socket（`request.reusedSocket` 或已完成握手），同步 `getPeerCertificate()` 后立即 verify + `onVerified`。  
  2. 同时引入**模块级**共享 `https.Agent({ keepAlive: true })`（每次 `new GrafanaApiClient` 无法跨调用复用 per-client agent）。  
  3. 止血备选：certVerifier 路径 `keepAlive: false`。  
  4. 补「同一 client 连续两次 HTTPS」回归测试。
- **风险:** 复用路径的指纹变更必须同样 fail-closed；`rejectUnauthorized: false` 参与 Agent 分池。

#### PERF-02 — 嵌入代理每个子资源都 zod 全量解析 + SecretStorage IPC · P1 · S

- **位置:** `GrafanaEmbedProxy.handleRequest` → `configManager.getInstance` / `getToken`
- **建议:** 代理内按 instanceId 缓存 `{instance, token}`，实例保存回调显式失效（不要纯 TTL）。

#### PERF-03 — 强制 `accept-encoding: identity` + 可重写响应全量缓冲、无缓存 · P1 · M

- **位置:** `GrafanaEmbedProxy.forward` / `relayRewritableBody` / `rewriteAbsoluteReferences`
- **建议:** 仅对 document/script/style 强制 identity（或 gzip 解压后再重写）；其余透传压缩并 pipe；重写产物 LRU，键 = `instanceId + path + 上游 ETag`。embed token 前缀导致跨会话缓存全失效，ETag 缓存是会话内收益。

#### PERF-04 — 一次刷新 folders 拉两遍，无请求取消 · P2 · S

- **位置:** `extension.ts` `refreshTreeViews`；`DashboardTreeProvider.fetchInstanceData`；`AlertTreeProvider.fetchInstanceGroups`
- **建议:** 跨 provider 共享 per-instance folders Promise；`refresh()` 用 AbortController 取消旧请求。

#### PERF-05 — 文件夹展开 O(D) 线性过滤 · P2 · S

- **位置:** `DashboardTreeProvider.getFolderChildren`
- **建议:** 拉取后建 `Map<folderUid, dashboards[]>`，预计算 `titleLower`。

#### PERF-06 — `grafana_get_alert_rule` 全量 list 再 find · P2 · S

- **位置:** `GrafanaAgentToolService.getAlertRule`（注释自称 accepted V1 inefficiency）
- **建议:** `GET /api/v1/provisioning/alert-rules/{uid}`（与 FUNC-01 同一变更集）。

#### PERF-07 — Bridge 与 ToolService 双重 zod，且第一遍 defaults 被丢弃 · P2 · S

- **位置:** `BridgeServer.handleInvoke` 把**原始** `args` 传给 `toolService.invoke`
- **建议:** 保留 ToolService 为权威校验层；Bridge 只做 schema 存在性，或 `invoke` 接受已解析数据。

#### PERF-08 — 每条日志双重 redaction（16 次正则）；trace 无级别守卫 · P2 · S

- **位置:** `asRedactedLog` 不识别已包装的 log；`GrafanaEmbedProxy` 每转发一条 trace
- **建议:** 包装打品牌标记；trace 热路径读 `LogOutputChannel.logLevel` 短路。

#### PERF-09 — 管理类端点无字节上限 · P2 · S

- **位置:** `GrafanaHttpClient.maxResponseBytes` 默认关闭；仅 `queryDatasource` 传入
- **建议:** Agent 可达的管理读取统一宽松上限（如 20MiB），走已有 `response-too-large`。

#### PERF-10 — 每个嵌入面板 `retainContextWhenHidden: true` · P2 · S（决策成本大）

- **建议:** 先在文档标明「N 个打开的 Grafana SPA 常驻」；超阈值不再 retain，或隐藏后停轮询。不要未经产品取舍直接改 false。

#### PERF-11 — 嵌入代理无空闲关闭 · P2 · S

- **建议:** 最后一个面板 dispose 后延迟 ~60s `proxy.dispose()`；`start()` 已幂等。

#### PERF-12 — Agent `regex` 直接 `new RegExp` 全量 filter（ReDoS） · P2 · S

- **位置:** `typedDatasourceDiscovery.projectDiscoveryValues`
- **建议:** schema `max(256)`；先截断候选再 filter；或循环内耗时护栏。

#### PERF-13 — 每次启动都 ensure MCP 配置 / hub 拷贝 · P2 · S

- **建议:** `globalState` 记录 `lastEnsuredHubVersion`，版本未变则跳过文件读写。不要为 zod 做 bundle 拆分。

### 4.3 不建议做

- 树虚拟化 / 细粒度 TreeView diff（瓶颈在网络，VS Code 树本身惰性）
- MCP 管理工具通用响应缓存（告警/仪表盘要新鲜数据）
- 替换 zod 或手写校验（浪费在「跑两遍」不在 zod 本身）
- Bridge `/invoke` 流式化（5MiB 封顶 + 完整 JSON 信封）
- 常驻 `GrafanaApiClient` 实例（应池化 TCP，而不是 client 对象）
- 为性能实现 WebSocket/Live 代理（ADR 已接受的限制）
- 微调 `QueryRateLimiter` 算法

---

## 5. 功能完善性（FUNC）

### 5.1 现状

对照 `docs/requirements.md`：CFG/UI/PROXY/MGT/MON/HUB 的 P0 绝大多数已落地。多 Org 确认**没有**半实现（`src/` 零处 `orgId`）。GET/POST 白名单与 datasource path 禁锢在 Zod、`proxyDatasourceRequest`、`buildDatasourceProxyPath` 三层执行。

主要落差：MGT6 描述与实现相悖；CFG4/CFG5 信任生命周期未闭环；PROXY3 需求文仍把 WebSocket 写成 P0；活体 DoD 四个版本未关。

### 5.2 需求对照（摘要）

| 状态 | ID |
|---|---|
| 完整 | CFG1–3，UI2–5，PROXY1/2/4/5，MGT1/2/4/5/8/9，MON1/2/2c–2f/3/4，HUB1–7，NFR 安全 |
| 部分 | CFG4/5，UI1（嵌套文件夹拍平），PROXY3，MGT3/6/7，MON2a/2b，NFR 性能可见性 / Grafana 版本声明 |
| 关键缺口 | **MGT6** `grafana_get_alert_rule` 丢查询定义 |

### 5.3 问题清单

#### FUNC-01 — `grafana_get_alert_rule` 丢弃 `data` 与通知策略 · **P1** · S · V1 内

- **位置:** `GrafanaAlertsApi.toAlertRule`；`toolCatalog.ts` 描述承诺 "notification policy references"
- **现象:** provisioning API 的 `data: AlertQuery[]` 和 `notification_settings` 被丢掉；`condition` 只是 `"C"` 这类 refId，Agent 看不到 PromQL。S6 无法完成。
- **建议:** `getAlertRule` 返回完整对象（含 `data`）；`listAlertRules` 保持轻量投影。同步 SKILL / 工具描述。

#### FUNC-02 — Test Connection 不接入 TOFU · **P1** · M · V1 内

- **位置:** `testGrafanaConnection.ts` 注释写明不查询 TrustStore
- **现象:** 已信任的自签实例在表单里恒报 TLS 失败；usage 文档「测试通过 → 确认指纹 → 保存」的流程实际不存在。
- **建议:** 测试走 `GrafanaApiClient.health()` + `createInteractiveCertVerifier`。

#### FUNC-03 — 嵌套文件夹拍平 · P2 · M · V1 内

- **位置:** `toFolder` 已解析 `parentUid`，树未消费
- **建议:** 按 `parentUid` 递归；此前文档注明平铺。

#### FUNC-04 — alert history 形状未验证、无窗口参数 · **P1** · M · V1 内

- **位置:** `getAlertRuleHistory` / `parseHistoryFrame`（自述 UNVERIFIED）
- **建议:** 活体验证 Grafana 10/11；schema 加 `from`/`to`/`limit`；404/501 提示需启用 Loki-backed state history。

#### FUNC-05 — 已信任指纹无撤销入口 · P2 · S · V1 内

- **位置:** `GrafanaCertTrustStore.forget()` 在 `src/` 无调用者
- **建议:** 命令 `AT Grafana: Forget Trusted Certificate`（QuickPick host:port + 指纹）。

#### FUNC-06 — `fields:"full"` 时 `panelIds`/`titleContains` 静默忽略 · P2 · S · V1 内

- **建议:** full 也过滤，或 schema 拒绝该组合。禁止静默忽略。

#### FUNC-07 — 典型化查询 instant 静默丢参 · P2 · S · V1 内

- **建议:** Loki instant 透传 `limit`/`direction`；Prom instant + `step` 在 schema 拒绝或结果附 message。

#### FUNC-08 — 树交互落后于 Agent 目录 · P2 · M · 右键菜单属 V1；panel 下钻仍非目标

- **建议:** 补 `view/item/context`；告警状态过滤对称 Agent 的 `states`。

#### FUNC-09 — paused 显示为 unknown · P2 · S · V1 内

- **建议:** 输出与树 description 加 `isPaused`；独立图标。

#### FUNC-10 — requirements.md PROXY3 仍写 WebSocket P0 · P2 · S（文档）

- **建议:** 回写为「Upgrade 直接销毁，Live 需手动刷新」；WebSocket 代理本身保持 V2。

#### FUNC-11 — 活体验证与上限校准债务（DoD 1/2/3/9） · **P1** · M · V1 内

- **现象:** `@vscode/test-electron` 在 devDependencies 但无 E2E；12h/5MiB 仍标 pending calibration。
- **建议:** `grafana/grafana` + `prom/prometheus` compose，一次关闭 DoD 与 FUNC-04。

#### FUNC-12 — 0.1.2 发布说明出现不存在的 Organization ID / TLS 表单字段 · P2 · S

- **建议:** 修订该句。表单实际只有 label / url / token / allowBackgroundAccess。

#### FUNC-13 — Explore 深链不能带表达式；无 alertRule 深链 · P2 · S · 只读 URL 拼接，可放 V1

#### FUNC-14 — `openInIde:true` 可从 Agent 路径弹出 TOFU 模态框 · P2 · S

- **建议:** opener 前非交互检查 TrustStore；未信任则 `openedInIde:false` + message。

#### FUNC-15 — 测试空白（随 FUNC-01/02/04/06/07 以 TDD 补） · P2 · M

#### FUNC-16 — targets/summary 丢 `templating` · P2 · S · V1 内

- **现象:** expr 里 `$job` 无法解析，Agent 被迫 `fields:full`，投影省上下文的初衷被击穿。
- **建议:** 投影追加 `templating.list` 的 name/type/query/current。

#### FUNC-17 — 管理类无响应体积上限 · P2 · S–M · 见 PERF-09

#### FUNC-18 — 设置描述只提 `grafana_query_datasource`；速率限制常量不可见 · P2 · S

- **建议:** 更新 markdownDescription（实际上限约束 7 个工具）；features 增加「查询计量」小节（60 qpm / 4 并发不必都做成旋钮）。

### 5.4 明确非目标（除非重开 ADR）

- 任何写操作（silence / ack / pause / CRUD）
- 多 Org、Legacy Alerting、单 panel `d-solo` 下钻
- Grafana Live WebSocket 代理
- 官方 50 工具目录 / Tempo / OnCall / Sift
- Prom/Loki 之外的专属高阶查询工具
- 自绘图表引擎

---

## 6. 用户友好度（UX）

### 6.1 现状

安全与 Agent 工具描述是优势：默认值写进 catalog、截断带 reason、限流错误区分「资源上限 vs 权限」。无实例时空数组让 `viewsWelcome` 正确渲染。技能文件有 discover → select → call。

摩擦集中在：**自签名第一天、错误不可操作、树只读、Agent 闸门不可见、中英混排错误、纯 VS Code 宿主 MCP 静默不可用。**

### 6.2 用户旅程流失点

| 阶段 | 流失 |
|---|---|
| 安装 | 激活静默改写 `mcp.json`；失败 toast 3 秒消失；无 walkthrough |
| 添加实例 | 自签名 Test Connection **必然失败**，表单无信任入口 |
| 浏览 dashboard | 离线时最坏 ~45s（15s × 3 重试）才出现 Failed to load；嵌入空白 iframe；代理错误页全英文 |
| 看 firing 告警 | 无自动刷新、无 badge、排序规则产品内不可见 |
| 启用 Agent | Manage Instances → 选实例 → Edit → 勾选 → 保存，五步；树上无状态 |
| MCP 查询 | 未完成 TOFU 时 Agent 只得到拒绝证书的句子；全关闸门时 `list_instances` 返回裸 `[]` |

### 6.3 问题清单

#### UX-01 · Test Connection 与 TOFU 脱节 · P1 · M · 同 FUNC-02

#### UX-02 · 错误 toast 3 秒消失，`FAILED_NOTIFICATION_MS` 死代码，无按钮 · P1 · S

- **位置:** `src/utils/notifications.ts`；`extension.ts` 全部 `showTimedNotification(..., 'error')`
- **建议:** 错误/警告改 `showErrorMessage` / `showWarningMessage`，按钮「修复 MCP 配置」「打开日志」。

#### UX-03 · 纯 VS Code 上 MCP 静默不可用 + 误导向 Continue · P1 · S

- **位置:** `McpConfigInstaller.resolveMcpInstallerTarget`；`extension.ts` 提示 *"Open a workspace to install Continue config."*
- **建议:** 区分「当前 IDE 不支持自动写入（支持 Cursor / Kiro / Continue）」与「Continue 需要打开工作区」。

#### UX-04 · 无右键菜单 · P1 · M · 同 FUNC-08

`GrafanaTreeItems.ts` 已设 `atGrafana.instance` / `dashboard` / `alertRule` 等 `contextValue`，`package.json` 未 contribute `view/item/context`。

#### UX-05 · 实例 Agent 访问状态不可见 · P1 · S

- **建议:** `InstanceTreeItem` description/tooltip：「Agent 访问：已启用/已关闭」，图标区分。

#### UX-06 · 下层错误未本地化 · P1 · M

硬编码英文直达树、表单、iframe：`GrafanaHttpClient.ts`、`testGrafanaConnection.ts`、`ensureGrafanaTlsTrust.ts`、`GrafanaEmbedProxy.respondError`。

- **建议:** 展示层按 `GrafanaApiError.kind`（network/tls/auth/api-error）映射 `t()` 文案，不要透传底层 message。

#### UX-07 · 401/TLS 不可操作 · P1 · S

对比好文案已存在：*"No Service Account Token is configured for "{label}". Edit the instance to add one."* —— 仅覆盖 token 缺失。`ErrorTreeItem` 应挂编辑命令。

#### UX-08 · Agent 因未 TOFU 失败无恢复路径 · P1 · S

- **建议:** 错误追加 *"The user must open this instance once in the AT Grafana sidebar to confirm its TLS fingerprint."*；写入 `SKILL.md` 排障节。

#### UX-09 · 过滤器清除按钮常驻、不持久、不跨文件夹 · P2 · M

#### UX-10 · `openDashboard` / `openAlertRule` 出现在命令面板且无参必失败 · P2 · S

- **建议:** `commandPalette` `"when": "false"`，或无参时 QuickPick。

#### UX-11 · 无自动刷新、无新鲜度 · P2 · M

- **建议:** `atGrafana.alerts.refreshIntervalSeconds`（0=关）；Alerts 改 `createTreeView` 以支持 badge。

#### UX-12 · 嵌入无加载态、错误页脱离主题、Live 降级无产品内提示 · P2 · M

#### UX-13 · 表单帮助文案泄漏 "(ADR-004)" · P2 · S

中英包都原样保留。改为面向用户的风险说明。

#### UX-14 · 设置描述含 "pending calibration" 开发笔记且未走 nls · P2 · S

43200000 ms / 5242880 bytes 对用户不友好。

#### UX-15 · `grafana_list_instances` 空结果无 hint · P2 · S

保持防枚举：两种空情况用同一句 *"No instances have Allow background Agent access enabled."*

#### UX-16 · 无 keybindings；webview `lang="en"` 硬编码；表单 help 未 `aria-describedby` · P2 · S

#### UX-17 · 首次激活静默改写用户 MCP 配置 · P2 · S

- **建议:** 首次写入给一条带「了解详情」的 info toast（或一次性确认）。

#### UX-18 · 告警 firing-first 仅文档可见 · P2 · M

组 description 加 firing 计数，如 `3 rules · 1 firing`。

#### UX-19 · "VS Code SecretStorage" 在 Cursor 中不准 · P2 · S

按 `vscode.env.appName` 或改为「IDE 安全密钥存储」。

### 6.4 文案 / i18n 缺口（实施 UX-06 时一并清）

未走 `t()` 的用户可见英文（节选）：

- `Invalid Grafana URL.` — `ensureGrafanaTlsTrust.ts`
- `TLS certificate is not trusted: …` / `Grafana rejected the token (HTTP {status}).` — `testGrafanaConnection.ts`
- `Grafana rejected the request (HTTP {status}).` / `Grafana TLS certificate for {host}:{port} was rejected…` — `GrafanaHttpClient.ts`
- `Failed to start AT Grafana embed proxy.` 及 iframe 内整页英文错误 — `GrafanaEmbedProxy.ts`

其它：

- `package.json` 两个 `queryLimits.*` `markdownDescription` 未用 `%key%`
- zh-CN `"如果您认领并信任此 Grafana 服务器"`：「认领」应为「确认/认识」（原文 recognize）
- 过滤提示中英引号风格不统一
- `usage.zh-CN.md` 命令名写英文 `Add Instance`，界面实际是「添加实例」
- `grafana_get_alert_history` 工具描述过薄，与同族不一致

---

## 7. 建议的版本切片

不在本文实施代码。若按建议推进，推荐切片：

| 版本 | 主题 | 纳入 |
|---|---|---|
| **0.1.4** | 正确性止血 | PERF-01；FUNC-01/09；FUNC-02/05；UX-02/03/05/08/13；FUNC-12 文档；FUNC-10 需求回写 |
| **0.1.5** | Agent 上下文 + 树交互 | FUNC-16/06/07；UX-04 右键菜单；UX-15；PERF-06 单条 alert GET；PERF-07/08 |
| **0.2.0** | 嵌入与活体 | PERF-02/03/04/05/09/12；FUNC-04/11 活体 compose；UX-11/12；设置 nls 与计量文档 |

0.2.0 不包含写操作或 Live 代理。

---

## 8. 验证要求（实施时）

每项代码改动需：

1. `npm run typecheck` 与 `npm test` 保持绿。
2. PERF-01 必须有「连续两次 HTTPS + keep-alive」回归，不能只靠现有 559。
3. FUNC-01 断言 `data` / `notification_settings` 出现在 get、不出现在 list（或 list 明确精简）。
4. UX 改动若动到 webview/树，需在 Extension Development Host 走一遍：添加自签名实例 → Test Connection → 保存 → 展开树 TOFU → 打开 dashboard → 开 Agent 开关 → 命令面板错误路径。
5. 不把「pending calibration」从设置文案删掉的同时却不校准默认值——要么校准，要么把口吻改成用户指导并在代码注释保留待测备注。

---

## 9. 源码锚点（实施入口）

| 主题 | 文件 |
|---|---|
| TOFU × keep-alive | `src/grafana/GrafanaHttpClient.ts`，`src/grafana/createInteractiveCertVerifier.ts` |
| 连接测试 | `src/grafana/testGrafanaConnection.ts`，`src/webview/GrafanaInstanceFormPanel.ts` |
| 告警规则投影 | `src/grafana/GrafanaAlertsApi.ts`，`src/agent/GrafanaAgentToolService.ts`，`src/mcp/toolCatalog.ts` |
| 树与菜单 | `src/tree/*.ts`，`package.json` `contributes.menus` |
| 嵌入代理 | `src/webview/GrafanaEmbedProxy.ts`，`src/webview/html.ts` |
| 通知 / i18n | `src/utils/notifications.ts`，`src/extension.ts`，`l10n/bundle.l10n.zh-cn.json` |
| 查询上限 | `src/grafana/QueryLimits.ts`，`package.json` `atGrafana.queryLimits.*` |
| Agent 技能 | `skills/at-grafana-mcp/SKILL.md` |

---

## 10. 附录：子代理原始结论索引

完整原始报告保留在各自子代理会话中（见文首 ID）。本文是交叉去重后的规范建议；冲突时以本文 + 源码抽查为准。已知需在实施时再确认的点：

- PERF-01 在无 keep-alive 的旧 Node 18 宿主上可能不复现；修复仍应对新旧路径都正确。
- Grafana provisioning `GET /alert-rules/{uid}` 的响应形状需在目标 9.1+ 范围抽检后再当单条路径（FUNC-01 即使暂不换端点，也应停止丢 `data`）。
- `retainContextWhenHidden`（PERF-10）是产品取舍，不是纯性能缺陷。
