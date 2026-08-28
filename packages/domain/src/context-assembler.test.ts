import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ContextItem, DependencyEdge } from './index.js';
import { DependencyService } from './dependency.js';
import { DomainService } from './service.js';
import { InMemoryEventStore } from './events.js';
import { FakeAiModel, FailingAiModel, assembleContextBundle, draftProposalAssistance, isContextBundleStale } from './context-assembler.js';
import { detectContextConflicts } from './projection.js';
import { dependencyEdgeId, observationId, operationId, principalRef, serviceId, teamId } from './primitives.js';

const human = principalRef('human', 'analyst');
const agent = principalRef('agent', 'bot');
const now = new Date('2026-06-15T00:00:00Z');

function contextItem(input: { id: string; statement: string; confidence?: ContextItem['confidence']; author?: ContextItem['author']; source?: string }): ContextItem {
  return {
    id: input.id as never,
    scope: 'operation',
    statement: input.statement,
    contextType: 'assumption',
    author: input.author ?? human,
    source: input.source ?? 'doc',
    confidence: input.confidence ?? 'confirmed',
    validFrom: now,
    visibility: 'organization',
    disputed: false
  };
}


describe('context bundle sections (issue #18)', () => {
  it('separates confirmed facts, AI assumptions, human review and drift mismatches', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    await store.append({
      actor: human,
      correlationId: 'c',
      event: { type: 'ContextProposed', contextItemId: 'ctx-f1' as never, scope: 'operation', statement: '404 means the payment does not exist yet', contextType: 'fact', author: human, source: 'docs', confidence: 'confirmed' }
    });
    await store.append({
      actor: agent,
      correlationId: 'c',
      event: { type: 'ContextProposed', contextItemId: 'ctx-a1' as never, scope: 'operation', statement: 'requests probably retry 3 times', contextType: 'assumption', author: agent, source: 'trace inference', confidence: 'inferred' }
    });
    await service.recordRuntimeObservation({
      actor: principalRef('integration', 'runtime-observer'),
      correlationId: 'c',
      observationId: observationId('obs-drift'),
      operationId: operationId('contract-payments:GET:/payments/{paymentId}'),
      environment: 'production',
      contractVersionId: 'contract-payments@rev-2',
      deploymentRevision: 'rev-2',
      collectorVersion: 'collector-1.4.2',
      kind: 'undocumented-status',
      detail: { status: 'CHARGEBACK' },
      redactionPolicy: { deniedFields: [], literalFields: ['status'] },
      sampleSize: 30
    });

    const bundle = assembleContextBundle({ events: await store.getAll(), computedBy: human, now, operationKey: 'GET:/payments/{paymentId}' });
    assert.equal(bundle.sections.confirmedFacts.length, 1, 'human-confirmed fact lands in facts');
    assert.equal(bundle.sections.assumptions.length, 1, 'AI inference lands in assumptions');
    assert.equal(bundle.sections.mismatches.length, 1, 'drift lands in mismatches');
    assert.equal(bundle.sections.needsHumanReview.length, 1, 'AI assumption needs human review (INV-016)');
    assert.ok(bundle.sections.assumptions[0]?.sourceRef, 'every claim carries a source reference');
  });
});

