import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { correlationIdFromHeader } from './correlation.js';

describe('correlationIdFromHeader', () => {
  it('preserves a valid caller-provided id', () => {
    assert.equal(correlationIdFromHeader('request-42'), 'request-42');
  });

  it('rejects values that are unsafe for logs and headers', () => {
    const result = correlationIdFromHeader('contains a space');
    assert.match(result, /^[0-9a-f-]{36}$/u);
  });

  it('uses the first value when a repeated header is supplied', () => {
    assert.equal(correlationIdFromHeader(['first', 'second']), 'first');
  });
});
