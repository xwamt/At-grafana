# AT Grafana 0.2.x 可执行计划 · Part C（Tasks 13–18）

> 执行前先读 [索引](./2026-08-27-agent-implementation-plan.md)。本文件由 claude-fable-5-thinking-xhigh 子代理起草，父代理仅做交叉引用修正。
> 分支：`cursor/implement-optimizations-ef26`（或其后继）。禁止 `master`。
>
> **Parent corrections (must follow):**
> 1. ADR-010 path is `docs/decisions/ADR-010-zero-telemetry.md` (never `docs/adr/`).
> 2. If Task 9 (Part B) already added `deps.strings` / `GrafanaEmbedProxyStrings` for the 401 page, **merge** those fields into `GrafanaEmbedProxyCopy` in this Task 13 — do not create a second injection bag. If T9 has not landed, T13 still creates `GrafanaEmbedProxyCopy`; T9 then adds the 401 keys to it.
> 3. `engines.vscode` is currently `^1.85.0` (not 1.90). Task 17 must not raise it without a human.
> 4. T16 requires T8 (`openAlertRuleInIde`) AND T13. Stop if either is missing.
> 5. T14 then T17 both edit `.github/workflows/ci.yml` — serial.

**For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining quality/UX/platform gaps from the follow-up roadmap: localize the embed shell and proxy error pages (Task 13 = NEXT-Q-13 + NEXT-U-10), make CI produce and verify a VSIX (Task 14 = NEXT-Q-01), write the zero-telemetry contract down as ADR-010 (Task 15), open Grafana Explore inside the IDE embed webview (Task 16 = NEXT-P-07 / NEXT-U-12②, revises ADR-007), align the Node runtime matrix (Task 17 = NEXT-Q-14), and lock the webview nonce/CSP invariants with tests (Task 18).

**Tech stack:** TypeScript, Vitest (NOT Mocha — `npm test` runs `vitest run`; test files live under `test/`, not `src/test/`), esbuild, `vscode.l10n` via `src/i18n/t.ts`, GitHub Actions.

**Standing rules (every task):**

- Never commit to `master`. Stay on `cursor/implement-optimizations-ef26` (or its successor).
- Do not re-do Wave 0–3 work; do not re-implement anything listed in `docs/plans/2026-08-27-followup-completeness-roadmap.md` §「已完成」.
- Every user-visible string in `src/` goes through `t('...')` (single-quoted literal — `test/i18n/nls.test.ts` scans for exactly that shape) with a matching entry in `l10n/bundle.l10n.zh-cn.json`. `package.json` titles use `%atGrafana.*%` placeholders resolved in `package.nls.json` + `package.nls.zh-cn.json`. After touching any nls/l10n file run `npx vitest run test/i18n/nls.test.ts`.
- `src/webview/GrafanaEmbedProxy.ts` must never import `vscode` (it runs plain `node:http` and is unit-tested without a host). Copy is injected from `src/extension.ts`.
- After each task: `npm run typecheck && npm test`, then commit.
- ADR numbers are reserved: **ADR-008** = silence tooling (Part D Task 24), **ADR-009** = query-limit setting (Part A Task 5), **ADR-010** = zero telemetry (**this** Part, Task 15). Do not take a reserved number for anything else.

**Sequencing:**

- Task 13 first — Task 16 and Task 18 both build on its `html.ts` / proxy edits.
- Task 14 before Task 17 (both edit `.github/workflows/ci.yml`; serial per parent correction 5).
- Task 15 is independent; it may run at any point.
- Task 16 only after Part B Task 8 (`openAlertRuleInIde`) **and** Task 13 have landed — Step 0 of Task 16 gates on this.
- Task 18 last among the `html.ts`-adjacent tasks (it edits `test/webview/html.test.ts`, which Task 13 also edits).

Recommended order: **13 → 14 → 15 → 16 → 17 → 18**.

**Out of scope for Part C:** publishing to any marketplace (`vsce publish` is forbidden), changing `publisher` away from `local`, raising `engines.vscode`, WebSocket (Grafana Live) proxying, ADR-008/ADR-009 content, and anything Wave 0–3 already shipped.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/webview/html.ts` | 13 | Three-sentence `t()` loader copy, `prefers-reduced-motion`, translated error/retry copy |
| `src/webview/GrafanaEmbedProxy.ts` | 13, 16 | `GrafanaEmbedProxyCopy` + `formatEmbedCopy` + `copy` dep; `buildExploreUrl` |
| `src/extension.ts` | 13, 16 | Inject translated proxy copy; `openExploreInIde` opener + `atGrafana.openExplore` command |
| `l10n/bundle.l10n.zh-cn.json` | 13, 16 | zh-cn entries for every new `t()` key |
| `test/webview/html.test.ts` | 13, 18 | Loader/reduced-motion assertions; nonce/CSP invariants |
| `test/webview/GrafanaEmbedProxy.test.ts` | 13, 16 | Injected-copy error page; `buildExploreUrl` |
| `.github/workflows/ci.yml` | 14, 17 | Package + assert + upload VSIX; runtime-matrix comment |
| `scripts/package.mjs` | 14 | Pin `@vscode/vsce` major |
| `docs/decisions/ADR-010-zero-telemetry.md` | 15 | **Create** — zero-telemetry contract |
| `README.md`, `docs/README.zh-CN.md` | 15, 16, 17 | Telemetry bullet/link; deeplink copy; runtime-matrix note |
| `src/grafana/grafanaDeeplink.ts` | 16 | Extract `buildExploreLeftSearch` |
| `src/webview/ExplorePanel.ts` | 16 | **Create** — Explore embed panel |
| `src/agent/GrafanaAgentToolService.ts` | 16 | `openExploreInIde?` dep + explore `openInIde` dispatch |
| `src/mcp/bridgeSchemas.ts`, `src/mcp/toolCatalog.ts` | 16 | Explore variant gains `openInIde`/`title`; catalog copy |
| `docs/decisions/ADR-007-discovery-annotations-deeplink.md` | 16 | Amendment: Explore CAN open in IDE |
| `package.json`, `package.nls.json`, `package.nls.zh-cn.json` | 16, 17 | `atGrafana.openExplore` command; `@types/node@^18` |
| `test/config/engineMatrix.test.ts` | 17 | **Create** — runtime-matrix regression tests |
| `test/utils/nonce.test.ts` | 18 | **Create** — nonce shape/uniqueness tests |

Do **not** change: `respondNotFound` in `GrafanaEmbedProxy.ts` (the admission-gate 404 is deliberately a bare, untranslated, product-name-free `Not Found` — translating it would fingerprint the proxy for port scanners), `buildProxiedDocumentCsp`, `buildRecommendedCsp` semantics, or `DATASOURCE_PROXY_PATH_DENY_PATTERN`.

---

### Task 13: Embed loader/error shell i18n inject（NEXT-Q-13 / NEXT-U-10）

The embed shell (`renderEmbedWebviewHtml` in `src/webview/html.ts`) and the proxy's error pages (`respondError` / `respondServiceUnavailable` in `src/webview/GrafanaEmbedProxy.ts`) are the last user-facing surfaces with hardcoded English. The shell can call `t()` directly (`html.ts` already imports `vscode`). The proxy cannot — so `extension.ts` translates once at construction with literal `t('...')` calls (which `test/i18n/nls.test.ts`'s scanner sees and therefore enforces zh-cn coverage for) and injects the result as a plain-string bag. Also: the loader grows to three sentences (NEXT-U-10) and the spinner respects `prefers-reduced-motion`.

**Files:**
- Modify: `src/webview/html.ts`
- Modify: `src/webview/GrafanaEmbedProxy.ts`
- Modify: `src/extension.ts`
- Modify: `l10n/bundle.l10n.zh-cn.json`
- Test: `test/webview/html.test.ts`, `test/webview/GrafanaEmbedProxy.test.ts`

- [ ] **Step 0: Check whether Part B Task 9 already landed a strings bag**

```bash
rg -n "GrafanaEmbedProxyStrings|deps\.strings" src/webview/GrafanaEmbedProxy.ts src/extension.ts
```

- **If it hits** (T9's 401 page landed first): do NOT add a second injection bag. Rename/extend that existing interface to `GrafanaEmbedProxyCopy` as specified below, folding the 401-page keys into it as additional fields, and keep T9's call sites working.
- **If it does not hit**: create `GrafanaEmbedProxyCopy` fresh as below. (T9, when it later lands, adds its 401 keys to this bag.)

- [ ] **Step 1: Three-sentence loader + reduced motion in `src/webview/html.ts`**

Add the import at the top (after the existing imports):

```ts
import { t } from '../i18n/t';
```

In `renderEmbedWebviewHtml`, immediately after `const nonce = createNonce();`, add:

```ts
  // NEXT-U-10 three-sentence loader: what is happening, why it can take a
  // moment, and where the credential lives. Translated here in the extension
  // host — a Webview cannot reach vscode.l10n (see src/i18n/t.ts) — and
  // escaped because a translation is data, not trusted markup.
  const loadingLine1 = escapeHtml(t('Loading Grafana…'));
  const loadingLine2 = escapeHtml(t('The first load can take a few seconds while dashboard assets download through the local proxy.'));
  const loadingLine3 = escapeHtml(t('Your Grafana token stays in the extension host; this page never sees it.'));
  const errorLine = escapeHtml(t('Grafana did not load in this panel. Check that the instance is reachable, then retry.'));
  const retryLabel = escapeHtml(t('Retry'));
