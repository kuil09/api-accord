import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  apiContractId,
  changeProposalId,
  contextItemId,
  contractVersionId,
  decisionRecordId,
  principalRef
} from './primitives.js';
import { ConcurrencyError, InMemoryEventStore } from './events.js';
import { DomainRuleError, DomainService } from './service.js';

const actor = principalRef('human', 'tester');
const other = principalRef('agent', 'bot');

async function assertDomainRuleRejected(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof DomainRuleError, 'expected a DomainRuleError');
  if (thrown instanceof DomainRuleError) {
    assert.match(thrown.reason, pattern);
  }
}

async function assertConcurrencyRejected(promise: Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ConcurrencyError, 'expected a ConcurrencyError');
}

describe('DomainService', () => {
  it('opens and accepts a change proposal on the happy path', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p1');
    const contract = apiContractId('c1');

    await service.openChangeProposal({ actor, proposalId: proposal, contractId: contract, title: 'Add REVERSED' });
    const result = await service.acceptChangeProposal({
      actor,
      proposalId: proposal,
      openBlockingObjections: 0,
      requiredApproversSatisfied: true
    });

    assert.equal(result.version, 2);
    const stream = await store.getStream('changeProposal', proposal);
    assert.equal(stream[1]?.event.type, 'ChangeProposalAccepted');
  });

  it('rejects acceptance while a blocking objection is open (INV-005)', async () => {
    const service = new DomainService(new InMemoryEventStore());
    const proposal = changeProposalId('p2');
    await service.openChangeProposal({ actor, proposalId: proposal, contractId: apiContractId('c2'), title: 'x' });
    await assertDomainRuleRejected(
      service.acceptChangeProposal({
        actor,
        proposalId: proposal,
        openBlockingObjections: 1,
        requiredApproversSatisfied: true
      }),
      /INV-005/
    );
  });

  it('rejects completion until every lifecycle state holds (INV-002, INV-006)', async () => {
    const service = new DomainService(new InMemoryEventStore());
    const proposal = changeProposalId('p3');
    const contract = apiContractId('c3');
    await service.openChangeProposal({ actor, proposalId: proposal, contractId: contract, title: 'x' });
    await service.acceptChangeProposal({ actor, proposalId: proposal, openBlockingObjections: 0, requiredApproversSatisfied: true });
    await assertDomainRuleRejected(
      service.completeProposal({ actor, proposalId: proposal }),
      /INV-002/
    );
  });

  it('completes a proposal only after the full lifecycle including consumer migration (INV-002, INV-006)', async () => {
    const service = new DomainService(new InMemoryEventStore());
    const proposal = changeProposalId('p5');
    const contract = apiContractId('c5');
    await service.openChangeProposal({ actor, proposalId: proposal, contractId: contract, title: 'x' });
    await service.acceptChangeProposal({ actor, proposalId: proposal, openBlockingObjections: 0, requiredApproversSatisfied: true });
    await service.recordProviderImplementation({ actor, proposalId: proposal });
    await service.recordConsumerReadiness({ actor, proposalId: proposal });
    await service.recordContractVerification({ actor, proposalId: proposal });
    await service.recordDeployment({ actor, proposalId: proposal });
    await service.recordObservation({ actor, proposalId: proposal });
    // Still missing consumer migration -> rejected per INV-006.
    await assertDomainRuleRejected(service.completeProposal({ actor, proposalId: proposal }), /INV-006/);
    await service.recordConsumerMigrationComplete({ actor, proposalId: proposal });
    const result = await service.completeProposal({ actor, proposalId: proposal });
    assert.equal(result.version, 9);
  });

  it('rejects a confirmed context without a source (INV-011)', async () => {
    const service = new DomainService(new InMemoryEventStore());
    const ctx = contextItemId('ctx1');
    await assertDomainRuleRejected(
      service.confirmContext({ actor, contextItemId: ctx, validFrom: new Date(), source: '' }),
      /INV-011/
    );
  });

  it('corrects a context item once, then rejects a second correction (INV-012)', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const original = contextItemId('ctx-o');
    const correction = contextItemId('ctx-c');
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ContextProposed', contextItemId: original, scope: 'operation', statement: 'x', contextType: 'assumption', author: actor, source: 'doc', confidence: 'unverified' }
    });
    await service.correctContext({ actor, originalContextItemId: original, correctionContextItemId: correction });
    await assertDomainRuleRejected(
      service.correctContext({ actor, originalContextItemId: original, correctionContextItemId: contextItemId('ctx-c2') }),
      /INV-012/
    );
  });

  it('rejects republishing an immutable contract version (INV-003)', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const version = contractVersionId('v1');
    await store.append({
      actor,
      correlationId: 'c',
      event: { type: 'ContractVersionPublished', versionId: version, contractId: apiContractId('c1'), sourceRevision: 'r1', checksum: 'cs1', decisionRecordId: decisionRecordId('d1') }
    });
    await assertDomainRuleRejected(
      service.publishContractVersion({ actor, versionId: version, contractId: apiContractId('c1'), sourceRevision: 'r2', checksum: 'cs2' }),
      /INV-003/
    );
  });

  it('enforces optimistic concurrency via expectedVersion', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p4');
    await service.openChangeProposal({ actor, proposalId: proposal, contractId: apiContractId('c4'), title: 'x' });
    // A direct append with a stale expected version must reject.
    await assertConcurrencyRejected(
      store.append({
        actor: other,
        correlationId: 'c',
        event: { type: 'ChangeProposalAccepted', proposalId: proposal },
        expectedVersion: 0
      })
    );
  });
});
