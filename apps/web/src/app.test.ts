import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { createLogger } from '@api-accord/config';

import { createWebApplication } from './app.js';

describe('web application', () => {
  it('serves the foundation shell', async (context) => {
    const application = createWebApplication({ logger: silentLogger() });
    context.after(() => application.close());
    const baseUrl = await listen(application.server);

    const response = await fetch(baseUrl);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.ok(html.includes('API Accord'));
    assert.ok(html.includes('Contract · Context · Decision · Evidence'));
  });

  it('exposes independent health and readiness endpoints', async (context) => {
    const application = createWebApplication({ logger: silentLogger() });
    context.after(() => application.close());
    const baseUrl = await listen(application.server);

    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/ready`)).status, 200);
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