```

Find this exact block in the returned template (currently hardcoded English):

```html
  <div id="embed-loading" class="embed-status" role="status">
    <div class="embed-spinner" aria-hidden="true"></div>
    <p>Loading Grafana…</p>
  </div>
  <div id="embed-error" class="embed-status" role="alert" hidden>
    <p>Grafana did not load in this panel. Check that the instance is reachable, then retry.</p>
    <button id="embed-retry" type="button">Retry</button>
  </div>
```

Replace with:

```html
  <div id="embed-loading" class="embed-status" role="status">
    <div class="embed-spinner" aria-hidden="true"></div>
    <p>${loadingLine1}</p>
    <p class="embed-hint">${loadingLine2}</p>
    <p class="embed-hint">${loadingLine3}</p>
  </div>
  <div id="embed-error" class="embed-status" role="alert" hidden>
    <p>${errorLine}</p>
    <button id="embed-retry" type="button">${retryLabel}</button>
  </div>
```

In the `<style>` block, after the existing line

```css
    @keyframes embed-spin { to { transform: rotate(360deg); } }
```

add:

```css
    .embed-hint { margin: 0; font-size: 0.85em; opacity: 0.8; max-width: 34rem; }
    @media (prefers-reduced-motion: reduce) { .embed-spinner { animation: none; } }
```

Do not touch the CSP `<meta>` line, the nonce handling, or the iframe wiring script. (The Vitest `vscode` fixture's `l10n.t` — `test-fixtures/vscode.ts` — returns the message with placeholder substitution, so existing `html.test.ts` assertions like `toContain('Loading Grafana')` keep passing.)

- [ ] **Step 2: `GrafanaEmbedProxyCopy` + `formatEmbedCopy` in `src/webview/GrafanaEmbedProxy.ts`**

Add above `GrafanaEmbedProxyDependencies` (this module still must not import `vscode`):

```ts
/**
 * User-facing copy for the pages this proxy renders inside the embed iframe
 * (NEXT-Q-13). This module never imports `vscode`, so it cannot call `t()`
 * itself — src/extension.ts translates these once at construction (with
 * literal t('...') calls that test/i18n/nls.test.ts's scanner enforces
 * zh-cn coverage for) and injects the result. Placeholders such as
 * `{status}` / `{message}` / `{instanceId}` are substituted at respond time
 * by `formatEmbedCopy`, mirroring vscode.l10n's semantics.
 */
export interface GrafanaEmbedProxyCopy {
  /** BCP-47 tag for the error page's `<html lang>`. */
  lang: string;
  /** `<title>` of the error page. */
  errorPageTitle: string;
  /** `<h1>`; `{status}` is the HTTP status code. */
  errorHeading: string;
  /** Text of the reload link on the error page. */
  retryLabel: string;
  /** 503 load-shedding body (plain text). */
  busy: string;
  unknownRoute: string;
  /** `{instanceId}` */
  unknownInstance: string;
  noToken: string;
  invalidInstanceUrl: string;
  untrustedTls: string;
  unsupportedScheme: string;
  invalidPath: string;
  upstreamTimeout: string;
  /** `{message}` */
  upstreamUnreachable: string;
  /** `{message}` */
  tlsVerificationFailed: string;
  responseTooLarge: string;
  upstreamStreamError: string;
  /** `{message}` */
  internalError: string;
}

/**
 * English fallback, character-identical to the strings this file hardcoded
 * before NEXT-Q-13, used when extension.ts injects nothing (unit tests,
 * defensive boot order). Deliberately NOT built with t(): this module cannot
 * import vscode.
 */
export const DEFAULT_EMBED_PROXY_COPY: GrafanaEmbedProxyCopy = {
  lang: 'en',
  errorPageTitle: 'AT Grafana Proxy',
  errorHeading: 'AT Grafana proxy error ({status})',
  retryLabel: 'Retry',
  busy: 'AT Grafana proxy is busy; retry shortly.',
  unknownRoute: 'Unknown AT Grafana proxy route.',
  unknownInstance: 'Unknown Grafana instance: {instanceId}.',
  noToken: 'No Service Account Token is configured for this Grafana instance.',
  invalidInstanceUrl: 'This Grafana instance has an invalid configured URL.',
  untrustedTls:
    "This Grafana instance's TLS certificate is not trusted. Confirm the certificate fingerprint " +
    '(Trust-On-First-Use) before opening this view.',
  unsupportedScheme: 'This Grafana instance has an unsupported URL scheme.',
  invalidPath: 'Invalid proxy request path.',
  upstreamTimeout: 'The Grafana instance did not respond in time.',
  upstreamUnreachable: 'Failed to reach the Grafana instance: {message}',
  tlsVerificationFailed: 'Grafana TLS certificate verification failed: {message}',
  responseTooLarge: 'Grafana response was too large to rewrite.',
  upstreamStreamError: 'Grafana upstream response error.',
  internalError: 'AT Grafana proxy error: {message}'
};

/** `vscode.l10n`-style placeholder substitution without vscode: unknown placeholders stay literal. */
export function formatEmbedCopy(template: string, args: Record<string, string | number> = {}): string {
  return template.replace(/{([^}]+)}/g, (match, key: string) => (key in args ? String(args[key]) : match));
}
```

Add to `GrafanaEmbedProxyDependencies` (after `limits?`):

```ts
  /**
   * Translated copy for error/busy pages (NEXT-Q-13). Injected by
   * src/extension.ts; anything omitted falls back to the English
   * DEFAULT_EMBED_PROXY_COPY so tests and partial injections stay valid.
   */
  copy?: Partial<GrafanaEmbedProxyCopy>;
```

Add a class field and initialize it in the constructor (next to `this.limits`):

```ts
  private readonly copy: GrafanaEmbedProxyCopy;
```

```ts
    this.copy = { ...DEFAULT_EMBED_PROXY_COPY, ...deps.copy };
```

- [ ] **Step 3: Route every error response through the copy bag**

Add two private methods to the class (near `acquireRequestSlot`):

```ts
  private respondError(response: http.ServerResponse, status: number, message: string): void {
    respondErrorPage(response, status, message, this.copy);
  }

  private respondServiceUnavailable(response: http.ServerResponse): void {
    respondServiceUnavailablePage(response, this.copy);
  }
```

Then replace every call site inside the class. Exact substitutions (old → new):

| Location | Old call | New call |
|---|---|---|
| `handleRequest`, no route matched | `respondError(response, 404, 'Unknown AT Grafana proxy route.');` | `this.respondError(response, 404, this.copy.unknownRoute);` |
| `handleRequest`, unknown instance | ``respondError(response, 404, `Unknown Grafana instance: ${parsedPath.instanceId}.`);`` | `this.respondError(response, 404, formatEmbedCopy(this.copy.unknownInstance, { instanceId: parsedPath.instanceId }));` |
| `handleRequest`, no token | `respondError(response, 502, 'No Service Account Token is configured for this Grafana instance.');` | `this.respondError(response, 502, this.copy.noToken);` |
| `handleRequest`, unparseable URL | `respondError(response, 502, 'This Grafana instance has an invalid configured URL.');` | `this.respondError(response, 502, this.copy.invalidInstanceUrl);` |
| `handleRequest`, untrusted TLS | `respondError(response, 502, "This Grafana instance's TLS certificate is not trusted. Confirm the certificate fingerprint " + '(Trust-On-First-Use) before opening this view.');` | `this.respondError(response, 502, this.copy.untrustedTls);` |
| `handleRequest`, bad scheme | `respondError(response, 502, 'This Grafana instance has an unsupported URL scheme.');` | `this.respondError(response, 502, this.copy.unsupportedScheme);` |
| `handleRequest`, escaped path | `respondError(response, 400, 'Invalid proxy request path.');` | `this.respondError(response, 400, this.copy.invalidPath);` |
| `handleRequest`, load shed | `respondServiceUnavailable(response);` | `this.respondServiceUnavailable(response);` |
| `handleRequest`, catch-all | ``respondError(response, 502, `AT Grafana proxy error: ${formatError(error)}`);`` | `this.respondError(response, 502, formatEmbedCopy(this.copy.internalError, { message: formatError(error) }));` |
| `forward`, upstream timeout | `respondError(clientResponse, 504, 'The Grafana instance did not respond in time.');` | `this.respondError(clientResponse, 504, this.copy.upstreamTimeout);` |
| `forward`, upstream error | ``respondError(clientResponse, 502, `Failed to reach the Grafana instance: ${formatError(error)}`);`` | `this.respondError(clientResponse, 502, formatEmbedCopy(this.copy.upstreamUnreachable, { message: formatError(error) }));` |
| `forward`, TLS rejected | ``respondError(clientResponse, 502, `Grafana TLS certificate verification failed: ${redactSensitiveText(error.message)}`);`` | `this.respondError(clientResponse, 502, formatEmbedCopy(this.copy.tlsVerificationFailed, { message: redactSensitiveText(error.message) }));` |
| `relayRewritableBody`, oversize | `respondError(clientResponse, 502, 'Grafana response was too large to rewrite.');` | `this.respondError(clientResponse, 502, this.copy.responseTooLarge);` |
| `relayRewritableBody`, stream error (×2 — `bodySource.on('error')` and `proxyResponse.on('error')`) | `respondError(clientResponse, 502, 'Grafana upstream response error.');` | `this.respondError(clientResponse, 502, this.copy.upstreamStreamError);` |

`respondNotFound` call sites stay exactly as they are (see the "Do not change" list above).

Rewrite the two module-level responders. Replace `respondServiceUnavailable` with:

```ts
/**
 * Load shedding, not an error: the caller already passed the admission gate,
 * so this says "come back in a moment" with a `Retry-After` the Webview and
 * Grafana's own fetch retries can act on, rather than surfacing as a failure
 * the user has to reason about.
 */
