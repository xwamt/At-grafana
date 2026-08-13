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

- Webview `<iframe src>` points at `http://127.0.0.1:<proxyPort>/e/<embedToken>/instances/<instanceId>/...` — never at the real Grafana origin directly.
- The proxy looks up the Service Account Token for `<instanceId>` from `SecretStorage`, injects `Authorization: Bearer <token>` on every proxied request (page load, JS/CSS assets, XHR/fetch calls Grafana's own frontend makes, and WebSocket upgrade requests used by Grafana Live where applicable), and forwards to the real Grafana origin.
- **The proxy is authenticated.** `start()` mints an `<embedToken>` (32 CSPRNG bytes, via `@at-series/mcp-hub`'s `createBridgeToken`) that every embed URL carries and every request must present; it is compared with `timingSafeEqualToken`. Requests must additionally carry `Host: 127.0.0.1:<proxyPort>` (closing DNS rebinding) and, if they carry `Origin` at all, the proxy's own. Anything else gets a bare, unbranded 404 rather than a 401, so a loopback port sweep learns neither that this is AT Grafana nor that a valid guess exists.

  This is load-bearing because reaching the proxy *is* holding the Service Account Token. `<instanceId>` cannot serve as the credential: it is stored in plaintext in VS Code's `globalState` (`state.vscdb`), readable by any process running as the same user — a malicious npm `postinstall`, another extension, or any user-level program could read it, scan loopback for the port, and obtain a fully authenticated read/write Grafana channel for as long as the extension is active. Before 2026-08-13 the only admission checks were "this instanceId exists" and "its TLS is trusted", so that attack worked.
- Absolute URLs and redirects returned by Grafana (e.g. `Location` headers, any absolute asset URLs embedded in HTML/JS) must be rewritten to stay under the local proxy origin so the browser never attempts a direct, unauthenticated request to the real Grafana origin.
- The proxy only forwards requests for instances that are TLS-trusted per [ADR D3](../requirements.md) (Trust-On-First-Use); untrusted instances are refused at the proxy layer, not just at the tree UI layer.
- **Two CSPs, because CSP is per-document.** The parent Webview document gets a policy restricted to the local proxy origin only (`buildRecommendedCsp`). That policy's `frame-src` decides only *which* iframe may load; it places no constraint on the document inside it. So the proxy also issues a CSP on every response it relays (`buildProxiedDocumentCsp`), replacing the Grafana CSP it has to strip in order to be framed at all.

  The proxied-document policy cannot meaningfully restrict script execution — Grafana boots from an inline script, the proxy injects another for `appSubUrl`, and plugins `eval`, so `script-src` keeps `'unsafe-inline'`/`'unsafe-eval'` exactly as Grafana's own default template does. What it does buy is egress and navigation: `connect-src 'self'` prevents an injected script from beaconing data to an attacker origin, `form-action 'self'` prevents POSTing the page away, and `object-src 'none'` / `base-uri 'self'` close two rewrite tricks. `img-src`/`font-src` keep `data:` or Grafana's icons break; `frame-ancestors` admits `vscode-webview:` in place of the stripped `x-frame-options`.

  This matters concretely rather than theoretically: Grafana's Text panel supports raw HTML, so an imported third-party dashboard JSON is a realistic delivery vehicle. Between the introduction of the header stripping and 2026-08-13 the framed document ran with no CSP at all.

## Consequences

- Works against any Grafana version/deployment without requiring the Grafana admin to change any server-side configuration (no Public Dashboards, no Anonymous Auth).
- The Service Account Token never reaches the Webview's renderer process or network layer — it stays entirely inside the extension host, consistent with the series-wide invariant that "tools never return credentials" (Hub Protocol v1 §14) extended to the UI layer as well.
- Adds real implementation complexity: HTML/JS response rewriting for absolute URLs, WebSocket proxying for Grafana Live features, and correct CSP configuration. This complexity is scoped to a single `GrafanaEmbedProxy` component so it doesn't leak into the tree/config/Bridge code.
- The proxy route for a given instance should only be considered "live" while at least one Webview panel for that instance is open; it does not need to be reachable when no panel is open, and is a distinct code path from the MCP Bridge's `/invoke` tool execution (the proxy serves HTML/assets; the Bridge serves JSON tool results).
