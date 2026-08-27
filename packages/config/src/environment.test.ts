import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadAppConfig } from './environment.js';

describe('loadAppConfig', () => {
  it('provides stable service defaults', (context) => {
    const originalPort = process.env['API_PORT'];
    const originalLogLevel = process.env['LOG_LEVEL'];
    context.after(() => {
      restoreEnvironment('API_PORT', originalPort);
      restoreEnvironment('LOG_LEVEL', originalLogLevel);
    });
    delete process.env['API_PORT'];
    delete process.env['LOG_LEVEL'];

    const config = loadAppConfig('api');

    assert.equal(config.port, 3000);
    assert.equal(config.logLevel, 'info');
  });

  it('rejects an invalid port rather than silently coercing it', (context) => {
    const originalPort = process.env['API_PORT'];
    context.after(() => restoreEnvironment('API_PORT', originalPort));
    process.env['API_PORT'] = 'not-a-port';

    assert.throws(() => loadAppConfig('api'), /API_PORT/u);
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
