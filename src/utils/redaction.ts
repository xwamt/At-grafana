const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g;
const PASSWORD_PATTERN = /(password\s*=\s*)([^\s]+)/gi;

/**
 * Everything below was added when the extension gained an output channel
 * (`src/utils/logger.ts`). Before that, `redactSensitiveText` only ever saw
 * text already on its way to a toast or an HTML error page, so recognizing
 * PEM blocks and `password=` was enough. A log channel is a durable,
 * copy-pasteable artifact, and the four credentials this extension actually
 * holds -- a Grafana Service Account Token, a Grafana Cloud access policy
 * token, a legacy Grafana API key, and the two per-run loopback tokens --
 * were none of them matched by the original pair.
 *
 * Each pattern is anchored on a literal prefix rather than on entropy, so
 * ordinary diagnostic text (paths, status codes, hostnames) passes through
 * untouched. Every replacement is idempotent: the marker it writes cannot be
 * re-matched by the pattern that wrote it, which matters because `formatError`
 * redacts once and the logger redacts again on the way to the channel.
 */

/**
 * `Bearer <token>`, in any casing. Runs before the token-prefix patterns
 * below so the scheme stays readable (`Bearer [REDACTED]`) instead of being
 * reduced to a prefix marker; anything presented as a bearer credential is
 * redacted whether or not we recognize its shape.
 */
const BEARER_PATTERN = /(\bbearer\s+)(\S+)/gi;

/**
 * Grafana Service Account Tokens (`glsa_`) and Grafana Cloud access policy
 * tokens (`glc_`). Case-sensitive because Grafana always emits the prefix in
 * lower case, and matching case-insensitively would start catching ordinary
 * words that happen to begin `GLSA_`.
 */
const GRAFANA_TOKEN_PATTERN = /\bgl(sa|c)_[A-Za-z0-9_\-=+/]+/g;

/**
 * Pre-9 Grafana API keys are base64 of `{"k":"...","n":"...","id":N}`, so they
 * always start with the encoding of `{"k":"`. Matching that literal (rather
 * than "a long base64 run") is what keeps this from eating dashboard UIDs.
 */
const LEGACY_API_KEY_PATTERN = /\beyJrIjoi[A-Za-z0-9_\-=+/]+/g;

/** `?token=`/`&token=` in a URL and `"token":"..."` in a registry record -- the two shapes a Bridge token travels in. */
const TOKEN_FIELD_PATTERN = /([?&]token=|"token"\s*:\s*")([^&"\s]+)/gi;

/** The embed proxy's per-run token, which lives in the path itself (`/e/<token>/...`) and so appears in any logged URL. */
const EMBED_TOKEN_PATH_PATTERN = /(\/e\/)[A-Fa-f0-9]{32,}/g;

/**
 * A whole `Cookie:` / `Set-Cookie:` header value. The embed proxy both issues
 * its own cookies and relays Grafana's session cookie, and neither carries a
 * recognizable prefix -- `grafana_session=<opaque>` looks like any other pair.
 * So this drops the value wholesale rather than trying to name the credentials
 * inside it. Stops at `;` and end-of-line to leave the rest of a log line
 * readable.
 */
const COOKIE_HEADER_PATTERN = /((?:set-)?cookie:\s*)[^\r\n]+/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(PRIVATE_KEY_PATTERN, '[REDACTED_PRIVATE_KEY]')
    .replace(COOKIE_HEADER_PATTERN, '$1[REDACTED]')
    .replace(PASSWORD_PATTERN, '$1[REDACTED]')
    .replace(BEARER_PATTERN, '$1[REDACTED]')
    .replace(GRAFANA_TOKEN_PATTERN, 'gl$1_[REDACTED]')
    .replace(LEGACY_API_KEY_PATTERN, '[REDACTED_GRAFANA_API_KEY]')
    .replace(TOKEN_FIELD_PATTERN, '$1[REDACTED]')
    .replace(EMBED_TOKEN_PATH_PATTERN, '$1[REDACTED]');
}

export function toUserMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? redactSensitiveText(message) : 'Unexpected error';
  }
  return 'Unexpected error';
}
