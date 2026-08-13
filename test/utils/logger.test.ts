import { describe, expect, it } from 'vitest';
import { createRedactedLog, noopLog, type LogLevelName, type LogSink } from '../../src/utils/logger';

interface CapturedLine {
  level: LogLevelName;
  message: string;
}

function capturingSink(): { sink: LogSink; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const push = (level: LogLevelName) => (message: string) => {
    lines.push({ level, message });
  };
  return {
    lines,
    sink: { error: push('error'), warn: push('warn'), info: push('info'), debug: push('debug'), trace: push('trace') }
  };
}

/**
 * Every credential shape this extension can physically hold, each embedded in
 * the kind of error text that would realistically carry it. The assertion is
 * deliberately "the raw secret does not appear anywhere in the channel",
 * not "the message equals X" -- a future logger that reformats messages must
 * still keep every one of these out.
 */
const CREDENTIALS = {
  grafanaServiceAccountToken: 'glsa_H1o2Ck9dQvXzZ4bN7pLmR3sT8uW0yA6e_1f2a3b4c',
  grafanaCloudToken: 'glc_eyJvIjoiMTIzNDUiLCJuIjoic3RhY2sifQ==',
  legacyApiKey: 'eyJrIjoidGVzdC1rZXktZm9yLXJlZGFjdGlvbi1zYWZldHktcGFzcyIsIm4iOiJ0ZXN0IiwiaWQiOjF9',
  bridgeToken: '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0',
  embedToken: '2f6c9a1b3d5e7f80112233445566778899aabbccddeeff0011223344556677ab',
  password: 'hunter2'
};

describe('createRedactedLog', () => {
  it('forwards each level to the matching sink method', () => {
    const { sink, lines } = capturingSink();
    const log = createRedactedLog(sink);

    log.error('boom');
    log.warn('careful');
    log.info('started');
    log.debug('detail');
    log.trace('flow');

    expect(lines).toEqual([
      { level: 'error', message: 'boom' },
      { level: 'warn', message: 'careful' },
      { level: 'info', message: 'started' },
      { level: 'debug', message: 'detail' },
      { level: 'trace', message: 'flow' }
    ]);
  });

  it('scrubs every credential shape out of every level before the sink sees it', () => {
    const { sink, lines } = capturingSink();
    const log = createRedactedLog(sink);

    log.error(
      `Grafana rejected the request: authorization: Bearer ${CREDENTIALS.grafanaServiceAccountToken}`
    );
    log.warn(`instance token rotated to ${CREDENTIALS.grafanaCloudToken}`);
    log.info(`legacy key ${CREDENTIALS.legacyApiKey} is still configured`);
    log.debug(`published registry entry {"token":"${CREDENTIALS.bridgeToken}","port":51234}`);
    log.trace(`GET /e/${CREDENTIALS.embedToken}/instances/abc/api/search -> 200`);
    log.error(`connection string user=grafana password=${CREDENTIALS.password}`);
    log.error('-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----');

    const channelText = lines.map((line) => line.message).join('\n');
    for (const [name, secret] of Object.entries(CREDENTIALS)) {
      expect(channelText, `${name} leaked into the output channel`).not.toContain(secret);
    }
    expect(channelText).not.toContain('MIIEow');

    expect(lines.map((line) => line.message)).toEqual([
      'Grafana rejected the request: authorization: Bearer [REDACTED]',
      'instance token rotated to glc_[REDACTED]',
      'legacy key [REDACTED_GRAFANA_API_KEY] is still configured',
      'published registry entry {"token":"[REDACTED]","port":51234}',
      'GET /e/[REDACTED]/instances/abc/api/search -> 200',
      'connection string user=grafana password=[REDACTED]',
      '[REDACTED_PRIVATE_KEY]'
    ]);
  });

  it('redacts a credential that survived one pass of formatError', () => {
    // formatError already redacts, so log lines are frequently redacted twice.
    // Re-redacting must be a no-op rather than mangling the marker.
    const { sink, lines } = capturingSink();
    const log = createRedactedLog(sink);

    log.error('Bearer [REDACTED] rejected while calling glsa_[REDACTED]');

    expect(lines[0]?.message).toBe('Bearer [REDACTED] rejected while calling glsa_[REDACTED]');
  });

  it('keeps the useful part of a diagnostic intact', () => {
    const { sink, lines } = capturingSink();
    const log = createRedactedLog(sink);

    log.warn('embed-proxy: rejected request (reason=host-mismatch, host=evil.example.com:51234)');

    expect(lines[0]?.message).toBe(
      'embed-proxy: rejected request (reason=host-mismatch, host=evil.example.com:51234)'
    );
  });

  it('noopLog accepts every level without a sink', () => {
    expect(() => {
      noopLog.error('e');
      noopLog.warn('w');
      noopLog.info('i');
      noopLog.debug('d');
      noopLog.trace('t');
    }).not.toThrow();
  });
});
