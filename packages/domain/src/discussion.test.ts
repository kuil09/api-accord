import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryEventStore } from './events.js';
import { DomainService, DomainRuleError } from './service.js';
import { decisionRecordFrom, discussionEntryFrom, discussionSummary } from './projection.js';
import { apiContractId, changeProposalId, decisionRecordId, discussionEntryId, principalRef, serviceId } from './primitives.js';

const human = principalRef('human', 'alice');
const agent = principalRef('agent', 'bot');
const consumer = principalRef('service', 'merchant-console');

describe('structured discussion (issue #8)', () => {
  it('creates every structured utterance kind with source links', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p-d1');
    const contract = apiContractId('c-d1');
    await service.openChangeProposal({ actor: human, proposalId: proposal, contractId: contract, title: 'x' });

    const entry = discussionEntryId('e1');
    await service.createDiscussionEntry({
      actor: human,
      entryId: entry,
      proposalId: proposal,
      kind: 'question',
      body: 'What does REVERSED mean for CANCELLED?',
      inReplyTo: undefined,
      quotes: undefined
    });
    const reconstructed = discussionEntryFrom(await store.getAll(), entry);
    assert.ok(reconstructed);
    assert.equal(reconstructed?.kind, 'question');
    assert.equal(reconstructed?.status, 'open');
    assert.equal(reconstructed?.author.kind, 'human', 'author kind is explicit');
  });

  it('an open blocking objection blocks acceptance until resolved (INV-005)', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p-d2');
    const contract = apiContractId('c-d2');
    await service.openChangeProposal({ actor: human, proposalId: proposal, contractId: contract, title: 'Add REVERSED' });
    const entry = discussionEntryId('e2');
    await service.createDiscussionEntry({
      actor: human,
      entryId: entry,
      proposalId: proposal,
      kind: 'objection',
      body: 'merchant-console parser rejects unknown enums',
      isBlockingObjection: true,
      affectedConsumers: [serviceId('merchant-console')]
    });
    await service.raiseBlockingObjection({ actor: human, entryId: entry, proposalId: proposal });

    // With the objection open, acceptance must be blocked (INV-005).
    let blocked = false;
    try {
      await service.acceptChangeProposal({ actor: human, proposalId: proposal, openBlockingObjections: 1, requiredApproversSatisfied: true });
    } catch (error) {
      blocked = error instanceof DomainRuleError && /INV-005/.test(error.reason);
    }
    assert.ok(blocked, 'acceptance blocked while blocking objection is open');

    await service.resolveBlockingObjection({ actor: human, entryId: entry, proposalId: proposal });
    await service.resolveDiscussionEntry({ actor: human, entryId: entry, proposalId: proposal, status: 'resolved' });
    const accepted = await service.acceptChangeProposal({ actor: human, proposalId: proposal, openBlockingObjections: 0, requiredApproversSatisfied: true });
    assert.ok(accepted.version > 0, 'acceptance proceeds once the objection is resolved');
  });

  it('promotes discussion entries into a Decision Record with source links (INV-013)', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p-d3');
    const contract = apiContractId('c-d3');
    await service.openChangeProposal({ actor: human, proposalId: proposal, contractId: contract, title: 'x' });
    const questionEntry = discussionEntryId('e3');
    const objectionEntry = discussionEntryId('e4');
    await service.createDiscussionEntry({ actor: human, entryId: questionEntry, proposalId: proposal, kind: 'question', body: 'mapping?' });
    await service.createDiscussionEntry({ actor: consumer, entryId: objectionEntry, proposalId: proposal, kind: 'alternative', body: 'map REVERSED to CANCELLED for old clients' });

    const decision = decisionRecordId('dec-1');
    await service.recordDecision({
      actor: human,
      decisionRecordId: decision,
      proposalId: proposal,
      decision: 'Map REVERSED to CANCELLED for mobile-app',
      rationale: 'Not all clients can update immediately',
      constraints: ['Remove mapping only after 2 releases'],
      rejectedAlternatives: [{ alternative: 'Ship new enum without mapping', reason: 'old clients break' }],
      approvers: [human],
      validFrom: new Date('2026-09-01'),
      sourceEntryIds: [questionEntry, objectionEntry]
    });

    const record = decisionRecordFrom(await store.getAll(), decision);
    assert.ok(record);
    assert.equal(record?.sourceEntryIds.length, 2, 'decision keeps its source discussion links');
    assert.equal(record?.rejectedAlternatives.length, 1);
    assert.ok(record?.constraints[0] === 'Remove mapping only after 2 releases');
  });

  it('an AI principal cannot record a decision on its own (INV-016)', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p-d4');
    await service.openChangeProposal({ actor: human, proposalId: proposal, contractId: apiContractId('c-d4'), title: 'x' });
    let threw = false;
    try {
      await service.recordDecision({
        actor: agent,
        decisionRecordId: decisionRecordId('dec-2'),
        proposalId: proposal,
        decision: 'Automated',
        rationale: 'inferred',
        approvers: [agent],
        validFrom: new Date()
      });
    } catch (error) {
      threw = error instanceof DomainRuleError && /INV-016/.test(error.reason);
    }
    assert.ok(threw, 'AI-only approvers are rejected');
  });

  it('superseding a decision keeps the old record and its validity window', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p-d5');
    await service.openChangeProposal({ actor: human, proposalId: proposal, contractId: apiContractId('c-d5'), title: 'x' });
    const original = decisionRecordId('dec-3');
    const replacement = decisionRecordId('dec-4');
    await service.recordDecision({
      actor: human,
      decisionRecordId: original,
      proposalId: proposal,
      decision: 'v1 mapping',
      rationale: 'r1',
      approvers: [human],
      validFrom: new Date('2026-09-01'),
      validUntil: new Date('2026-12-01')
    });
    await service.supersedeDecision({ actor: human, originalDecisionRecordId: original, supersedingDecisionRecordId: replacement });
    await service.recordDecision({
      actor: human,
      decisionRecordId: replacement,
      proposalId: proposal,
      decision: 'v2 mapping',
      rationale: 'r2',
      approvers: [human],
      validFrom: new Date('2026-12-01'),
      supersedes: original
    });

    const superseded = decisionRecordFrom(await store.getAll(), original);
    assert.ok(superseded);
    assert.equal(superseded?.decision, 'v1 mapping', 'past decision is retained');
    assert.equal(superseded?.supersededBy, replacement);
    assert.ok(superseded?.validUntil !== undefined, 'validity window stays queryable');
    const current = decisionRecordFrom(await store.getAll(), replacement);
    assert.equal(current?.supersedes, original);
  });

  it('summary preserves unresolved questions and open blocking objections (INV-014)', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p-d6');
    await service.openChangeProposal({ actor: human, proposalId: proposal, contractId: apiContractId('c-d6'), title: 'x' });
    const q1 = discussionEntryId('q1');
    const q2 = discussionEntryId('q2');
    const obj = discussionEntryId('o1');
    await service.createDiscussionEntry({ actor: human, entryId: q1, proposalId: proposal, kind: 'question', body: 'unresolved question' });
    await service.createDiscussionEntry({ actor: consumer, entryId: obj, proposalId: proposal, kind: 'objection', body: 'blocking', isBlockingObjection: true, affectedConsumers: [serviceId('merchant-console')] });
    await service.raiseBlockingObjection({ actor: human, entryId: obj, proposalId: proposal });
    await service.createDiscussionEntry({ actor: human, entryId: q2, proposalId: proposal, kind: 'question', body: 'resolved question' });
    await service.resolveDiscussionEntry({ actor: human, entryId: q2, proposalId: proposal, status: 'resolved' });

    const summary = discussionSummary(await store.getAll(), [q1, q2, obj]);
    assert.equal(summary.unresolvedQuestions.length, 1, 'unresolved question preserved');
    assert.equal(summary.unresolvedQuestions[0]?.body, 'unresolved question');
    assert.equal(summary.openBlockingObjections.length, 1, 'open blocking objection preserved');
    assert.equal(summary.resolvedCount, 1);
  });

  it('per-consumer positions are tracked as separate entries', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p-d7');
    await service.openChangeProposal({ actor: human, proposalId: proposal, contractId: apiContractId('c-d7'), title: 'Add REVERSED' });
    const a = discussionEntryId('pos-a');
    const b = discussionEntryId('pos-b');
    await service.createDiscussionEntry({ actor: consumer, entryId: a, proposalId: proposal, kind: 'objection', body: 'merchant-console: parser rejects unknown enum', affectedConsumers: [serviceId('merchant-console')], severity: 'high' });
    await service.createDiscussionEntry({ actor: principalRef('service', 'settlement-worker'), entryId: b, proposalId: proposal, kind: 'objection', body: 'settlement-worker: switch has no default', affectedConsumers: [serviceId('settlement-worker')], severity: 'critical' });
    const all = await store.getAll();
    const entryA = discussionEntryFrom(all, a);
    const entryB = discussionEntryFrom(all, b);
    assert.equal(entryA?.affectedConsumers[0], 'merchant-console');
    assert.equal(entryB?.affectedConsumers[0], 'settlement-worker');
    assert.equal(entryA?.body, 'merchant-console: parser rejects unknown enum');
    assert.equal(entryB?.body, 'settlement-worker: switch has no default');
  });
});
