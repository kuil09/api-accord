import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConcurrencyError, InMemoryEventStore } from './events.js';
import { apiContractId, changeProposalId, principalRef } from './primitives.js';

const actor = principalRef('human', 'tester');

describe('InMemoryEventStore', () => {
  it('numbers stream versions monotonically from 1', async () => {
    const store = new InMemoryEventStore();
    const proposal = changeProposalId('p1');
    const contract = apiContractId('c1');
    const first = await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ChangeProposalOpened', proposalId: proposal, contractId: contract, title: 'Add REVERSED' },
      expectedVersion: 0
    });
    const second = await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ChangeProposalAccepted', proposalId: proposal }
    });
    assert.equal(first.version, 1);
    assert.equal(second.version, 2);
  });

  it('rejects appends with a stale expected version (optimistic concurrency)', async () => {
    const store = new InMemoryEventStore();
    const proposal = changeProposalId('p2');
    const contract = apiContractId('c2');
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ChangeProposalOpened', proposalId: proposal, contractId: contract, title: 'x' },
      expectedVersion: 0
    });
    let thrown: unknown;
    try {
      await store.append({
        actor,
        correlationId: 'c',
        event: { type: 'ChangeProposalAccepted', proposalId: proposal },
        expectedVersion: 0
      });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof ConcurrencyError, 'stale expected version must reject');
    if (thrown instanceof ConcurrencyError) {
      assert.equal(thrown.actualVersion, 1);
    }
    const ok = await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ChangeProposalAccepted', proposalId: proposal },
      expectedVersion: 1
    });
    assert.equal(ok.version, 2);
  });

  it('is append-only: re-issuing content creates a new envelope, never an overwrite', async () => {
    const store = new InMemoryEventStore();
    const proposal = changeProposalId('p3');
    const contract = apiContractId('c3');
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ChangeProposalOpened', proposalId: proposal, contractId: contract, title: 'x' }
    });
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ChangeProposalOpened', proposalId: proposal, contractId: contract, title: 'x' }
    });
    const all = await store.getAll();
    assert.equal(all.length, 2);
    assert.ok(all[0]?.eventId !== all[1]?.eventId, 're-issued content creates a distinct envelope');
  });

  it('returns a single aggregate stream ordered by version', async () => {
    const store = new InMemoryEventStore();
    const proposal = changeProposalId('p4');
    const contract = apiContractId('c4');
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ChangeProposalOpened', proposalId: proposal, contractId: contract, title: 'x' },
      expectedVersion: 0
    });
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ChangeProposalAccepted', proposalId: proposal },
      expectedVersion: 1
    });
    const stream = await store.getStream('changeProposal', proposal);
    assert.equal(stream.length, 2);
    assert.equal(stream[0]?.event.type, 'ChangeProposalOpened');
    assert.equal(stream[1]?.event.type, 'ChangeProposalAccepted');
  });
});