function respondServiceUnavailablePage(response: http.ServerResponse, copy: GrafanaEmbedProxyCopy): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = Buffer.from(copy.busy, 'utf8');
  response.writeHead(503, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.length.toString(),
    'retry-after': '1'
  });
  response.end(body);
}
```

Replace `respondError` (and delete its now-stale doc paragraph claiming "the copy stays English by accepted limitation (UX-12)") with:

```ts
/**
 * Error pages render *inside* the embed iframe, where this module (which
 * never imports `vscode`) cannot reach `t()` — so the copy arrives
 * pre-translated via GrafanaEmbedProxyCopy (NEXT-Q-13). The page looks
 * intentional: system font, light/dark via `prefers-color-scheme`, and a
 * Retry link that reloads the iframe document so a transient failure
 * (Grafana restarting, proxy shedding load) has a one-click recovery.
 */
function respondErrorPage(
  response: http.ServerResponse,
  status: number,
  message: string,
  copy: GrafanaEmbedProxyCopy
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const safeMessage = escapeHtml(redactSensitiveText(message));
  const heading = escapeHtml(formatEmbedCopy(copy.errorHeading, { status }));
  const body = Buffer.from(
    `<!DOCTYPE html><html lang="${escapeHtml(copy.lang)}"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1.0">` +
      `<title>${escapeHtml(copy.errorPageTitle)}</title>` +
      `<style>` +
      `:root{color-scheme:light dark}` +
      `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
      `font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3f3f3;color:#1f1f1f}` +
      `main{max-width:36rem;padding:2rem;text-align:center}` +
      `h1{font-size:1.05rem;font-weight:600}` +
      `p{line-height:1.5;overflow-wrap:anywhere}` +
      `a{color:#005fb8}` +
      `@media (prefers-color-scheme:dark){body{background:#1f1f1f;color:#cccccc}a{color:#4daafc}}` +
      `</style></head>` +
      `<body><main><h1>${heading}</h1><p>${safeMessage}</p>` +
      `<p><a href="javascript:location.reload()">${escapeHtml(copy.retryLabel)}</a></p></main></body></html>`,
    'utf8'
  );
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length.toString()
  });
  response.end(body);
}
```

- [ ] **Step 4: Inject the translated bag from `src/extension.ts`**

Find the proxy construction in `activate`:

```ts
  const grafanaEmbedProxy = new GrafanaEmbedProxy({ configManager, certTrustStore, log });
```

Replace with (every key a **single-quoted** literal so the nls scanner matches — note the escaped apostrophe in the TLS string):

```ts
  const grafanaEmbedProxy = new GrafanaEmbedProxy({
    configManager,
    certTrustStore,
    log,
    // NEXT-Q-13: the proxy cannot import vscode, so its iframe error pages
    // get their copy translated here, once, at construction. Placeholders
    // ({status}/{message}/{instanceId}) survive t() untouched (no args) and
    // are filled by the proxy's formatEmbedCopy at respond time.
    copy: {
      lang: vscode.env.language,
      errorPageTitle: t('AT Grafana Proxy'),
      errorHeading: t('AT Grafana proxy error ({status})'),
      retryLabel: t('Retry'),
      busy: t('AT Grafana proxy is busy; retry shortly.'),
      unknownRoute: t('Unknown AT Grafana proxy route.'),
      unknownInstance: t('Unknown Grafana instance: {instanceId}.'),
      noToken: t('No Service Account Token is configured for this Grafana instance.'),
      invalidInstanceUrl: t('This Grafana instance has an invalid configured URL.'),
      untrustedTls: t(
        'This Grafana instance\'s TLS certificate is not trusted. Confirm the certificate fingerprint (Trust-On-First-Use) before opening this view.'
      ),
      unsupportedScheme: t('This Grafana instance has an unsupported URL scheme.'),
      invalidPath: t('Invalid proxy request path.'),
      upstreamTimeout: t('The Grafana instance did not respond in time.'),
      upstreamUnreachable: t('Failed to reach the Grafana instance: {message}'),
      tlsVerificationFailed: t('Grafana TLS certificate verification failed: {message}'),
      responseTooLarge: t('Grafana response was too large to rewrite.'),
      upstreamStreamError: t('Grafana upstream response error.'),
      internalError: t('AT Grafana proxy error: {message}')
    }
  });
```

Caution: `t('AT Grafana proxy error ({status})')` etc. are called **without args** on purpose — `vscode.l10n.t` leaves `{status}` literal when no args are passed, and the proxy substitutes later. Do not "fix" this by passing args here.

- [ ] **Step 5: zh-cn bundle entries**

Add to `l10n/bundle.l10n.zh-cn.json` (before the closing `}`; keep valid JSON, mind commas). `"Retry"` and the five shell keys serve Step 1; the rest serve Step 4:

```json
  "Loading Grafana…": "正在加载 Grafana…",
  "The first load can take a few seconds while dashboard assets download through the local proxy.": "首次加载需要通过本地代理下载仪表盘资源，可能需要几秒钟。",
  "Your Grafana token stays in the extension host; this page never sees it.": "您的 Grafana Token 始终保存在扩展进程中；此页面永远不会接触到它。",
  "Grafana did not load in this panel. Check that the instance is reachable, then retry.": "Grafana 未能在此面板中加载。请确认实例可以访问，然后重试。",
  "Retry": "重试",
  "AT Grafana Proxy": "AT Grafana 代理",
  "AT Grafana proxy error ({status})": "AT Grafana 代理错误（{status}）",
  "AT Grafana proxy is busy; retry shortly.": "AT Grafana 代理繁忙；请稍后重试。",
  "Unknown AT Grafana proxy route.": "未知的 AT Grafana 代理路由。",
  "Unknown Grafana instance: {instanceId}.": "未知的 Grafana 实例：{instanceId}。",
  "No Service Account Token is configured for this Grafana instance.": "未为此 Grafana 实例配置 Service Account Token。",
  "This Grafana instance has an invalid configured URL.": "此 Grafana 实例配置的地址无效。",
  "This Grafana instance's TLS certificate is not trusted. Confirm the certificate fingerprint (Trust-On-First-Use) before opening this view.": "此 Grafana 实例的 TLS 证书尚未被信任。请先确认证书指纹（Trust-On-First-Use，首次使用信任）再打开此视图。",
  "This Grafana instance has an unsupported URL scheme.": "此 Grafana 实例使用了不受支持的 URL 协议。",
  "Invalid proxy request path.": "无效的代理请求路径。",
  "The Grafana instance did not respond in time.": "Grafana 实例未在限定时间内响应。",
  "Failed to reach the Grafana instance: {message}": "无法连接到 Grafana 实例：{message}",
  "Grafana TLS certificate verification failed: {message}": "Grafana TLS 证书校验失败：{message}",
  "Grafana response was too large to rewrite.": "Grafana 响应过大，无法重写。",
  "Grafana upstream response error.": "Grafana 上游响应错误。",
  "AT Grafana proxy error: {message}": "AT Grafana 代理错误：{message}"
```

- [ ] **Step 6: Tests**

In `test/webview/html.test.ts`, inside `describe('renderEmbedWebviewHtml', ...)`, add:

```ts
  it('renders a three-sentence loader and stills the spinner under prefers-reduced-motion (NEXT-U-10)', () => {
    const html = renderEmbedWebviewHtml(options);

    expect(html).toContain('Loading Grafana…');
    expect(html).toContain('dashboard assets download through the local proxy');
    expect(html).toContain('this page never sees it');
    expect(html).toContain('@media (prefers-reduced-motion: reduce) { .embed-spinner { animation: none; } }');
  });
```

In `test/webview/GrafanaEmbedProxy.test.ts`, extend the import from `'../../src/webview/GrafanaEmbedProxy'` with `DEFAULT_EMBED_PROXY_COPY` and `formatEmbedCopy`, then add (uses the file's existing helpers `createProxy` / `requestProxy` / `proxyPort` / `embedPath` / `FakeConfigManager` — see its top ~200 lines):

```ts
describe('formatEmbedCopy', () => {
  it('substitutes named placeholders and leaves unknown ones literal, mirroring vscode.l10n', () => {
    expect(formatEmbedCopy('error ({status})', { status: 502 })).toBe('error (502)');
    expect(formatEmbedCopy('keep {unknown}')).toBe('keep {unknown}');
  });
});

