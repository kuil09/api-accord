import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryEventStore } from './events.js';
import { IdentityService, verifySecret } from './identity.js';
import type { Scope } from './primitives.js';
import { credentialId, organizationId, principalId, principalRef } from './primitives.js';

const actor = principalRef('human', 'tester');

describe('credential secret handling', () => {
  it('hashes with a salt and never stores the plaintext', async () => {
    const store = new InMemoryEventStore();
    const service = new IdentityService(store);
    const secret = 'super-secret-value';
    const { plaintext } = await service.issueCredential({
      actor,
      credentialId: credentialId('cred-1'),
      principalId: principalId('p-1'),
      name: 'ci-bot',
      scopes: ['context:read'] as readonly Scope[],
      secret
    });

    assert.equal(plaintext, secret, 'plaintext is exposed exactly once at issuance');

    const issued = (await store.getAll()).find((envelope) => envelope.event.type === 'CredentialIssued');
    assert.ok(issued);
    if (issued && issued.event.type === 'CredentialIssued') {
      assert.ok(issued.event.secretHash !== secret, 'plaintext is never stored');
      assert.match(issued.event.secretHash, /^[0-9a-f]+:[0-9a-f]+$/u, 'stored value is salt:hash');
      assert.equal(await verifySecret(issued.event.secretHash, secret), true);
      assert.equal(await verifySecret(issued.event.secretHash, 'wrong'), false);
    }
  });
});

describe('IdentityService commands', () => {
  it('records credential revocation', async () => {
    const store = new InMemoryEventStore();
    const service = new IdentityService(store);
    const credential = credentialId('cred-2');
    await service.issueCredential({
      actor,
      credentialId: credential,
      principalId: principalId('p-2'),
      name: 'ci-bot',
      scopes: [] as readonly Scope[],
      secret: 'first-secret'
    });
    await service.revokeCredential({ actor, credentialId: credential, reason: 'compromised' });
    const revoked = (await store.getAll()).find((envelope) => envelope.event.type === 'CredentialRevoked');
    assert.ok(revoked);
  });

  it('records credential rotation with a new hash', async () => {
    const store = new InMemoryEventStore();
    const service = new IdentityService(store);
    const credential = credentialId('cred-3');
    await service.issueCredential({
      actor,
      credentialId: credential,
      principalId: principalId('p-3'),
      name: 'ci-bot',
      scopes: [] as readonly Scope[],
      secret: 'first-secret'
    });
    const { plaintext } = await service.rotateCredential({ actor, credentialId: credential, newSecret: 'new-secret' });
    assert.equal(plaintext, 'new-secret');
    const rotated = (await store.getAll()).find((envelope) => envelope.event.type === 'CredentialRotated');
    assert.ok(rotated);
    if (rotated && rotated.event.type === 'CredentialRotated') {
      assert.ok(rotated.event.secretHash !== 'first-secret');
      assert.equal(await verifySecret(rotated.event.secretHash, 'new-secret'), true);
    }
  });

  it('registers and deactivates a principal', async () => {
    const store = new InMemoryEventStore();
    const service = new IdentityService(store);
    const principal = principalId('p-4');
    await service.registerPrincipal({
      actor,
      principalId: principal,
      kind: 'agent',
      organizationId: organizationId('o-1'),
      name: 'bot'
    });
    const registered = (await store.getAll()).find((envelope) => envelope.event.type === 'PrincipalRegistered');
    assert.ok(registered);
    await service.deactivatePrincipal({ actor, principalId: principal, reason: 'offboarded' });
    const deactivated = (await store.getAll()).find((envelope) => envelope.event.type === 'PrincipalDeactivated');
    assert.ok(deactivated);
  });

  it('records scope grant and revoke', async () => {
    const store = new InMemoryEventStore();
    const service = new IdentityService(store);
    const principal = principalId('p-5');
    await service.grantScope({ actor, principalId: principal, scope: 'proposal:approve' });
    const granted = (await store.getAll()).find((envelope) => envelope.event.type === 'ScopeGranted');
    assert.ok(granted);
    await service.revokeScope({ actor, principalId: principal, scope: 'proposal:approve' });
    const revoked = (await store.getAll()).find((envelope) => envelope.event.type === 'ScopeRevoked');
    assert.ok(revoked);
  });
});
