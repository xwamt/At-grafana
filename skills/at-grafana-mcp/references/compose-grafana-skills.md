# Compose official Grafana skills

AT Grafana tools fetch live instance data. They do not teach PromQL, LogQL, or dashboard JSON authoring.

If the user is writing or reviewing queries/dashboards (not just reading this Grafana), install official skills:

```bash
npx skills add grafana/skills
```

Relevant official skills (do not duplicate their content here):

- `promql` — write/validate PromQL
- `loki` — LogQL and label strategy
- `dashboarding` — dashboard JSON
- `alerting-irm` — alerting concepts

Official MCP (`uvx mcp-grafana` / grafana/ai-marketplace) is a *different* server. This plugin uses the AT Series Hub (`pluginId` `at.grafana`). Do not configure a second Grafana MCP unless the user explicitly wants the official server instead of AT Grafana.