describe('GrafanaEmbedProxy injected copy (NEXT-Q-13)', () => {
  it('renders injected translations on the error page, falling back per-field to English', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({
      configManager,
      copy: {
        lang: 'zh-cn',
        errorHeading: 'AT Grafana 代理错误（{status}）',
        unknownRoute: '未知的 AT Grafana 代理路由。',
        retryLabel: '重试'
      }
    });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, '/no-such-route'));

    expect(result.status).toBe(404);
    expect(result.body).toContain('<html lang="zh-cn">');
    expect(result.body).toContain('AT Grafana 代理错误（404）');
    expect(result.body).toContain('未知的 AT Grafana 代理路由。');
    expect(result.body).toContain('重试');
    // Fields NOT injected keep the English default (per-field merge).
    expect(result.body).toContain(`<title>${DEFAULT_EMBED_PROXY_COPY.errorPageTitle}</title>`);
  });

  it('serves the unchanged English defaults when no copy is injected', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const result = await requestProxy(proxyPort(embedProxy), embedPath(embedProxy, '/no-such-route'));

    expect(result.status).toBe(404);
    expect(result.body).toContain('AT Grafana proxy error (404)');
    expect(result.body).toContain('Unknown AT Grafana proxy route.');
  });
});
```

(`/no-such-route` presents a valid embed token via `embedPath` so it passes admission, then fails `parseProxyRoute` — exactly the `unknownRoute` path.)

- [ ] **Step 7: Verify**

```bash
npm run typecheck && npm test
npx vitest run test/i18n/nls.test.ts
rg -n "import \* as vscode|from 'vscode'" src/webview/GrafanaEmbedProxy.ts   # MUST print nothing
```

- [ ] **Step 8: Commit**

```bash
git add src/webview/html.ts src/webview/GrafanaEmbedProxy.ts src/extension.ts \
  l10n/bundle.l10n.zh-cn.json test/webview/html.test.ts test/webview/GrafanaEmbedProxy.test.ts
git commit -m "$(cat <<'EOF'
feat: localize the embed loader and proxy error pages (NEXT-Q-13/U-10)

