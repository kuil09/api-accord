import { existsSync } from 'node:fs';

import type { ServiceName } from '@api-accord/contracts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  readonly service: ServiceName;
  readonly nodeEnv: string;
  readonly logLevel: LogLevel;
  readonly port: number;
  readonly databaseUrl: string | undefined;
  readonly workerId: string;
  readonly workerPollIntervalMs: number;
}

const DEFAULT_PORTS: Readonly<Record<ServiceName, number>> = {
  api: 3000,
  web: 3001,
  worker: 3002
};

export function loadDotEnvFile(path = '.env'): void {
  if (existsSync(path)) {
    process.loadEnvFile(path);
  }
}

export function loadAppConfig(service: ServiceName): AppConfig {
  return {
    service,
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    logLevel: parseLogLevel(process.env['LOG_LEVEL']),
    port: parseInteger(`${service.toUpperCase()}_PORT`, process.env[`${service.toUpperCase()}_PORT`], DEFAULT_PORTS[service], 1, 65_535),
    databaseUrl: emptyToUndefined(process.env['DATABASE_URL']),
    workerId: process.env['WORKER_ID'] ?? 'local-worker',
    workerPollIntervalMs: parseInteger(
      'WORKER_POLL_INTERVAL_MS',
      process.env['WORKER_POLL_INTERVAL_MS'],
      1_000,
      50,
      60_000
    )
  };
}

export function requireDatabaseUrl(config: AppConfig): string {
  if (config.databaseUrl === undefined) {
    throw new Error('DATABASE_URL is required for this process');
  }

  return config.databaseUrl;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function parseLogLevel(value: string | undefined): LogLevel {
  switch (value) {
    case undefined:
    case 'info':
      return 'info';
    case 'debug':
    case 'warn':
    case 'error':
      return value;
    default:
      throw new Error(`LOG_LEVEL must be debug, info, warn, or error; received ${value}`);
  }
}

function parseInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }

  return parsed;
}
