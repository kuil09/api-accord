import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { HealthResponse, ReadinessResponse } from '@api-accord/contracts';
import type { Logger } from '@api-accord/config';
import { errorMetadata } from '@api-accord/config';
import { correlationIdFromHeader } from '@api-accord/domain';

export interface WorkerHealthApplicationOptions {
  readonly logger: Logger;
  readonly readinessProbe: () => Promise<void>;
}

export interface WorkerHealthApplication {
  readonly server: Server;
  close(): Promise<void>;
}

export function createWorkerHealthApplication(
  options: WorkerHealthApplicationOptions
): WorkerHealthApplication {
  const server = createServer((request, response) => {
    void handleRequest(request, response, options);
  });

  return {
    server,
    close: () => closeServer(server)
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkerHealthApplicationOptions
): Promise<void> {
  const correlationId = correlationIdFromHeader(request.headers['x-correlation-id']);
  const url = new URL(request.url ?? '/', 'http://api-accord.local');
  response.setHeader('x-correlation-id', correlationId);

  if (request.method !== 'GET') {
    writeJson(response, 405, { error: 'method_not_allowed', correlationId });
    return;
  }

  if (url.pathname === '/health') {
    const payload: HealthResponse = {
      service: 'worker',
      status: 'ok',
      timestamp: new Date().toISOString(),
      correlationId
    };
    writeJson(response, 200, payload);
    return;
  }

  if (url.pathname === '/ready') {
    try {
      await options.readinessProbe();
      const payload: ReadinessResponse = {
        service: 'worker',
        status: 'ok',
        timestamp: new Date().toISOString(),
        correlationId,
        checks: { postgresQueue: 'ok' }
      };
      writeJson(response, 200, payload);
    } catch (error) {
      options.logger.warn('worker.readiness.failed', {
        correlationId,
        ...errorMetadata(error)
      });
      const payload: ReadinessResponse = {
        service: 'worker',
        status: 'degraded',
        timestamp: new Date().toISOString(),
        correlationId,
        checks: { postgresQueue: 'failed' }
      };
      writeJson(response, 503, payload);
    }
    return;
  }

  writeJson(response, 404, { error: 'not_found', correlationId });
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(`${JSON.stringify(payload)}\n`);
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}