extension.ts translates the copy with t() and injects it; the proxy stays
vscode-free. Loader grows to three sentences and the spinner respects
prefers-reduced-motion.
EOF
)"
```

---

### Task 14: CI `npm run package` + VSIX artifact + content assertions（NEXT-Q-01）

`.github/workflows/ci.yml` currently stops at typecheck/test/audit — nothing proves the VSIX still assembles or that it carries `hub.js`, the l10n bundles, and no sourcemaps. Add packaging, `unzip -l` assertions, and an artifact upload. **Do NOT run `vsce publish`. Do NOT change `publisher` (stays `local`) in this task.**

**Files:**
- Modify: `scripts/package.mjs`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Pin `@vscode/vsce` to its current major in `scripts/package.mjs`**

`npx @vscode/vsce` resolves *latest* on every CI run — a vsce major release could silently change CLI flags and break the pipeline. In the `spawnSync` call, change the package spec in **both** platform branches:

- In the win32 args array: `'@vscode/vsce',` → `'@vscode/vsce@3',`
- In the posix args array: `['@vscode/vsce', 'package', ...` → `['@vscode/vsce@3', 'package', ...`

Leave every flag (`--allow-missing-repository --no-rewrite-relative-links --no-dependencies`) untouched.

- [ ] **Step 2: Append packaging steps to `.github/workflows/ci.yml`**

After the final existing step (`Audit production dependencies`), append (same indentation as the other steps; the job's `working-directory` pattern is per-step, keep it):

```yaml
      # NEXT-Q-01: prove the VSIX still assembles and ships what it must.
      # Packaging only — this workflow never publishes (no `vsce publish`).
      - name: Package VSIX
        working-directory: at-grafana-series
        run: npm run package

      - name: Assert VSIX contents
        working-directory: at-grafana-series
        run: |
          set -euo pipefail
          VSIX=$(ls at-grafana-*.vsix)
          echo "Inspecting $VSIX"
          unzip -l "$VSIX" > vsix-contents.txt
          cat vsix-contents.txt
          # Must ship: bundled extension, packaged hub + version stamp,
          # runtime l10n bundle, manifest nls (both languages), entry logos.
          grep -q 'extension/dist/extension.js' vsix-contents.txt
          grep -q 'extension/dist/hub.js' vsix-contents.txt
          grep -q 'extension/dist/hub-version.json' vsix-contents.txt
          grep -q 'extension/l10n/bundle.l10n.zh-cn.json' vsix-contents.txt
          grep -q 'extension/package.nls.json' vsix-contents.txt
          grep -q 'extension/package.nls.zh-cn.json' vsix-contents.txt
          grep -q 'extension/media/at-grafana-icon.png' vsix-contents.txt
          grep -q 'extension/media/at-grafana-activity.svg' vsix-contents.txt
          # Must NOT ship: sourcemaps (.vscodeignore strips **/*.map; a map
          # appearing here means the ignore file or esbuild config regressed).
          if grep -E '\.map$' vsix-contents.txt; then
            echo 'FAIL: VSIX contains sourcemaps' >&2
            exit 1
          fi

      - name: Upload VSIX artifact
        uses: actions/upload-artifact@v4
        with:
          name: at-grafana-vsix
          path: at-grafana-series/at-grafana-*.vsix
          if-no-files-found: error
```

Notes for the implementing agent:

- Files inside a VSIX live under the `extension/` prefix — that is why every `grep` starts with `extension/`.
- `npm run package` = `npm run build && npm run copy:hub && node scripts/package.mjs`. `copy:hub` resolves `@at-series/mcp-hub/hub` via `require.resolve` (`scripts/copy-hub.mjs`), which works whether the dependency came from the npm registry (`npm ci`, per `package-lock.json`) or from the sibling checkout the workflow also builds. Do not touch the existing hub build steps.
- The VSIX filename is `at-grafana-<version>.vsix` at the plugin repo root (`scripts/package.mjs` copies it there from `.package-work/vsix/`).

- [ ] **Step 3: Verify locally (requires network for `npx @vscode/vsce@3`)**

```bash
npm run package
unzip -l at-grafana-*.vsix | grep -E 'hub\.js|bundle\.l10n|\.map$' || true
rm -f at-grafana-*.vsix
npm run typecheck && npm test
```

Expected: `hub.js` and `bundle.l10n.zh-cn.json` listed; no `.map` lines. (If the sandbox has no network, state that in the task report and rely on CI for the end-to-end check — the YAML is still verifiable by `npx --yes yaml-lint` or careful review.)

- [ ] **Step 4: Commit**

```bash
git add scripts/package.mjs .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
ci: package the VSIX, assert its contents, and upload it as an artifact

Pins npx @vscode/vsce to major 3. Asserts hub.js, l10n bundles, nls files,
and entry logos ship, and that no sourcemaps do. Never publishes.
EOF
)"
```

---

### Task 15: ADR-010 — zero telemetry

Write the (already-true) zero-telemetry posture down as a contract. Path is **`docs/decisions/ADR-010-zero-telemetry.md`** — never `docs/adr/` (parent correction 1). Number 010 is reserved for exactly this (008 = silence, 009 = query-limit; do not steal).

**Files:**
- Create: `docs/decisions/ADR-010-zero-telemetry.md`
- Modify: `README.md`
- Modify: `docs/README.zh-CN.md`

- [ ] **Step 1: Create the ADR**

Create `docs/decisions/ADR-010-zero-telemetry.md` with exactly this structure (Status/Date/Context/Decision/Consequences — the house style of ADR-001…007):

```markdown
# ADR-010: Zero telemetry

## Status
Accepted

## Date
2026-08-27

## Context

AT Grafana handles operator credentials (Grafana Service Account Tokens in VS Code `SecretStorage`) and proxies live Grafana traffic through a loopback reverse proxy (ADR-003). Users evaluating an observability extension reasonably ask what the extension itself observes about *them*.

Nothing in the codebase collects telemetry today: there is no analytics dependency, no crash reporter, and the only outbound HTTP is to the Grafana instances the operator configured. But that is currently an accident of the code, not a commitment — nothing stops a future change from adding a "harmless" usage ping.

## Decision

1. AT Grafana collects **no usage telemetry** (no feature counters, no command events), **no crash/error telemetry**, and **no identity telemetry** (no machine id — `vscode.env.machineId` is never read — and no account information).
2. The extension performs network I/O only toward (a) the Grafana instances the operator explicitly configured (tree reads, the embed proxy, MCP tool calls) and (b) `127.0.0.1` for its own Bridge/embed-proxy servers. **Grafana HTTP traffic stays on the operator's instance.** (Build-time `npx`/`npm` traffic in CI is tooling, not the shipped extension.)
3. `vscode.env.isTelemetryEnabled` / `onDidChangeTelemetryEnabled` are irrelevant to this extension and must not be wired up "for later".
4. Any future change that adds an outbound endpoint beyond the configured Grafana instances requires: a superseding ADR, a README disclosure (EN + 中文), and an explicit opt-in setting that defaults to off.

## Consequences

- README (EN/中文) states the promise and links here; users can cite it in reviews and security audits.
- Debugging relies entirely on the local `AT Grafana` output channel (`createRedactedLog`); there is no remote error visibility. Accepted cost.
- Dependency review must reject transitive analytics SDKs. `npm audit` in CI does not catch this class, so it stays a PR-review responsibility.
```

- [ ] **Step 2: README bullet — conditional on Part A Task 1**

Check first:

```bash
rg -in "telemetry|遥测" README.md docs/README.zh-CN.md
```

- **If Task 1 already added a telemetry bullet/paragraph** (it drafted one pointing at the wrong `docs/adr/010-zero-telemetry.md` path): do **not** add a second one. Only fix its link to `docs/decisions/ADR-010-zero-telemetry.md` (relative from `docs/README.zh-CN.md`: `decisions/ADR-010-zero-telemetry.md`) and drop any "until then this paragraph is the contract" hedging — the ADR now exists.
- **If there is no telemetry mention** (current state of this branch): in `README.md`'s `## Features` list, insert after the `**Per-instance Agent gate**` bullet:

```markdown
- **Zero telemetry** — no usage, crash, or identity telemetry; the extension's only network traffic is to your configured Grafana instances (see [ADR-010](docs/decisions/ADR-010-zero-telemetry.md))
```

And the mirrored bullet in `docs/README.zh-CN.md`'s 功能 list (same position):

```markdown
- **零遥测** — 不收集使用量、崩溃或身份遥测；扩展唯一的网络流量是访问您配置的 Grafana 实例（见 [ADR-010](decisions/ADR-010-zero-telemetry.md)）
```

- [ ] **Step 3: Documentation tables**

In `README.md`'s Documentation table the ADR row currently reads:

```markdown
| [`docs/decisions/`](docs/decisions) | ADR-001 … ADR-007 |
```

Update the range to the highest ADR that exists on the branch after this task (e.g. `ADR-001 … ADR-010`; if Tasks 5/24 landed ADR-008/009 first, the range is already contiguous — just extend the upper bound). Apply the same range fix to the `| [`decisions/`](decisions) | ADR-001 … ADR-007 |` row in `docs/README.zh-CN.md`.

- [ ] **Step 4: Verify + commit**

```bash
rg -n "ADR-010" README.md docs/README.zh-CN.md docs/decisions/ADR-010-zero-telemetry.md
rg -n "docs/adr/" README.md docs/ && echo "FAIL: wrong ADR dir referenced" || echo OK
npm run typecheck && npm test
git add docs/decisions/ADR-010-zero-telemetry.md README.md docs/README.zh-CN.md
git commit -m "$(cat <<'EOF'
docs: add ADR-010 zero-telemetry contract and link it from the READMEs

No usage/crash/identity telemetry; Grafana HTTP stays on the operator's
instance. Future outbound endpoints require a superseding ADR + opt-in.
EOF
)"
```

---

### Task 16: Explore-in-IDE（NEXT-P-07 / NEXT-U-12②）— revises ADR-007

ADR-007 Decision item 3 says "Explore cannot open in the IDE." That was scoping, not physics: the proxy **already** forwards `/explore` (`GRAFANA_NATIVE_PATH_PREFIXES` includes `'/explore'`) and already treats `/explore` documents as rewritable SPA shells (`REWRITABLE_DOCUMENT_PATH_PATTERN` = `/^\/(?:$|d\/|alerting(?:\/|$)|dashboards(?:\/|$)|explore(?:\/|$))/`). This task gives Explore the same embed path dashboards use, amends ADR-007, and extends `grafana_generate_deeplink`'s `openInIde` to `kind: 'explore'`.

**Files:**
- Modify: `src/grafana/grafanaDeeplink.ts`
- Modify: `src/webview/GrafanaEmbedProxy.ts`
- Create: `src/webview/ExplorePanel.ts`
- Modify: `src/extension.ts`
- Modify: `src/agent/GrafanaAgentToolService.ts`
- Modify: `src/mcp/bridgeSchemas.ts`, `src/mcp/toolCatalog.ts`
- Modify: `package.json`, `package.nls.json`, `package.nls.zh-cn.json`
- Modify: `l10n/bundle.l10n.zh-cn.json`
- Modify: `docs/decisions/ADR-007-discovery-annotations-deeplink.md`
- Modify: `README.md`, `skills/at-grafana-mcp/SKILL.md` (deeplink copy)
- Test: `test/grafana/grafanaDeeplink.test.ts`, `test/webview/GrafanaEmbedProxy.test.ts`, `test/webview/ExplorePanel.test.ts` (create), `test/agent/GrafanaAgentToolService.test.ts`

- [ ] **Step 0: Precondition gate（parent correction 4 — STOP if either misses）**

```bash
rg -n "openAlertRuleInIde" src/agent/GrafanaAgentToolService.ts src/extension.ts
rg -n "GrafanaEmbedProxyCopy" src/webview/GrafanaEmbedProxy.ts src/extension.ts
```

Both commands MUST produce hits (T8's alert-rule opener and T13's copy bag). If either prints nothing, **stop this task** and report which prerequisite is missing. Do not improvise a partial Explore feature.

- [ ] **Step 1: Extract `buildExploreLeftSearch` in `src/grafana/grafanaDeeplink.ts`**

The explore branch of `buildGrafanaDeeplink` currently ends the function like this:

```ts
  const query: Record<string, unknown> = { refId: 'A', datasource: { uid: input.datasourceUid } };
  if (input.expr !== undefined) {
    query.expr = input.expr;
  }
  const left = {
    datasource: input.datasourceUid,
    queries: [query],
    range: { from: input.from ?? 'now-1h', to: input.to ?? 'now' }
  };
  return `${origin}/explore?left=${encodeURIComponent(JSON.stringify(left))}`;
```

Replace that block with a shared builder (the panel opener needs the same search string for the proxy URL — one source of truth so the browser deeplink and the embedded page can never drift):

```ts
  return `${origin}/explore?${buildExploreLeftSearch(input)}`;
```

and add the exported function above `buildGrafanaDeeplink`:

```ts
/**
 * The `left=<json>` query string Grafana's Explore route reads its initial
 * state from. Shared by buildGrafanaDeeplink (browser URL) and the
 * Explore-in-IDE opener (proxied URL, NEXT-P-07) so both open the identical
 * query/range.
 */
export function buildExploreLeftSearch(input: { datasourceUid: string; expr?: string; from?: string; to?: string }): string {
  const query: Record<string, unknown> = { refId: 'A', datasource: { uid: input.datasourceUid } };
  if (input.expr !== undefined) {
    query.expr = input.expr;
  }
  const left = {
    datasource: input.datasourceUid,
    queries: [query],
    range: { from: input.from ?? 'now-1h', to: input.to ?? 'now' }
  };
  return `left=${encodeURIComponent(JSON.stringify(left))}`;
}
```

In `test/grafana/grafanaDeeplink.test.ts` add:

```ts
import { buildExploreLeftSearch } from '../../src/grafana/grafanaDeeplink';

describe('buildExploreLeftSearch', () => {
  it('is the exact query string buildGrafanaDeeplink appends to /explore', () => {
    const input = { kind: 'explore' as const, datasourceUid: 'prom-uid', expr: 'up', from: 'now-6h', to: 'now' };
    expect(buildGrafanaDeeplink('https://g.example', input)).toBe(
      `https://g.example/explore?${buildExploreLeftSearch(input)}`
    );
  });

  it('defaults the range to now-1h..now and omits expr when absent', () => {
    const search = buildExploreLeftSearch({ datasourceUid: 'loki-uid' });
    const left = JSON.parse(decodeURIComponent(search.replace(/^left=/, '')));
    expect(left).toEqual({
      datasource: 'loki-uid',
      queries: [{ refId: 'A', datasource: { uid: 'loki-uid' } }],
      range: { from: 'now-1h', to: 'now' }
    });
  });
});
```

(Keep every existing `buildGrafanaDeeplink` explore test green — behavior is unchanged, only factored.)

- [ ] **Step 2: `buildExploreUrl` on the proxy**

In `src/webview/GrafanaEmbedProxy.ts`, directly after `buildAlertRuleUrl`, add:

```ts
  /**
   * Mirrors Grafana's native Explore page (`/explore?left=...`). No new
   * routing is needed: '/explore' is already in GRAFANA_NATIVE_PATH_PREFIXES
   * and REWRITABLE_DOCUMENT_PATH_PATTERN, so the SPA document gets the same
   * appSubUrl/base rewrite dashboards get (ADR-007 amendment 2026-08-27).
   */
  buildExploreUrl(instanceId: string, search?: string): string {
    const base = this.requireEmbedBase();
    const query = search && search.length > 0 ? (search.startsWith('?') ? search : `?${search}`) : '';
    return `${base}/instances/${encodeURIComponent(instanceId)}/explore${query}`;
  }
```

In `test/webview/GrafanaEmbedProxy.test.ts`, next to the existing URL-builder tests, add:

```ts
  it('buildExploreUrl mints a token-prefixed /explore URL and normalizes the search prefix', async () => {
    const configManager = new FakeConfigManager();
    const embedProxy = createProxy({ configManager });
    await embedProxy.start();

    const bare = embedProxy.buildExploreUrl('inst-a');
    expect(bare).toBe(`${embedProxy.origin}${embedPath(embedProxy, '/instances/inst-a/explore')}`);

    const withSearch = embedProxy.buildExploreUrl('inst-a', 'left=%7B%7D');
    expect(withSearch.endsWith('/instances/inst-a/explore?left=%7B%7D')).toBe(true);
    expect(embedProxy.buildExploreUrl('inst-a', '?left=%7B%7D')).toBe(withSearch);
  });
