import { redactSensitiveText } from './redaction';

export type LogLevelName = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * Brand carried by every log object `createRedactedLog` returns, so
 * `asRedactedLog` can recognize an already-wrapped log and return it as-is
 * instead of stacking a second redaction pass (each pass is ~16 regex sweeps
 * over the message; the embed proxy traces every forwarded sub-resource, so
 * a doubled pass is a real hot-path cost, not a rounding error).
 *
 * A symbol rather than a string property: it cannot collide with anything a
 * structural `LogSink` (a real `vscode.LogOutputChannel`, a test double)
 * happens to carry, so nothing can accidentally present itself as
 * already-redacted.
 */
const REDACTED_LOG_BRAND = Symbol('atGrafana.redactedLog');

interface BrandedLog extends AtGrafanaLog {
  [REDACTED_LOG_BRAND]?: true;
}

/**
 * The five methods `vscode.LogOutputChannel` exposes, narrowed to the string
 * form this extension uses. Declared structurally (rather than importing the
 * VS Code type) so the modules that log -- `GrafanaEmbedProxy`, `BridgeServer`,
 * `GrafanaHttpClient`, `QueryRateLimiter`, `GrafanaCertTrustStore` -- keep
 * their existing property of not importing `vscode` at all, and so tests can
 * hand them a plain recording object.
 */
export interface LogSink {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  trace(message: string): void;
}

export type AtGrafanaLog = LogSink;

/**
 * ## What belongs at which level
 *
 * The channel is a `LogOutputChannel`, so VS Code owns the level (Output
 * panel gear icon / `Developer: Set Log Level...`) and supplies timestamps.
 * Its default is Info, which is what fixes the levels below:
 *
 * - `error`  -- an operation failed and the user has a broken thing in front
 *               of them: upstream request errors, tool invocation failures.
 * - `warn`   -- refused, shed, or truncated on purpose: admission-gate
 *               rejections, a changed TLS fingerprint, a throttled query, a
 *               dashboard listing that hit its page guardrail.
 * - `info`   -- state transitions worth one line each: the proxy and bridge
 *               starting and stopping, a certificate being trusted.
 * - `debug`  -- per-operation detail that is only useful once you are already
 *               debugging: retry attempts, API error classification.
 * - `trace`  -- per-request flow.
 *
 * Nothing on a healthy request path logs at `info` or above. A dashboard
 * panel loads a few hundred sub-resources through the proxy; one line each
 * would turn the channel into a place nobody looks.
 *
 * ## Redaction is applied here, not at the call sites
 *
 * Every message is passed through `redactSensitiveText` on the way to the
 * sink. Doing it in one place is the point: a call site that interpolates an
 * upstream error, a URL, or a registry record cannot forget, and adding a new
 * log line cannot introduce a leak. `redactSensitiveText` is idempotent, so
 * text that already went through `formatError` is unharmed.
 */
export function createRedactedLog(sink: LogSink): AtGrafanaLog {
  const log: BrandedLog = {
    error: (message: string) => sink.error(redactSensitiveText(message)),
    warn: (message: string) => sink.warn(redactSensitiveText(message)),
    info: (message: string) => sink.info(redactSensitiveText(message)),
    debug: (message: string) => sink.debug(redactSensitiveText(message)),
    trace: (message: string) => sink.trace(redactSensitiveText(message))
  };
  // Non-enumerable so the brand never shows up in a spread/JSON dump of the
  // log object; only `asRedactedLog`'s `in` check ever looks for it.
  Object.defineProperty(log, REDACTED_LOG_BRAND, { value: true });
  return log;
}

/**
 * The default for every component that takes an optional log. Logging is a
 * diagnostic aid, never a behavior: a component handed no channel must do
 * exactly what it did before this file existed.
 */
export const noopLog: AtGrafanaLog = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined
};

/**
 * What every component that accepts an optional log should call on its
 * argument, exactly once, in its constructor.
 *
 * `AtGrafanaLog` is structural, so nothing stops a caller from passing a raw
 * `LogOutputChannel` (or a test double) that has never been through
 * `createRedactedLog`. Re-wrapping here means the filtering is a property of
 * *holding* a log rather than of having composed one correctly at the single
 * place `extension.ts` builds it -- a new component, or a future call site
 * that forgets, cannot reintroduce the leak.
 *
 * A log that already carries `REDACTED_LOG_BRAND` is returned as-is: it has
 * provably been through `createRedactedLog`, so a second wrap would only
 * re-run every redaction regex per message (see the brand's doc comment for
 * why that matters on the embed proxy's per-request trace path).
 */
export function asRedactedLog(log: AtGrafanaLog | undefined): AtGrafanaLog {
  if (log === undefined || log === noopLog) {
    return noopLog;
  }
  if (REDACTED_LOG_BRAND in log) {
    return log;
  }
  return createRedactedLog(log);
}
