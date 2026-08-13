import type { AtGrafanaLog, LogLevelName } from '../../src/utils/logger';

export interface RecordedLogLine {
  level: LogLevelName;
  message: string;
}

export interface RecordingLog extends AtGrafanaLog {
  readonly lines: RecordedLogLine[];
  /** Every recorded message joined, for "no credential reached the channel" assertions. */
  text(): string;
  messages(level: LogLevelName): string[];
  clear(): void;
}

/**
 * A `LogSink` that keeps what it was handed. Deliberately records the string
 * the logger passed *to the sink* (i.e. post-redaction), because that is the
 * text a real `LogOutputChannel` would render.
 */
export function recordingLog(): RecordingLog {
  const lines: RecordedLogLine[] = [];
  const record = (level: LogLevelName) => (message: string) => {
    lines.push({ level, message });
  };
  return {
    lines,
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    trace: record('trace'),
    text: () => lines.map((line) => line.message).join('\n'),
    messages: (level: LogLevelName) => lines.filter((line) => line.level === level).map((line) => line.message),
    clear: () => {
      lines.length = 0;
    }
  };
}