```

- [ ] **Step 3: Create `src/webview/ExplorePanel.ts`**

Same shape as `DashboardPanel.ts` (which is the canonical model — read it first). Full file:

```ts
import * as vscode from 'vscode';
import { formatError } from '../utils/errors';
import { buildEmbedWebviewOptions, renderEmbedWebviewHtml } from './html';
import type { GrafanaEmbedProxy } from './GrafanaEmbedProxy';
import { revealOpenPanel, trackOpenPanel } from './openPanels';
import { t } from '../i18n/t';

export type ExploreEmbedProxy = Pick<GrafanaEmbedProxy, 'start' | 'origin' | 'buildExploreUrl'>;

/**
 * NEXT-P-07 / NEXT-U-12② — same pattern as DashboardPanel, targeting
 * Grafana's native Explore page via GrafanaEmbedProxy.buildExploreUrl
 * (ADR-007 amendment 2026-08-27).
 *
 * The dedupe key includes the search string, unlike dashboards/alerts:
 * "Explore on datasource X" with a different expr/range is a different
 * working set, and revealing a stale panel would silently show the wrong
 * query's results.
 */
export class ExplorePanel {
  static async open(
    proxy: ExploreEmbedProxy,
    instanceId: string,
    datasourceUid: string,
    title: string,
    search?: string
  ): Promise<void> {
    if (!instanceId || !datasourceUid) {
      await vscode.window.showErrorMessage(t('Cannot open Explore: the instance or datasource id is missing.'));
      return;
    }

    const key = `explore:${instanceId}:${datasourceUid}:${search ?? ''}`;
    if (revealOpenPanel(key)) {
      return;
    }

    let origin: string;
    try {
      await proxy.start();
      if (!proxy.origin) {
        throw new Error(t('AT Grafana embed proxy did not report an origin after starting.'));
      }
      origin = proxy.origin;
    } catch (error) {
      await vscode.window.showErrorMessage(
        t('Could not open Explore "{title}": {message}', { title, message: formatError(error) })
      );
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'atGrafana.explorePanel',
      title,
      vscode.ViewColumn.Active,
      buildEmbedWebviewOptions(origin)
    );
    trackOpenPanel(key, panel);

    panel.webview.html = renderEmbedWebviewHtml({
      title,
      proxyOrigin: origin,
      iframeSrc: proxy.buildExploreUrl(instanceId, search),
      language: vscode.env.language
    });
  }
}
```

Create `test/webview/ExplorePanel.test.ts` by copying `test/webview/DashboardPanel.test.ts` and adapting: `DashboardPanel` → `ExplorePanel`, `buildDashboardUrl` → `buildExploreUrl`, uid → datasourceUid, viewType `atGrafana.explorePanel`. Keep its cases (missing-ids error, proxy start failure surfaces a message, panel opens with the built iframe src, same-key reveal dedupes) and add one case DashboardPanel has no analogue for:

```ts
  it('opens a second panel when only the search differs (dedupe key includes the query)', async () => {
    // Same instance + datasource, different left= search → two panels, not a reveal.
  });
```

(Implement it with the same fake-proxy/panel-counting helpers the copied file already uses; assert two `createWebviewPanel` calls. Remember `disposeOpenPanels()` in `afterEach`, as the model file does.)

- [ ] **Step 4: Schema — explore variant gains `openInIde` + `title`**

In `src/mcp/bridgeSchemas.ts`, the middle member of `grafanaGenerateDeeplinkSchema` currently reads:

```ts
  z
    .object({
      instanceId: z.string().min(1),
      kind: z.literal('explore'),
      datasourceUid: z.string().min(1),
      expr: z.string().min(1).optional(),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional()
    })
    .strict(),
```

Replace with:

```ts
  z
    .object({
      instanceId: z.string().min(1),
      kind: z.literal('explore'),
      datasourceUid: z.string().min(1),
      expr: z.string().min(1).optional(),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
      openInIde: z.boolean().default(false),
      title: z.string().min(1).optional()
    })
    .strict(),
```

In `GRAFANA_GENERATE_DEEPLINK_INPUT_SCHEMA` (the hand-written JSON-Schema twin further down the same file), update the `openInIde` property description — its pre-T8 text was `'Dashboard only. Default false. Opens the AT Grafana Webview.'`; whatever T8 turned it into, the end state after this task must be:

```ts
    openInIde: {
      type: 'boolean',
      description: 'Dashboard, Explore, or alertRule. Default false. Opens the AT Grafana Webview.'
    },
```

and make sure `title`'s description (if T8 added one) no longer says dashboard-only.

- [ ] **Step 5: Tool service — `openExploreInIde` dep + dispatch**

In `src/agent/GrafanaAgentToolService.ts`:

1. Extend the import from `'../grafana/grafanaDeeplink'` to include `buildExploreLeftSearch`.
2. In `GrafanaAgentToolServiceDependencies`, after the (T8-added) `openAlertRuleInIde?` member, add:

```ts
  /**
   * Optional IDE opener for `grafana_generate_deeplink` with
   * `kind: 'explore', openInIde: true` (NEXT-P-07). Injected by
   * src/extension.ts so this class stays vscode-free.
   */
  openExploreInIde?: (args: {
    instanceId: string;
    datasourceUid: string;
    title?: string;
    search?: string;
  }) => Promise<void>;
```

3. In the `'grafana_generate_deeplink'` case, insert an explore branch **before** the existing dashboard/alertRule `openInIde` handling (after `const grafanaUrl = buildGrafanaDeeplink(instance!.url, parsed);`), keeping the established contract — a failed or missing opener still returns the URL with `openedInIde: false`:

```ts
            if (parsed.kind === 'explore' && parsed.openInIde === true) {
              const opener = this.deps.openExploreInIde;
              if (!opener) {
                return { grafanaUrl, openedInIde: false, message: 'IDE opener is not available.' };
              }
              try {
                await opener({
                  instanceId: parsed.instanceId,
                  datasourceUid: parsed.datasourceUid,
                  title: parsed.title,
                  search: buildExploreLeftSearch(parsed)
                });
                return { grafanaUrl, openedInIde: true };
              } catch (error) {
                return { grafanaUrl, openedInIde: false, message: formatError(error) };
              }
            }
```

Leave the dashboard branch (and T8's alertRule branch) byte-for-byte as they are. The pre-existing guard `if (parsed.kind !== 'dashboard' || parsed.openInIde !== true)` (or T8's evolution of it) must still route explore-without-openInIde to the plain `{ grafanaUrl, openedInIde: false }` return.

4. Tests — in `test/agent/GrafanaAgentToolService.test.ts`, the harness's `ServiceOptions`/`makeService` already thread `openDashboardInIde` (and, post-T8, `openAlertRuleInIde`); add `openExploreInIde` the same way, then add to the deeplink `describe` block:

```ts
    it('grafana_generate_deeplink explore openInIde calls the explore opener with the shared left search', async () => {
      const openExploreInIde = vi.fn(async () => undefined);
      const { service } = await makeService({ openExploreInIde });

      const result = await service.invoke('grafana_generate_deeplink', {
        instanceId: 'known',
        kind: 'explore',
        datasourceUid: 'prom-uid',
        expr: 'up',
        openInIde: true,
        title: 'Explore: up'
      });

      expect(openExploreInIde).toHaveBeenCalledWith({
        instanceId: 'known',
        datasourceUid: 'prom-uid',
        title: 'Explore: up',
        search: buildExploreLeftSearch({ datasourceUid: 'prom-uid', expr: 'up' })
      });
      expect(result.ok).toBe(true);
      expect((result as { result: { openedInIde: boolean } }).result.openedInIde).toBe(true);
    });

    it('grafana_generate_deeplink explore openInIde without an opener still returns the URL', async () => {
      const { service } = await makeService({});
      const result = await service.invoke('grafana_generate_deeplink', {
        instanceId: 'known',
        kind: 'explore',
        datasourceUid: 'prom-uid',
        openInIde: true
      });
      expect(result.ok).toBe(true);
      const payload = (result as { result: { grafanaUrl: string; openedInIde: boolean; message?: string } }).result;
      expect(payload.grafanaUrl).toContain('/explore?left=');
      expect(payload.openedInIde).toBe(false);
      expect(payload.message).toBe('IDE opener is not available.');
    });

    it('grafana_generate_deeplink explore openInIde survives an opener failure', async () => {
      const openExploreInIde = vi.fn(async () => {
        throw new Error('TLS not trusted');
      });
      const { service } = await makeService({ openExploreInIde });
      const result = await service.invoke('grafana_generate_deeplink', {
        instanceId: 'known',
        kind: 'explore',
        datasourceUid: 'prom-uid',
        openInIde: true
      });
      expect(result.ok).toBe(true);
      const payload = (result as { result: { openedInIde: boolean; message?: string } }).result;
      expect(payload.openedInIde).toBe(false);
      expect(payload.message).toContain('TLS not trusted');
    });
