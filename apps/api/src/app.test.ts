import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { createLogger } from '@api-accord/config';

import { createApiApplication } from './app.js';

describe('API application', () => {
  it('returns process health and preserves a valid correlation id', async (context) => {
    const application = createApiApplication({
      logger: silentLogger(),
      readinessProbe: { name: 'test', check: () => Promise.resolve() }
    });
    context.after(() => application.close());
    const baseUrl = await listen(application.server);

    const response = await fetch(`${baseUrl}/health`, {
      headers: { 'x-correlation-id': 'test-request' }
    });
    const body = await response.json() as { status: string; correlationId: string };

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-correlation-id'), 'test-request');
    assert.equal(body.status, 'ok');
    assert.equal(body.correlationId, 'test-request');
  });

  it('reports readiness failure without claiming process failure', async (context) => {
    const application = createApiApplication({
      logger: silentLogger(),
      readinessProbe: {
        name: 'postgres',
        check: () => Promise.reject(new Error('database unavailable'))
      }
    });
    context.after(() => application.close());
    const baseUrl = await listen(application.server);

    const response = await fetch(`${baseUrl}/ready`);
    const body = await response.json() as { status: string; checks: Record<string, string> };

    assert.equal(response.status, 503);
    assert.equal(body.status, 'degraded');
    assert.equal(body.checks['postgres'], 'failed');
  });
});

function silentLogger() {
  return createLogger({ service: 'test', minimumLevel: 'debug', sink: () => undefined });
}

async function listen(server: import('node:http').Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
