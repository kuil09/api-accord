export type ServiceName = 'api' | 'web' | 'worker';
export type HealthStatus = 'ok' | 'degraded';
export type ReadinessCheckStatus = 'ok' | 'failed' | 'skipped';

export interface HealthResponse {
  readonly service: ServiceName;
  readonly status: HealthStatus;
  readonly timestamp: string;
  readonly correlationId: string;
}

export interface ReadinessResponse extends HealthResponse {
  readonly checks: Readonly<Record<string, ReadinessCheckStatus>>;
}