```

(Import `buildExploreLeftSearch` in the test file. The existing test `'grafana_generate_deeplink explore returns a left-pane URL and never calls the opener'` stays valid — it passes no `openInIde`.)

- [ ] **Step 6: Wire the opener + command in `src/extension.ts`**

1. Import `ExplorePanel`:

```ts
import { ExplorePanel } from './webview/ExplorePanel';
```

2. In the `GrafanaAgentToolService` construction, after the (T8) `openAlertRuleInIde` member, add — note the FUNC-14 non-interactive TLS rule applies exactly as it does for dashboards, and `openGrafanaEmbedPanel` is reused with `datasourceUid` riding in its generic `uid` slot:

```ts
    openExploreInIde: async ({ instanceId, datasourceUid, title, search }) => {
      await openGrafanaEmbedPanel(
        configManager,
        certTrustStore,
        instanceId,
        datasourceUid,
        title ?? t('Explore'),
        (panelInstanceId, panelDatasourceUid, panelTitle, _slug, panelSearch) =>
          ExplorePanel.open(grafanaEmbedProxy, panelInstanceId, panelDatasourceUid, panelTitle, panelSearch),
        undefined,
        search,
        { interactiveTls: false }
      );
    }
```

3. Next to `openAlertRuleCommand`, register a user-facing command (args-driven, palette-hidden — same pattern as `atGrafana.openDashboard`):

```ts
  const openExploreCommand = vscode.commands.registerCommand(
    'atGrafana.openExplore',
    async (args?: { instanceId?: string; datasourceUid?: string; title?: string; search?: string }) => {
      await openGrafanaEmbedPanel(
        configManager,
        certTrustStore,
        args?.instanceId ?? '',
        args?.datasourceUid ?? '',
        args?.title ?? t('Explore'),
        (instanceId, datasourceUid, title, _slug, search) =>
          ExplorePanel.open(grafanaEmbedProxy, instanceId, datasourceUid, title, search),
        undefined,
        args?.search
      );
    }
  );
```

and add `openExploreCommand` to the `context.subscriptions.push(...)` list (after `openAlertRuleCommand`).

- [ ] **Step 7: Manifest + nls + l10n**

`package.json` `contributes.commands` — add after the `atGrafana.openAlertRule` entry:

```json
      {
        "command": "atGrafana.openExplore",
        "title": "%atGrafana.command.openExplore.title%"
      },
```

`package.json` `menus.commandPalette` — add after the `atGrafana.openAlertRule` hide entry:

```json
        {
          "command": "atGrafana.openExplore",
          "when": "false"
        },
```

`package.nls.json` — after `atGrafana.command.openAlertRule.title`:

```json
  "atGrafana.command.openExplore.title": "AT Grafana: Open Explore",
```

`package.nls.zh-cn.json` — same position:

```json
  "atGrafana.command.openExplore.title": "AT Grafana: 打开 Explore",
```

`l10n/bundle.l10n.zh-cn.json` — three new runtime keys:

```json
  "Explore": "Explore",
  "Cannot open Explore: the instance or datasource id is missing.": "无法打开 Explore：缺少实例或数据源 ID。",
  "Could not open Explore \"{title}\": {message}": "无法打开 Explore「{title}」：{message}"
```

Then:

```bash
npx vitest run test/i18n/nls.test.ts
```

- [ ] **Step 8: Catalog copy**

In `src/mcp/toolCatalog.ts`, the `grafana_generate_deeplink` entry's description currently ends "…Explore and alertRule are URL-only." (or T8's revision covering alertRule). Set the end state to:

```ts
    description:
      'Build a Grafana dashboard, Explore, or alert-rule (kind alertRule, by rule uid) URL from the instance base ' +
      'URL. Always returns grafanaUrl. Explore accepts an optional expr pre-filled into the first query. Optional ' +
      'openInIde (default false) opens the AT Grafana Webview for dashboards, Explore, and alert rules; it requires ' +
      'the instance TLS fingerprint to already be trusted in the sidebar.' +
      MANAGEMENT_FAMILY_SUFFIX,
```

- [ ] **Step 9: Amend ADR-007**

Append to `docs/decisions/ADR-007-discovery-annotations-deeplink.md` (do not rewrite history above it):

```markdown

## Amendment (2026-08-27): Explore can open in the IDE

Decision item 3 above said "Explore cannot open in the IDE." That was a scoping call for the P1 change set, not a technical finding: the embed proxy already forwarded `/explore` (`GRAFANA_NATIVE_PATH_PREFIXES`) and already rewrote its SPA document (`REWRITABLE_DOCUMENT_PATH_PATTERN`), so the same Webview/proxy path that serves dashboards serves Explore.

As of Task 16 (`docs/plans/2026-08-27-agent-implementation-plan-c.md`):

- `grafana_generate_deeplink` with `kind: "explore"` accepts `openInIde` (default false) and an optional `title`, opening `ExplorePanel` through `GrafanaEmbedProxy.buildExploreUrl` — the same deeplink `left=` state, shared via `buildExploreLeftSearch`.
- A failed or missing opener still returns `grafanaUrl` with `openedInIde: false` (contract unchanged).
- Known limitation: Explore's live-tail mode relies on Grafana Live WebSocket push, which the proxy refuses by design (ADR-003 / the proxy class doc) — plain logs/metrics queries work over HTTP; live tail requires the browser. If in-IDE Explore proves unusable against a real instance, the recorded fallback is `vscode.env.openExternal` on the generated URL, keeping this amendment and tracking the limitation in the roadmap.
```

- [ ] **Step 10: User docs**

- `README.md` Features list, the 17-tool bullet: change `grafana_generate_deeplink` (`openInIde` default false)`` to ``grafana_generate_deeplink` (`openInIde` for dashboards / Explore / alert rules, default false)``.
- `skills/at-grafana-mcp/SKILL.md`: `rg -n "openInIde|deeplink" skills/at-grafana-mcp/SKILL.md` and update any "Explore … URL-only" claim to match the new behavior.
- `docs/features.md` / `docs/features.zh-CN.md` / `docs/usage.md` / `docs/usage.zh-CN.md`: `rg -n "openInIde|Explore" docs/*.md` — update stale "URL-only" claims where they appear; do not add new sections.

- [ ] **Step 11: Manual smoke（live Grafana required）+ fallback branch**

Launch the Extension Development Host (`F5`) against a reachable Grafana instance with Agent access enabled, then via the MCP client (or directly through the command):

```
grafana_generate_deeplink { instanceId, kind: "explore", datasourceUid: "<prom uid>", expr: "up", openInIde: true }
```

Expected: an `Explore` tab opens, the Explore UI renders inside the iframe, and running the pre-filled query works.

**If the Explore page fails to render through the proxy** (blank panel / plugin-load errors that dashboards do not show): implement the documented fallback instead — in `src/extension.ts`, replace the `openExploreInIde` body with `await vscode.env.openExternal(vscode.Uri.parse(buildGrafanaDeeplink(instance.url, ...)))`-based opening (resolve the instance via `configManager.getInstance` and throw on unknown), have the tool return `openedInIde: false` with `message: 'Opened in the external browser (Explore embed is not supported by this Grafana version).'`, keep the ADR-007 amendment (it already records this fallback), and add a row to `docs/plans/2026-08-27-followup-completeness-roadmap.md` tracking the limitation. Delete `ExplorePanel.ts` only if the embed is abandoned entirely — otherwise keep it behind the working path.

If no live Grafana is reachable from this environment, state that explicitly in the task report, keep the embed implementation (unit evidence: the proxy already routes `/explore`), and flag the smoke item for `docs/plans/2026-08-27-live-smoke-checklist.md`.

- [ ] **Step 12: Verify + commit**

```bash
npm run typecheck && npm test
npx vitest run test/i18n/nls.test.ts
git add src/grafana/grafanaDeeplink.ts src/webview/GrafanaEmbedProxy.ts src/webview/ExplorePanel.ts \
  src/extension.ts src/agent/GrafanaAgentToolService.ts src/mcp/bridgeSchemas.ts src/mcp/toolCatalog.ts \
  package.json package.nls.json package.nls.zh-cn.json l10n/bundle.l10n.zh-cn.json \
  docs/decisions/ADR-007-discovery-annotations-deeplink.md README.md skills/at-grafana-mcp/SKILL.md \
  test/grafana/grafanaDeeplink.test.ts test/webview/GrafanaEmbedProxy.test.ts \
  test/webview/ExplorePanel.test.ts test/agent/GrafanaAgentToolService.test.ts
git commit -m "$(cat <<'EOF'
feat: open Grafana Explore in the IDE embed webview (NEXT-P-07)

Extends grafana_generate_deeplink openInIde to kind=explore via a new
ExplorePanel on the existing proxy path, and amends ADR-007 (which had
scoped Explore to URL-only).
EOF
)"
```

（若 Step 10 还改了 `docs/features*.md` / `docs/usage*.md`，一并 `git add` 后再提交。）

---

### Task 17: Align `engines.vscode` / `@types/node` / CI Node（NEXT-Q-14）

Current facts (verified on this branch):

- `package.json` `engines.vscode`: `"^1.85.0"` — VS Code 1.85 embeds **Node 18** in the extension host (see the comment in `esbuild.config.mjs`: "Electron 25: Node 18 in the extension host, Chromium 114 in the Webview").
- `esbuild.config.mjs`: `target: 'node18'` (extension) / `target: 'chrome114'` (webview) — already correct.
- `package.json` devDependency `"@types/node": "^20.19.0"` — **wrong**: the typechecker currently accepts Node-20-only APIs the oldest supported host does not have.
- `.github/workflows/ci.yml`: `node-version: '20'` — correct as a *tooling* runtime (`@vscode/vsce`, vitest want current LTS), but undocumented.

