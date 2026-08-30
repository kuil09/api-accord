import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';

import type { HealthResponse, ReadinessResponse } from '@api-accord/contracts';
import type { Logger } from '@api-accord/config';
import { errorMetadata } from '@api-accord/config';
import { correlationIdFromHeader, type DomainService, type EventStore } from '@api-accord/domain';
import { IdentityService } from '@api-accord/domain';
import { ingestWebhookDelivery, WebhookSignatureError } from './github.js';
import { handleAuthRequest, type AuthConfig } from './auth.js';
import type { SessionStore } from '@api-accord/persistence';

export interface ReadinessProbe {
  readonly name: string;
  check(): Promise<void>;
}

export interface ApiApplicationOptions {
  readonly logger: Logger;
  readonly readinessProbe: ReadinessProbe;
  // Issue #13: when configured, POST /webhooks/github ingests signed GitHub
  // events into evidence over the shared event ledger.
  readonly github?: {
    readonly webhookSecret: string;
    readonly store: EventStore;
    readonly domain: DomainService;
    // The app records processed delivery ids here so replays are acknowledged
    // without re-handling.
    readonly seenDeliveryIds: string[];
  };
  // Issue #53: authentication configuration
  readonly auth?: {
    readonly sessionStore: SessionStore;
    readonly identityService: IdentityService;
    readonly sessionTtlMs: number;
  };
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
    // Issue #53: Authentication endpoints
    if (options.auth !== undefined) {
      const authConfig: AuthConfig = {
        logger: options.logger,
        sessionStore: options.auth.sessionStore,
        identityService: options.auth.identityService,
        sessionTtlMs: options.auth.sessionTtlMs
      };
      const handled = await handleAuthRequest(request, response, authConfig);
      if (handled) return;
    }

    if (options.github !== undefined && request.method === 'POST' && url.pathname === '/webhooks/github') {
      const rawBody = await readBody(request);
      const deliveryId = headerString(request.headers['x-github-delivery']) ?? '';
      const outcome = await ingestWebhookDelivery(
        {
          deliveryId,
          event: headerString(request.headers['x-github-event']) ?? '',
          signatureHeader: headerString(request.headers['x-hub-signature-256']),
          payload: rawBody
        },
        {
          webhookSecret: options.github.webhookSecret,
          store: options.github.store,
          domain: options.github.domain,
          seenDeliveryIds: options.github.seenDeliveryIds
        }
      );
      options.github.seenDeliveryIds.push(deliveryId);
      statusCode = 200;
      writeJson(response, statusCode, { ...outcome, correlationId });
      return;
    }

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
    if (error instanceof WebhookSignatureError) {
      statusCode = 401;
      writeJson(response, statusCode, { error: 'invalid_signature', correlationId });
      return;
    }
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


function headerString(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return undefined;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk: string) => {
      data += chunk;
    });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
}