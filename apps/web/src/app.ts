import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { HealthResponse, ReadinessResponse } from '@api-accord/contracts';
import type { Logger } from '@api-accord/config';
import { errorMetadata } from '@api-accord/config';
import { correlationIdFromHeader } from '@api-accord/domain';

export interface WebApplicationOptions {
  readonly logger: Logger;
  readonly publicDirectory?: string;
}

export interface WebApplication {
  readonly server: Server;
  close(): Promise<void>;
}

const DEFAULT_PUBLIC_DIRECTORY = fileURLToPath(new URL('../public/', import.meta.url));
const STATIC_PATHS: Readonly<Record<string, string>> = {
  '/': 'index.html',
  '/styles.css': 'styles.css'
};

export function createWebApplication(options: WebApplicationOptions): WebApplication {
  const publicDirectory = options.publicDirectory ?? DEFAULT_PUBLIC_DIRECTORY;
  const server = createServer((request, response) => {
    void handleRequest(request, response, options.logger, publicDirectory);
  });

  return {
    server,
    close: () => closeServer(server)
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  logger: Logger,
  publicDirectory: string
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
      service: 'web',
      status: 'ok',
      timestamp: new Date().toISOString(),
      correlationId
    };
    writeJson(response, 200, payload);
    return;
  }

  if (url.pathname === '/ready') {
    try {
      await readStaticFile(publicDirectory, 'index.html');
      const payload: ReadinessResponse = {
        service: 'web',
        status: 'ok',
        timestamp: new Date().toISOString(),
        correlationId,
        checks: { staticAssets: 'ok' }
      };
      writeJson(response, 200, payload);
    } catch (error) {
      logger.warn('web.readiness.failed', {
        correlationId,
        ...errorMetadata(error)
      });
      const payload: ReadinessResponse = {
        service: 'web',
        status: 'degraded',
        timestamp: new Date().toISOString(),
        correlationId,
        checks: { staticAssets: 'failed' }
      };
      writeJson(response, 503, payload);
    }
    return;
  }

  const relativePath = STATIC_PATHS[url.pathname];
  if (relativePath === undefined) {
    writeJson(response, 404, { error: 'not_found', correlationId });
    return;
  }

  try {
    const content = await readStaticFile(publicDirectory, relativePath);
    response.statusCode = 200;
    response.setHeader('content-type', contentType(relativePath));
    response.end(content);
  } catch (error) {
    logger.error('web.static_file.failed', {
      correlationId,
      path: relativePath,
      ...errorMetadata(error)
    });
    writeJson(response, 404, { error: 'not_found', correlationId });
  }
}

function readStaticFile(publicDirectory: string, relativePath: string): Promise<string | Uint8Array> {
  const basePath = publicDirectory.endsWith('/') ? publicDirectory : `${publicDirectory}/`;
  return readFile(new URL(relativePath, pathToFileURL(basePath)));
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'text/html; charset=utf-8';
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
