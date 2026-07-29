# ADR-003: Panel/alert embedding via local reverse proxy iframe

## Status
Accepted

## Date
2026-07-29

## Context

Requirement UI3/UI4 (`docs/requirements.md` §4.2) needs Webview panels that show live, fully interactive native Grafana dashboard and alert-rule pages (zoom, tooltips, native time range picker — not static snapshots). The chosen auth method is a per-instance **Service Account Token** (ADR D2), used as a Bearer token against the Grafana HTTP API.

A VS Code Webview `<iframe>` pointed directly at a Grafana origin cannot attach a custom `Authorization` header — the browser controls the navigation/sub-resource requests, not our code. Alternatives considered:

| Option | Problem |
|---|---|
| Public Dashboards (Grafana 9.1+) | Requires a Grafana admin to manually enable public sharing per dashboard; the resulting link is anonymously accessible to anyone with the URL — unacceptable default for most production Grafana instances. |
| Manual login inside the Webview (session cookie) | Requires the user to maintain a second credential (their personal Grafana login) distinct from the Service Account Token already configured for §4.4/§4.5 tools; session cookies expire and force re-login inside a cramped Webview UI. |
| Require Grafana Anonymous Auth | Changes the security posture of the user's Grafana server itself; most production deployments cannot or will not enable this. |
| Render API snapshot (image renderer plugin) | Produces a static, non-interactive PNG; requires the target Grafana to have the image-renderer plugin installed. Rejected because interactivity was an explicit requirement. |

## Decision

The extension host runs a **local HTTP reverse proxy**, bound to `127.0.0.1` on an ephemeral port (implemented alongside/extending the existing `BridgeServer` infrastructure from [ADR-001](ADR-001-scaffold-from-at-terminal-series.md)):

- Webview `<iframe src>` points at `http://127.0.0.1:<proxyPort>/instances/<instanceId>/...` — never at the real Grafana origin directly.
- The proxy looks up the Service Account Token for `<instanceId>` from `SecretStorage`, injects `Authorization: Bearer <token>` on every proxied request (page load, JS/CSS assets, XHR/fetch calls Grafana's own frontend makes, and WebSocket upgrade requests used by Grafana Live where applicable), and forwards to the real Grafana origin.
- Absolute URLs and redirects returned by Grafana (e.g. `Location` headers, any absolute asset URLs embedded in HTML/JS) must be rewritten to stay under the local proxy origin so the browser never attempts a direct, unauthenticated request to the real Grafana origin.
- The proxy only forwards requests for instances that are TLS-trusted per [ADR D3](../requirements.md) (Trust-On-First-Use); untrusted instances are refused at the proxy layer, not just at the tree UI layer.
- Webview CSP (`connect-src`, `frame-src`, `img-src`, etc.) is restricted to the local proxy origin only.

## Consequences

- Works against any Grafana version/deployment without requiring the Grafana admin to change any server-side configuration (no Public Dashboards, no Anonymous Auth).
- The Service Account Token never reaches the Webview's renderer process or network layer — it stays entirely inside the extension host, consistent with the series-wide invariant that "tools never return credentials" (Hub Protocol v1 §14) extended to the UI layer as well.
- Adds real implementation complexity: HTML/JS response rewriting for absolute URLs, WebSocket proxying for Grafana Live features, and correct CSP configuration. This complexity is scoped to a single `GrafanaEmbedProxy` component so it doesn't leak into the tree/config/Bridge code.
- The proxy route for a given instance should only be considered "live" while at least one Webview panel for that instance is open; it does not need to be reachable when no panel is open, and is a distinct code path from the MCP Bridge's `/invoke` tool execution (the proxy serves HTML/assets; the Bridge serves JSON tool results).