**Chosen matrix** (parent correction 3: `engines.vscode` stays `^1.85.0`; raising it is a human product decision, not an agent cleanup):

| Surface | Value | Rationale |
|---|---|---|
| `engines.vscode` | `^1.85.0` (unchanged) | Oldest supported host; do not raise |
| esbuild `target` | `node18` / `chrome114` (unchanged) | Must match the oldest host |
| `@types/node` | **`^18.19.0` (changed from `^20.19.0`)** | Typecheck must reject APIs the Node 18 host lacks |
| CI / dev tooling Node | `20` (unchanged) | vsce/vitest requirement; tooling runtime ≠ ship target |

**Files:**
- Modify: `package.json` (+ `package-lock.json` via `npm install`)
- Create: `test/config/engineMatrix.test.ts`
- Modify: `.github/workflows/ci.yml` (comment only — serial AFTER Task 14 per parent correction 5)
- Modify: `README.md`

- [ ] **Step 1: Pin `@types/node` to the Node 18 line**

In `package.json` `devDependencies`, change:

```json
    "@types/node": "^20.19.0",
```

to:

```json
    "@types/node": "^18.19.0",
```

Then:

```bash
npm install
npm run typecheck
```

If the typecheck now fails, every failure is a **real** Node-20-only API the shipped bundle would have crashed on under a 1.85 host. Replace each with a Node-18-compatible equivalent. If any replacement is non-trivial (would change behavior or need a new dependency), **stop and report** — do not resolve it by restoring `@types/node@20` or raising `engines.vscode`.

- [ ] **Step 2: Regression-test the matrix**

Create `test/config/engineMatrix.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Read from disk (not import) so the assertions are about the files that ship — same pattern as test/i18n/nls.test.ts. */
function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

const manifest = JSON.parse(read('package.json')) as {
  engines: { vscode: string };
  devDependencies: Record<string, string>;
};

describe('runtime/engine matrix (NEXT-Q-14)', () => {
  it('keeps engines.vscode at ^1.85.0 — raising it drops users and is a human decision', () => {
    expect(manifest.engines.vscode).toBe('^1.85.0');
  });

  it('pins @types/node to the Node 18 line the ^1.85 extension host actually runs', () => {
    expect(manifest.devDependencies['@types/node']).toMatch(/^\^18\./);
  });

  it('keeps the esbuild extension target at node18 to match the oldest host', () => {
    expect(read('esbuild.config.mjs')).toContain("target: 'node18'");
  });

  it('runs CI tooling on Node 20 (vsce/vitest requirement, not the ship target)', () => {
    expect(read('.github/workflows/ci.yml')).toContain("node-version: '20'");
  });
});
```

- [ ] **Step 3: Document the split in `.github/workflows/ci.yml`**

Directly above the `- uses: actions/setup-node@v4` step, insert this comment (comment only; do not change the version — and do this only after Task 14's ci.yml edits are committed):

```yaml
      # Node 20 here is the *tooling* runtime (npm, vitest, @vscode/vsce need
      # current LTS). The shipped extension still targets the Node 18 runtime
      # embedded in VS Code ^1.85 hosts — enforced by esbuild `target: 'node18'`
      # and `@types/node@^18` (see test/config/engineMatrix.test.ts).
```

- [ ] **Step 4: README note**

In `README.md`'s Development section, replace:

```markdown
Requires Node.js 20+ and a VS Code / Cursor host matching `engines.vscode` (`^1.85.0`).
```

with:

```markdown
Requires Node.js 20+ for local tooling (build/test/package). The shipped bundle targets the Node 18 runtime embedded in VS Code / Cursor hosts matching `engines.vscode` (`^1.85.0`) — `@types/node` is pinned to 18 and esbuild targets `node18`, so Node-20-only APIs fail the typecheck here instead of failing on a user's machine.
```

Mirror the same change in `docs/README.zh-CN.md` (its 开发 section has the equivalent sentence: 「需要 Node.js 20+，以及满足 `engines.vscode`（`^1.85.0`）的宿主。」→ 说明 20 为工具链版本、产物目标为宿主内嵌的 Node 18).

- [ ] **Step 5: Verify + commit**

```bash
npm run typecheck && npm test
git add package.json package-lock.json test/config/engineMatrix.test.ts .github/workflows/ci.yml README.md docs/README.zh-CN.md
git commit -m "$(cat <<'EOF'
chore: pin @types/node to the Node 18 extension-host line (NEXT-Q-14)

engines.vscode stays ^1.85.0 and CI tooling stays on Node 20; a new
engineMatrix test keeps the four surfaces from drifting apart again.
EOF
)"
```

---

### Task 18: Nonce / CSP tests for the webview HTML

`src/utils/nonce.ts` (`createNonce` = 16 CSPRNG bytes, base64url) and both renderers in `src/webview/html.ts` already do the right thing; nothing locks it in. Add tests that the nonce is unique per render, that the CSP admits exactly that nonce, and that the CSP is never widened. **Tests only — zero `src/` changes. Never edit the CSP in `src/` to make a test pass; if a new assertion fails, the assertion mis-reads current behavior and the assertion is what changes.**

Run after Task 13 (both tasks edit `test/webview/html.test.ts`).

**Files:**
- Create: `test/utils/nonce.test.ts`
- Modify: `test/webview/html.test.ts`

- [ ] **Step 1: Create `test/utils/nonce.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { createNonce } from '../../src/utils/nonce';

describe('createNonce', () => {
  it('emits 22 base64url characters (16 CSPRNG bytes, unpadded)', () => {
    for (let i = 0; i < 32; i++) {
      expect(createNonce()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });

  it("never emits characters that would need escaping in an HTML attribute or a CSP 'nonce-' source", () => {
    for (let i = 0; i < 32; i++) {
      expect(createNonce()).not.toMatch(/[+/='"<>&\s]/);
    }
  });

  it('does not repeat across many generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(createNonce());
    }
    // 128 bits of entropy: any collision here is a broken generator, not luck.
    expect(seen.size).toBe(1000);
  });
});
```

- [ ] **Step 2: Extend `test/webview/html.test.ts`**

Inside `describe('renderWebviewHtml', ...)`, add a shared render helper and two tests (the existing test builds its webview stub inline — factor the same stub into the helper):

```ts
  function render(): string {
    return renderWebviewHtml(
      {
        cspSource: 'vscode-resource:',
        asWebviewUri: (uri: { fsPath: string }) => `webview-uri:${uri.fsPath}`
      } as never,
      { script: { fsPath: 'dist/webview/panel.js' } as never },
      '<main></main>',
      { boot: { ok: true } }
    );
  }

  function nonceOf(html: string): string {
    const nonce = /'nonce-([^']+)'/.exec(html)?.[1];
    expect(nonce).toBeDefined();
    return nonce ?? '';
  }

  it('mints a fresh nonce on every render', () => {
    expect(nonceOf(render())).not.toBe(nonceOf(render()));
  });

  it('stamps the CSP nonce onto the script tag and every JSON data tag', () => {
    const html = render();
    const nonce = nonceOf(html);

    expect(html).toContain(`script-src vscode-resource: 'nonce-${nonce}'`);
    expect(html).toContain(`<script nonce="${nonce}" src="webview-uri:dist/webview/panel.js">`);
    // renderJsonScript threads the same nonce onto the data island.
    expect(html).toContain(`id="boot" nonce="${nonce}"`);
  });
```

Inside `describe('renderEmbedWebviewHtml', ...)` (reusing its existing `options` and `cspOf`), add:

```ts
  it('mints a fresh nonce on every embed render — a reused nonce would let one leaked render script every later panel', () => {
    const first = /'nonce-([^']+)'/.exec(renderEmbedWebviewHtml(options))?.[1];
    const second = /'nonce-([^']+)'/.exec(renderEmbedWebviewHtml(options))?.[1];

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it('never widens the embed CSP: default-src none first, no unsafe-eval, no wildcard source', () => {
    const csp = cspOf(renderEmbedWebviewHtml(options));

    expect(csp.startsWith("default-src 'none';")).toBe(true);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain('*');
  });
```

(The existing test `'keeps every CSP source list restricted to the proxy origin, admitting only its own nonce script'` already proves CSP-nonce ↔ script-tag agreement for the embed shell; do not duplicate it, do not weaken it.)

- [ ] **Step 3: Verify + commit**

```bash
npx vitest run test/utils/nonce.test.ts test/webview/html.test.ts
npm run typecheck && npm test
git add test/utils/nonce.test.ts test/webview/html.test.ts
git commit -m "$(cat <<'EOF'
test: lock nonce uniqueness and CSP invariants for the webview shells

createNonce shape/entropy tests plus per-render nonce freshness and
no-widening assertions for both HTML renderers. No production changes.
EOF
)"
```

---

## Part C final gate

- [ ] All six task commits exist on the working branch (never `master`).
- [ ] `npm run typecheck && npm test` — green.
- [ ] `npx vitest run test/i18n/nls.test.ts` — green (Tasks 13/16 added keys).
- [ ] `rg -n "from 'vscode'" src/webview/GrafanaEmbedProxy.ts` prints nothing.
- [ ] `rg -n "docs/adr/" README.md docs/` prints nothing (ADR links all point at `docs/decisions/`).
- [ ] `git push -u origin <branch>`.
