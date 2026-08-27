import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { createLogger } from '@api-accord/config';

import { createWorkerHealthApplication } from './app.js';

describe('worker health application', () => {
  it('reports readiness when the queue is reachable', async (context) => {
    const application = createWorkerHealthApplication({
      logger: silentLogger(),
      readinessProbe: () => Promise.resolve()
    });
    context.after(() => application.close());
    const baseUrl = await listen(application.server);

    const response = await fetch(`${baseUrl}/ready`);
    const body = await response.json() as { checks: Record<string, string> };

    assert.equal(response.status, 200);
    assert.equal(body.checks['postgresQueue'], 'ok');
  });

  it('returns 503 when the queue cannot be reached', async (context) => {
    const application = createWorkerHealthApplication({
      logger: silentLogger(),
      readinessProbe: () => Promise.reject(new Error('queue unavailable'))
    });
    context.after(() => application.close());
    const baseUrl = await listen(application.server);

    assert.equal((await fetch(`${baseUrl}/ready`)).status, 503);
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
