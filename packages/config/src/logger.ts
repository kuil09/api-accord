import type { ServiceName } from '@api-accord/contracts';

import type { LogLevel } from './environment.js';

export type LogMetadata = Readonly<Record<string, unknown>>;
export type LogSink = (line: string) => void;

export interface Logger {
  debug(message: string, metadata?: LogMetadata): void;
  info(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  error(message: string, metadata?: LogMetadata): void;
}

export interface LoggerOptions {
  readonly service: ServiceName | 'scripts' | 'test';
  readonly minimumLevel: LogLevel;
  readonly sink?: LogSink;
}

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));

  const write = (level: LogLevel, message: string, metadata: LogMetadata = {}): void => {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[options.minimumLevel]) {
      return;
    }

    sink(JSON.stringify({
      ...metadata,
      timestamp: new Date().toISOString(),
      level,
      service: options.service,
      message
    }));
  };

  return {
    debug: (message, metadata) => write('debug', message, metadata),
    info: (message, metadata) => write('info', message, metadata),
    warn: (message, metadata) => write('warn', message, metadata),
    error: (message, metadata) => write('error', message, metadata)
  };
}

export function errorMetadata(error: unknown): LogMetadata {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack
    };
  }

  return { errorValue: String(error) };
}
