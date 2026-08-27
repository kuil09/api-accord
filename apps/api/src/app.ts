import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';

import type { HealthResponse, ReadinessResponse } from '@api-accord/contracts';
import type { Logger } from '@api-accord/config';
import { errorMetadata } from '@api-accord/config';
import { correlationIdFromHeader } from '@api-accord/domain';

export interface ReadinessProbe {
  readonly name: string;
  check(): Promise<void>;
}

export interface ApiApplicationOptions {
  readonly logger: Logger;
  readonly readinessProbe: ReadinessProbe;
}

export interface ApiApplication {
  readonly server: Server;
  close(): Promise<void>;
}

export function createApiApplication(options: ApiApplicationOptions): ApiApplication {
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
  options: ApiApplicationOptions
): Promise<void> {
  const startedAt = performance.now();
  const correlationId = correlationIdFromHeader(request.headers['x-correlation-id']);
  const url = new URL(request.url ?? '/', 'http://api-accord.local');
  let statusCode = 500;

  response.setHeader('x-correlation-id', correlationId);

  try {
    if (request.method !== 'GET') {
      statusCode = 405;
      writeJson(response, statusCode, {
        error: 'method_not_allowed',
        correlationId
      });
      return;
    }

    if (url.pathname === '/health') {
      statusCode = 200;
      const payload: HealthResponse = {
        service: 'api',
        status: 'ok',
        timestamp: new Date().toISOString(),
        correlationId
      };
      writeJson(response, statusCode, payload);
      return;
    }

    if (url.pathname === '/ready') {
      try {
        await options.readinessProbe.check();
        statusCode = 200;
        const payload: ReadinessResponse = {
          service: 'api',
          status: 'ok',
          timestamp: new Date().toISOString(),
          correlationId,
          checks: {
            [options.readinessProbe.name]: 'ok'
          }
        };
        writeJson(response, statusCode, payload);
      } catch (error) {
        statusCode = 503;
        options.logger.warn('api.readiness.failed', {
          correlationId,
          ...errorMetadata(error)
        });
        const payload: ReadinessResponse = {
          service: 'api',
          status: 'degraded',
          timestamp: new Date().toISOString(),
          correlationId,
          checks: {
            [options.readinessProbe.name]: 'failed'
          }
        };
        writeJson(response, statusCode, payload);
      }
      return;
    }

    if (url.pathname === '/v1/meta') {
      statusCode = 200;
      writeJson(response, statusCode, {
        name: 'API Accord',
        purpose: 'API contract, context, decision, evidence, and drift collaboration',
        foundationIssues: [1, 2],
        correlationId
      });
      return;
    }

    statusCode = 404;
    writeJson(response, statusCode, {
      error: 'not_found',
      correlationId
    });
  } catch (error) {
    statusCode = 500;
    options.logger.error('api.request.failed', {
      correlationId,
      ...errorMetadata(error)
    });
    writeJson(response, statusCode, {
      error: 'internal_error',
      correlationId
    });
  } finally {
    options.logger.info('http.request', {
      correlationId,
      method: request.method,
      path: url.pathname,
      statusCode,
      durationMs: Number((performance.now() - startedAt).toFixed(2))
    });
  }
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