describe('evaluation fixtures (issue #18)', () => {
  it('fixture: optional-vs-required consumer belief conflicts with the contract (INV-008)', () => {
    const optionalContract = contextItem({ id: 'ctx-optional', statement: 'merchantId is optional on this operation' });
    const consumerBelief = contextItem({ id: 'ctx-belief', statement: 'merchantId is always present in responses', author: agent, confidence: 'inferred' });
    assert.equal(detectContextConflicts([optionalContract, consumerBelief]).length, 1, 'the contradiction is detected, not averaged away');
  });

  it('fixture: a consumer that disallows new enum values registers its policy in the bundle inputs', async () => {
    const store = new InMemoryEventStore();
    const dependencies = new DependencyService(store);
    const edge: DependencyEdge = {
      id: dependencyEdgeId('edge-enum'),
      consumerServiceId: serviceId('merchant-console'),
      operationId: operationId('contract-payments:GET:/payments/{paymentId}'),
      usage: { fields: ['status'], statusValues: ['APPROVED'], enumNullability: [], errorMeanings: [], orderingConsistencySideEffects: [] },
      assumptions: [{ id: 'a1', statement: 'unknown enum values are rejected by our parser', source: 'explicit', confidence: 'confirmed', conflictStatus: 'none' }],
      compatibility: { allowAdditiveFields: true, allowNewEnumValues: false, allowNullableChange: false },
      criticality: 'high',
      ownerTeamId: teamId('team-merchant'),
      source: 'explicit',
      confirmedAt: now,
      deprecated: false
    };
    await dependencies.declareDependency({
      actor: human,
      edgeId: edge.id,
      consumerServiceId: edge.consumerServiceId,
      operationId: edge.operationId,
      usage: edge.usage,
      compatibility: edge.compatibility,
      criticality: edge.criticality,
      source: edge.source,
      ownerTeamId: edge.ownerTeamId,
      assumptions: edge.assumptions
    });
    const bundle = assembleContextBundle({ events: await store.getAll(), computedBy: human, now, operationKey: 'GET:/payments/{paymentId}' });
    assert.ok(bundle.inputSignatures.some((signature) => signature.id === edge.id), 'the disallowing consumer edge is a bundle input');
  });

  it('fixture: a documented-vs-runtime status mismatch lands in the mismatches section', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    await service.recordRuntimeObservation({
      actor: principalRef('integration', 'runtime-observer'),
      correlationId: 'c',
      observationId: observationId('obs-drift'),
      operationId: operationId('contract-payments:GET:/payments/{paymentId}'),
      environment: 'production',
      contractVersionId: 'contract-payments@rev-2',
      deploymentRevision: 'rev-2',
      collectorVersion: 'collector-1.4.2',
      kind: 'undocumented-status',
      detail: { status: 'CHARGEBACK' },
      redactionPolicy: { deniedFields: [], literalFields: ['status'] },
      sampleSize: 30
    });
    const bundle = assembleContextBundle({ events: await store.getAll(), computedBy: human, now, operationKey: 'GET:/payments/{paymentId}' });
    assert.equal(bundle.sections.mismatches.length, 1, 'runtime drift is a mismatch, not a confirmed fact');
    assert.match(bundle.sections.mismatches[0]?.statement ?? '', /undocumented-status/u);
    assert.ok(bundle.sections.mismatches[0]?.sourceRef?.startsWith('drift:'), 'mismatch carries the drift incident as source');
  });

  it('fixture: a superseded decision moves to the stale section with its lineage', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = 'p-supersede' as never;
    await service.openChangeProposal({ actor: human, proposalId: proposal, contractId: 'c-supersede' as never, title: 'x' });
    await service.recordDecision({
      actor: human,
      decisionRecordId: 'dec-v1' as never,
      proposalId: proposal,
      decision: 'Map REVERSED to CANCELLED',
      rationale: 'old clients',
      approvers: [human],
      validFrom: new Date('2026-09-01T00:00:00Z')
    });
    await service.recordDecision({
      actor: human,
      decisionRecordId: 'dec-v2' as never,
      proposalId: proposal,
      decision: 'Native REVERSED handling for all clients',
      rationale: 'all clients updated',
      approvers: [human],
      validFrom: new Date('2027-01-01T00:00:00Z'),
      supersedes: 'dec-v1' as never
    });
    await service.supersedeDecision({ actor: human, originalDecisionRecordId: 'dec-v1' as never, supersedingDecisionRecordId: 'dec-v2' as never });

    const bundle = assembleContextBundle({ events: await store.getAll(), computedBy: human, now });
    assert.ok(bundle.sections.confirmedFacts.some((claim) => /Native REVERSED/u.test(claim.statement)), 'the replacing decision is the current fact');
    assert.ok(bundle.sections.stale.some((claim) => /Map REVERSED to CANCELLED/u.test(claim.statement)), 'the superseded decision is preserved as stale, not deleted');
  });

  it('fixture: AI inference without evidence stays unsupported and needs review (INV-016)', async () => {
    const store = new InMemoryEventStore();
    const item = contextItem({ id: 'ctx-ai', statement: 'this API probably requires OAuth2', author: agent, confidence: 'inferred', source: '' });
    await store.append({
      actor: agent,
      correlationId: 'c',
      event: { type: 'ContextProposed', contextItemId: item.id, scope: item.scope, statement: item.statement, contextType: item.contextType, author: item.author, source: item.source, confidence: item.confidence }
    });
    const bundle = assembleContextBundle({ events: await store.getAll(), computedBy: human, now });
    assert.equal(bundle.sections.unsupported.length, 1, 'AI claim with no source is flagged 근거 없음');
    assert.ok(bundle.sections.needsHumanReview.some((claim) => /OAuth2/u.test(claim.statement)), 'AI claims need human review');
    assert.equal(bundle.sections.confirmedFacts.length, 0, 'AI inference never becomes a confirmed fact');
  });
});

describe('AI draft assistance (INV-016, INV-017, INV-019)', () => {
  const bundle = assembleContextBundle({ events: [], computedBy: human, now });

  it('carries model/prompt provenance on the draft (INV-017)', async () => {
    const result = await draftProposalAssistance(bundle, new FakeAiModel('Draft: add REVERSED'));
    assert.ok(result.draft?.includes('REVERSED'));
    assert.equal(result.provenance?.provider, 'fake');
    assert.equal(result.provenance?.modelVersion, 'fake-model-1');
    assert.equal(result.provenance?.promptVersion, 'draft-v1');
  });

  it('an AI outage keeps the core bundle intact and reports the failure (INV-019)', async () => {
    const result = await draftProposalAssistance(bundle, new FailingAiModel());
    assert.equal(result.draft, undefined);
    assert.match(result.failure ?? '', /outage/u);
    assert.equal(bundle.sections.confirmedFacts.length, 0, 'the core bundle is unaffected by the AI failure');
  });
});

describe('bundle staleness (INV-015)', () => {
  it('goes stale when a new dependency edge appears after the bundle', async () => {
    const store = new InMemoryEventStore();
    const dependencies = new DependencyService(store);
    const bundle = assembleContextBundle({ events: await store.getAll(), computedBy: human, now });
    assert.equal(isContextBundleStale(bundle, await store.getAll()).stale, false, 'fresh with no changes');

    await dependencies.declareDependency({
      actor: human,
      edgeId: dependencyEdgeId('edge-new'),
      consumerServiceId: serviceId('new-consumer'),
      operationId: operationId('contract-payments:GET:/payments/{paymentId}'),
      usage: { fields: ['status'], statusValues: [], enumNullability: [], errorMeanings: [], orderingConsistencySideEffects: [] },
      compatibility: { allowAdditiveFields: true, allowNewEnumValues: false, allowNullableChange: false },
      criticality: 'medium',
      source: 'explicit'
    });
    const check = isContextBundleStale(bundle, await store.getAll());
    assert.equal(check.stale, true, 'a new consumer makes the bundle stale');
    assert.ok(check.reasons.some((reason) => /new dependency edge/u.test(reason)));
  });
});
