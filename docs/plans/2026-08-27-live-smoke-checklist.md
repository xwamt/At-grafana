# AT Grafana — Live Smoke Checklist (DoD 1 / 2 / 3 / 9)

**Status:** Manual checklist — run by a human in an Extension Development Host. Not wired into CI.
**Date:** 2026-08-27
**Scope:** The four [0.1.0 Definition-of-Done items](../releases/0.1.0.md#definition-of-done--item-by-item) that have been marked *Pending manual verification* since 0.1.0 (FUNC-11 in the [2026-08-27 optimization plan](2026-08-27-perf-completeness-ux-optimization.md)). Automated coverage for each item is listed in the 0.1.0 release notes; this checklist closes the live-environment half only.

## Environment

The repo root ships `docker-compose.smoke.yml` with a plain Grafana + Prometheus pair:

```bash
docker compose -f docker-compose.smoke.yml up -d
# Grafana:    http://localhost:3000  (login admin / admin, skip the password change)
# Prometheus: http://localhost:9090  (scrapes itself by default — instant metrics to query)
```

One-time Grafana setup (all inside http://localhost:3000):

1. **Datasource:** Connections → Data sources → Add data source → Prometheus, URL `http://prometheus:9090`, Save & test.
2. **Dashboard:** create any dashboard with one panel querying e.g. `prometheus_http_requests_total`, save it into a folder.
3. **Alert rule:** Alerting → Alert rules → New alert rule against the same metric (any threshold), save into an evaluation group.
4. **Service Account Token:** Administration → Users and access → Service accounts → Add service account (role **Viewer**) → Add service account token → copy it.

Then launch the Extension Development Host (`F5` in this repo) with the extension built (`npm run build`).

> The compose stack serves plain HTTP, so the TLS fingerprint half of DoD 1 needs an HTTPS front. Optional: put any TLS-terminating proxy with a self-signed cert (e.g. Caddy with `tls internal`) in front of `localhost:3000` and add the instance via that `https://` URL instead.

## Checklist

### DoD 1 — Add instance, (TLS fingerprint), tree appears

- [ ] Run **AT Grafana: Add Instance**; fill label, `http://localhost:3000`, and the Service Account Token.
- [ ] **Test connection** reports success (and distinguishes a wrong token as an auth failure if you try one).
- [ ] Save; the **Dashboards** view shows the folder + dashboard created above; the **Alerts** view shows the alert rule.
- [ ] *(HTTPS variant only)* First connection shows the certificate fingerprint confirmation dialog; refusing blocks, confirming proceeds, and the trust survives a reload.

### DoD 2 — Embedded dashboard is live and leak-free

- [ ] Click the dashboard node: a Webview tab opens showing the **fully interactive native Grafana page** (loading spinner first, then panels; tooltips, zoom, and the time-range picker work).
- [ ] Open Developer Tools → Network for the Webview: every request goes to `http://127.0.0.1:<port>/e/…` (the local proxy) — the real Grafana origin appears nowhere.
- [ ] Search the Network panel for the Service Account Token value: **zero matches** (no `Authorization` header, no token in any URL).
- [ ] Known accepted degradation: Grafana Live push (`/api/live/ws`) does not connect — panels update on manual refresh only (ADR-003; requirements PROXY3).

### DoD 3 — Embedded alert detail page

- [ ] Click the alert rule node: a Webview tab opens on Grafana's native Unified Alerting rule view for that rule (state, evaluation graph, rule definition all render).
- [ ] Clicking the same rule again reveals the existing tab instead of opening a duplicate.

### DoD 9 — MCP config install

- [ ] Run **AT Grafana: Install/Repair AT Series MCP Config** in a supported host (Cursor: `~/.cursor/mcp.json`; Kiro: `~/.kiro/settings/mcp.json`; Continue: workspace config).
- [ ] The config contains exactly **one** shared `AT Series` server entry (no plugin-specific second entry), with `autoApprove` limited to the Hub's built-in meta tools.
- [ ] After the MCP client reloads, all 17 `grafana_*` tools are listed and callable without per-tool approval prompts (instance must have **Allow background Agent access** enabled).
- [ ] **AT Grafana: Uninstall AT Series MCP Config** removes this plugin's registration without deleting the shared entry other AT plugins still use.

## Recording results

Check items off in a copy of this file (or the PR description) together with: Grafana image tag, Prometheus image tag, host IDE + version, and date. Update the corresponding *Pending manual verification* rows in `docs/releases/0.1.0.md` only when an item has actually been executed — this checklist existing does not close the DoD by itself.
