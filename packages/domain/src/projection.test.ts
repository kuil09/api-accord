import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { apiContractId, changeProposalId, contextItemId, principalRef } from './primitives.js';
import { InMemoryEventStore } from './events.js';
import { changeProposalState, contextItemFrom, eventsUpTo } from './projection.js';

const actor = principalRef('human', 'tester');

describe('projection', () => {
  it('keeps proposal lifecycle states independent (INV-002)', async () => {
    const store = new InMemoryEventStore();
    const proposal = changeProposalId('p1');
    const contract = apiContractId('c1');
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ChangeProposalOpened', proposalId: proposal, contractId: contract, title: 'Add REVERSED' }
    });
    await store.append({ actor, correlationId: 'c', event: { type: 'ChangeProposalAccepted', proposalId: proposal } });
    await store.append({ actor, correlationId: 'c', event: { type: 'ProviderImplementationRecorded', proposalId: proposal } });

    const state = changeProposalState(await store.getAll(), proposal);
    assert.ok(state);
    assert.equal(state.accepted, true);
    assert.equal(state.implemented, true);
    assert.equal(state.deployed, false, 'acceptance must not imply deployment');
    assert.equal(state.observed, false);
    assert.equal(state.consumerReady, false);
  });

  it('reconstructs state at a point in time', async () => {
    const store = new InMemoryEventStore();
    const proposal = changeProposalId('p2');
    const contract = apiContractId('c2');
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-02T00:00:00Z');
    const t2 = new Date('2026-01-03T00:00:00Z');
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ChangeProposalOpened', proposalId: proposal, contractId: contract, title: 'x' },
      occurredAt: t0
    });
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ChangeProposalAccepted', proposalId: proposal },
      occurredAt: t1
    });
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'DeploymentRecorded', proposalId: proposal },
      occurredAt: t2
    });

    const atT1 = eventsUpTo(await store.getAll(), new Date('2026-01-02T12:00:00Z'));
    const state = changeProposalState(atT1, proposal);
    assert.ok(state);
    assert.equal(state.accepted, true);
    assert.equal(state.deployed, false, 'deployment after the point-in-time must not be visible');
  });

  it('correction leaves the original item intact (INV-012)', async () => {
    const store = new InMemoryEventStore();
    const original = contextItemId('ctx1');
    const correction = contextItemId('ctx2');
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ContextProposed', contextItemId: original, scope: 'operation', statement: 'status is enum', contextType: 'assumption', author: actor, source: 'doc', confidence: 'unverified' }
    });
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ContextConfirmed', contextItemId: original, validFrom: new Date('2026-01-01T00:00:00Z') }
    });
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ContextProposed', contextItemId: correction, scope: 'operation', statement: 'status is enum with REVERSED', contextType: 'assumption', author: actor, source: 'doc', confidence: 'unverified' }
    });
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ContextCorrected', originalContextItemId: original, correctionContextItemId: correction }
    });

    const all = await store.getAll();
    const current = contextItemFrom(all, original);
    assert.ok(current);
    assert.equal(current.correctedBy, correction);
    assert.equal(current.statement, 'status is enum', 'original statement is never overwritten');
    const proposed = all.find((envelope) => envelope.event.type === 'ContextProposed' && envelope.aggregateId === original);
    assert.ok(proposed, 'original proposed event still exists in the ledger');
  });
});
