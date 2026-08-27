import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SCOPES } from './primitives.js';
import { hasScope } from './identity.js';

describe('RBAC', () => {
  it('declares the eleven minimum-privilege scopes', () => {
    assert.equal(SCOPES.length, 11);
    assert.ok(SCOPES.includes('proposal:approve'));
    assert.ok(SCOPES.includes('implementation:write'));
    assert.ok(SCOPES.includes('runtime:observe'));
  });

  it('allows access when the required scope is held', () => {
    assert.equal(hasScope(['context:read', 'proposal:approve'], 'proposal:approve'), true);
  });

  it('denies access when the required scope is missing', () => {
    assert.equal(hasScope(['context:read'], 'proposal:approve'), false);
  });
});
