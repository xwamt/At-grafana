import { describe, expect, it } from 'vitest';
import { renderEmbedWebviewHtml, renderWebviewHtml } from '../../src/webview/html';

describe('renderWebviewHtml', () => {
  it('allows xterm runtime styles while keeping scripts nonce-protected', () => {
    const html = renderWebviewHtml(
      {
        cspSource: 'vscode-resource:',
        asWebviewUri: (uri: { fsPath: string }) => `webview-uri:${uri.fsPath}`
      } as never,
      {
        script: { fsPath: 'dist/webview/panel.js' } as never,
        style: { fsPath: 'dist/webview/panel.css' } as never
      },
      '<main></main>'
    );

    expect(html).toContain("style-src vscode-resource: 'unsafe-inline';");
    expect(html).toContain("script-src vscode-resource: 'nonce-");
  });
});

describe('renderEmbedWebviewHtml', () => {
  const PROXY_ORIGIN = 'http://127.0.0.1:4321';
  const options = {
    title: 'My Dashboard',
    iframeSrc: `${PROXY_ORIGIN}/e/tok/instances/inst-a/d/uid/slug`,
    proxyOrigin: PROXY_ORIGIN
  };

  function cspOf(html: string): string {
    return /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
  }

  it('defaults <html lang> to en and honors an explicit language (UX-12/UX-16)', () => {
    expect(renderEmbedWebviewHtml(options)).toContain('<html lang="en">');
    expect(renderEmbedWebviewHtml({ ...options, language: 'zh-cn' })).toContain('<html lang="zh-cn">');
  });

  it('escapes a hostile language value rather than letting it break out of the attribute', () => {
    const html = renderEmbedWebviewHtml({ ...options, language: '"><script>alert(1)</script>' });
    expect(html).not.toContain('"><script>alert(1)</script>');
  });

  it('renders a visible loading state that the iframe load event hides', () => {
    const html = renderEmbedWebviewHtml(options);

    expect(html).toContain('id="embed-loading"');
    expect(html).toContain('Loading Grafana');
    // The loading container itself must not start hidden…
    expect(html).not.toMatch(/id="embed-loading"[^>]*hidden/);
    // …and the wiring script hides it once the iframe document loads.
    expect(html).toContain("addEventListener('load'");
  });

  it('renders a hidden error state with a retry control wired to the iframe error event', () => {
    const html = renderEmbedWebviewHtml(options);

    expect(html).toMatch(/id="embed-error"[^>]*hidden/);
    expect(html).toContain('id="embed-retry"');
    expect(html).toContain("addEventListener('error'");
    expect(html).toContain("addEventListener('click'");
  });

  it('keeps every CSP source list restricted to the proxy origin, admitting only its own nonce script', () => {
    const html = renderEmbedWebviewHtml(options);
    const csp = cspOf(html);

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`frame-src ${PROXY_ORIGIN}`);
    expect(csp).toContain(`connect-src ${PROXY_ORIGIN}`);
    // No script may run from anywhere but the proxy origin or the shell's
    // own nonce — in particular, never 'unsafe-inline'.
    expect(csp).toMatch(new RegExp(`script-src ${PROXY_ORIGIN} 'nonce-[A-Za-z0-9+/=_-]+'`));
    expect(/script-src[^;]*'unsafe-inline'/.test(csp)).toBe(false);

    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeDefined();
    expect(html).toContain(`<script nonce="${nonce}">`);
  });

  it('keeps the iframe src as the first attribute for the embed proxy e2e test contract', () => {
    const html = renderEmbedWebviewHtml(options);
    expect(/<iframe src="([^"]+)"/.exec(html)?.[1]).toBe(options.iframeSrc);
  });
});
