# AT Grafana — Usage

**Audience:** end users setting up and using the extension. See [`features.md`](features.md) for a feature overview and [`requirements.md`](requirements.md) for the full spec.

## 1. Add a Grafana instance

### Create a Service Account Token in Grafana

AT Grafana authenticates with a Grafana **Service Account Token** (Grafana 9.1+), not a personal login:

1. In Grafana, go to **Administration → Users and access → Service accounts**.
2. Click **Add service account**, give it a name (e.g. `at-grafana-agent`), and assign it the **Viewer** role.
   - **Viewer is sufficient** for every V1 read-only endpoint this extension uses (dashboards, folders, alert rules/history, datasources, and datasource proxy queries). No Editor/Admin role is required.
3. Open the new service account and click **Add service account token**. Copy the generated token immediately — Grafana only shows it once.

### Add the instance in the extension

1. Run **AT Grafana: Add Instance** from the Command Palette.
2. Enter a label, the instance's base URL (e.g. `https://grafana.example.com`), and paste the Service Account Token.
3. Click **Test connection** to confirm the URL/token are valid before saving. It reports network errors, untrusted TLS certificates, and authentication failures (401/403) as distinct outcomes.
4. On first successful connection to a new host, confirm the TLS certificate fingerprint shown (Trust-On-First-Use). If the fingerprint ever changes later, the connection is blocked until you explicitly re-confirm — this is not a bypassable warning.
5. Save. The instance now appears in the **AT Grafana** sidebar's Dashboards/Alerts views.

Use **AT Grafana: Manage Instances** to edit or delete an existing instance later.

## 2. Enable background Agent access (optional)

By default, a newly added instance is **not** reachable by an Agent through MCP, even after the AT Series MCP config is installed. To allow it:

1. Run **AT Grafana: Manage Instances**, select the instance, choose **Edit**.
2. Enable **Allow background Agent access** and save.

Once enabled, all 11 MCP tools become usable against that instance's `instanceId` at any time — the Agent does not need any dashboard/alert Webview panel open first. Disabling the toggle immediately blocks all further tool calls against that instance, and it stops appearing in `grafana_list_instances`.

## 3. Browse dashboards and alerts

- Expand the **Dashboards** view to see Grafana's folder tree; use the filter icon to search by title.
- Expand the **Alerts** view to see every Unified Alerting rule, grouped by folder, with **Firing** rules listed first.
- Click any dashboard or alert rule to open its live, fully interactive native Grafana page in a Webview tab.

## 4. Connect an MCP-capable IDE client

AT Grafana does not run its own MCP server — it registers with the shared **AT Series** Hub, the same entry used by every other AT-family plugin (AT Terminal, AT JumpServer, ...).

1. Run **AT Grafana: Install/Repair AT Series MCP Config** from the Command Palette.
2. This writes (or repairs) a single `AT Series` MCP server entry in your IDE's MCP configuration (Cursor `~/.cursor/mcp.json`, Kiro `~/.kiro/settings/mcp.json`, or a workspace-local Continue config) pointing at the shared Hub bundle. If you have other AT-family plugins installed, they share this same entry — you do not get a second, Grafana-specific MCP server.
3. Reload/reconnect your MCP client if it doesn't pick up the new config automatically. All 11 `grafana_*` tools should now be listed and pre-approved (no manual per-tool approval needed, since every tool is `risk: read`).
4. To remove AT Grafana's participation without touching other plugins' entries, run **AT Grafana: Uninstall AT Series MCP Config**. This does not delete the shared `AT Series` entry itself if other AT-family plugins still need it.

The catalog is discovery (`grafana_list_instances`), six management tools, and four monitoring tools. `grafana_list_dashboards` accepts optional `query` / `tag` / `folderUid`. `grafana_get_dashboard` defaults to `fields: "targets"` (complete model requires `fields: "full"`). Prefer `grafana_query_prometheus` / `grafana_query_loki`; keep `grafana_query_datasource` as a `GET`/`POST` escape hatch with path confinement and `truncated: true` on over-cap responses.

See [`skills/at-grafana-mcp/SKILL.md`](../skills/at-grafana-mcp/SKILL.md) for the Agent-facing guide to using the tool catalog effectively once connected.
