import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CompatibilityPolicy, ContractSnapshot, DependencyEdge } from './index.js';
import { diffContractSnapshots } from './contract-diff.js';
import { analyzeImpact, canAmendImpactAnalysis, isImpactAnalysisStale, pinImpactAnalysis } from './impact.js';
import { DomainService, DomainRuleError } from './service.js';
import { InMemoryEventStore } from './events.js';
import { allDependencyEdges } from './projection.js';
import { apiContractId, changeProposalId, dependencyEdgeId, operationId, principalRef, serviceId, teamId } from './primitives.js';

const human = principalRef('human', 'analyst');

const paymentStatusSchema = (statuses: ReadonlyArray<string>): unknown => ({
  type: 'object',
  required: ['id', 'status'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: [...statuses] },
    approvedAt: { type: 'string', format: 'date-time', nullable: true }
  }
});

const snapshot = (statuses: ReadonlyArray<string>): ContractSnapshot => ({
  title: 'Payments',
  operations: [
    {
      method: 'get',
      path: '/payments/{paymentId}',
      responses: [
        { status: '200', schema: paymentStatusSchema(statuses) },
        { status: '404', schema: { type: 'object' } }
      ],
      security: []
    },
    {
      method: 'post',
      path: '/payments',
      requestSchema: { type: 'object', required: ['amount'], properties: { amount: { type: 'integer' } } },
      responses: [{ status: '201', schema: { type: 'object' } }],
      security: []
    }
  ]
});

const from = snapshot(['PENDING', 'APPROVED', 'CANCELLED']);
const to = snapshot(['PENDING', 'APPROVED', 'CANCELLED', 'REVERSED']);
const diff = diffContractSnapshots(from, to);

function edge(consumer: string, fields: ReadonlyArray<string>, policy: CompatibilityPolicy, options: { assumptions?: ReadonlyArray<string>; confirmedAt?: Date; otherOperation?: boolean } = {}): DependencyEdge {
  return {
    id: dependencyEdgeId(`edge-${consumer}`),
    consumerServiceId: serviceId(consumer),
    operationId: options.otherOperation === true
      ? operationId('contract-payments:GET:/refunds')
      : operationId('contract-payments:GET:/payments/{paymentId}'),
    usage: {
      fields,
      statusValues: ['APPROVED'],
      enumNullability: [],
      errorMeanings: ['404 means payment not created'],
      timeoutExpectation: '500ms',
      retryExpectation: '3 times',
      idempotencyExpectation: 'idempotent create',
      orderingConsistencySideEffects: []
    },
    assumptions: (options.assumptions ?? []).map((statement, index) => ({ id: `a${String(index)}`, statement, source: 'explicit' as const, confidence: 'confirmed' as const, conflictStatus: 'none' as const })),
    compatibility: policy,
    criticality: 'high',
    ownerTeamId: teamId(`team-${consumer}`),
    source: 'explicit',
    confirmedAt: options.confirmedAt ?? new Date('2026-01-01T00:00:00Z'),
    deprecated: false
  };
}

const strictPolicy: CompatibilityPolicy = { allowAdditiveFields: true, allowNewEnumValues: false, allowNullableChange: false };
const lenientPolicy: CompatibilityPolicy = { allowAdditiveFields: true, allowNewEnumValues: true, allowNullableChange: true };

describe('impact analysis (issue #11, REVERSED baseline)', () => {
  const edges: ReadonlyArray<DependencyEdge> = [
    edge('merchant-console', ['id', 'status', 'approvedAt'], strictPolicy, { assumptions: ['status APPROVED always implies approvedAt exists'] }),
    edge('settlement-worker', ['status'], strictPolicy),
    edge('mobile-app', ['status'], lenientPolicy),
    edge('undeclared-consumer', [], strictPolicy),
    edge('refunds-only', ['refundId'], strictPolicy, { otherOperation: true })
  ];

  const analysis = analyzeImpact({ diff, edges, providerTeamId: teamId('team-payments'), policyOwnerTeamIds: [teamId('team-policy')] });
  const byConsumer = new Map(analysis.impacts.map((impact) => [impact.consumerServiceId, impact]));

  it('merchant-console: blocking with unknown-enum and contract-test actions', () => {
    const impact = byConsumer.get(serviceId('merchant-console'));
    assert.ok(impact);
    assert.equal(impact?.impact, 'blocking');
    assert.equal(impact?.confidence, 'confirmed');
    const kinds = impact?.requiredActions.map((action) => action.kind);
    assert.ok(kinds?.includes('unknown-enum-handling'));
    assert.ok(kinds?.includes('contract-test'));
    assert.ok(kinds?.includes('deployment-ordering'));
    assert.ok(impact?.reasons.some((reason) => /does not allow unknown enum values/u.test(reason)));
    assert.ok(impact?.evidencePath.some((segment) => /response\.200\.status/u.test(segment)), 'evidence path reaches the changed field');
  });

  it('settlement-worker: blocking with code-change action (exhaustive switch)', () => {
    const impact = byConsumer.get(serviceId('settlement-worker'));
    assert.ok(impact);
    assert.equal(impact?.impact, 'blocking');
    assert.ok(impact?.requiredActions.some((action) => action.kind === 'code-change'));
    assert.ok(impact?.requiredActions.some((action) => action.kind === 'timeout-retry-adjustment'), 'timeout expectation triggers re-verification');
  });

  it('mobile-app: action-required but not blocking under a lenient policy', () => {
    const impact = byConsumer.get(serviceId('mobile-app'));
    assert.ok(impact);
    assert.equal(impact?.impact, 'action-required');
    assert.ok(!impact?.semantic.blocking);
  });

  it('empty usage declaration is unknown, never none (INV-009)', () => {
    const impact = byConsumer.get(serviceId('undeclared-consumer'));
    assert.ok(impact);
    assert.equal(impact?.impact, 'unknown');
    assert.equal(impact?.confidence, 'unverified');
  });

  it('a consumer whose operations are unaffected is none, with an acknowledgement action', () => {
    const impact = byConsumer.get(serviceId('refunds-only'));
    assert.ok(impact);
    assert.equal(impact?.impact, 'none');
    assert.ok(impact?.requiredActions.some((action) => action.kind === 'explicit-acknowledgement'));
  });

  it('computes required reviewers: provider team, affected consumer teams, policy owner', () => {
    const reviewerTeams = analysis.requiredReviewers.map((reviewer) => reviewer.teamId);
    assert.ok(reviewerTeams.includes(teamId('team-payments')));
    assert.ok(reviewerTeams.includes(teamId('team-merchant-console')));
    assert.ok(reviewerTeams.includes(teamId('team-settlement-worker')));
    assert.ok(reviewerTeams.includes(teamId('team-policy')), 'blocking impacts pull in the policy owner');
    assert.ok(!reviewerTeams.includes(teamId('team-refunds-only')), 'unaffected consumer team is not required');
  });

  it('three consumers get three different action sets (completion condition)', () => {
    const merchant = byConsumer.get(serviceId('merchant-console'))?.requiredActions.map((action) => action.description).sort().join('|');
    const settlement = byConsumer.get(serviceId('settlement-worker'))?.requiredActions.map((action) => action.description).sort().join('|');
    const mobile = byConsumer.get(serviceId('mobile-app'))?.requiredActions.map((action) => action.description).sort().join('|');
    assert.ok(merchant !== settlement);
    assert.ok(settlement !== mobile);
    assert.ok(merchant !== mobile);
  });
});

describe('analysis staleness (INV-015)', () => {
  const edges: ReadonlyArray<DependencyEdge> = [
    edge('merchant-console', ['status'], strictPolicy),
    edge('settlement-worker', ['status'], strictPolicy)
  ];
  const computedAt = new Date('2026-06-01T00:00:00Z');
  const impacts = analyzeImpact({ diff, edges, providerTeamId: teamId('team-payments') }).impacts;
  const snapshot = pinImpactAnalysis({ proposalId: changeProposalId('p-1'), computedBy: human, computedAt, edges, impacts });

  it('is fresh when nothing changed', () => {
    assert.equal(isImpactAnalysisStale(snapshot, edges).stale, false);
  });

  it('goes stale when an edge is re-confirmed after computation', () => {
    const reconfirmed: ReadonlyArray<DependencyEdge> = [
      edges[0] as DependencyEdge,
      { ...(edges[1] as DependencyEdge), confirmedAt: new Date('2026-07-01T00:00:00Z') }
    ];
    const check = isImpactAnalysisStale(snapshot, reconfirmed);
    assert.equal(check.stale, true);
    assert.ok(check.reasons.some((reason) => /re-confirmed/u.test(reason)));
  });

  it('goes stale when a new consumer registers', () => {
    const withNew = [...edges, edge('new-consumer', ['status'], strictPolicy, { confirmedAt: new Date('2026-08-01T00:00:00Z') })];
    const check = isImpactAnalysisStale(snapshot, withNew);
    assert.equal(check.stale, true);
    assert.ok(check.reasons.some((reason) => /new consumer dependency/u.test(reason)));
  });

  it('goes stale when context items are corrected after computation', () => {
    const check = isImpactAnalysisStale(snapshot, edges, new Date('2026-06-02T00:00:00Z'));
    assert.equal(check.stale, true);
    assert.ok(check.reasons.some((reason) => /context items were corrected/u.test(reason)));
  });
});

describe('impact analysis recording service', () => {

  it('records a fresh snapshot and rejects a stale one', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p-imp1');
    await service.openChangeProposal({ actor: human, proposalId: proposal, contractId: apiContractId('c-imp1'), title: 'x' });
    // An edge exists in the ledger but is missing from the snapshot -> stale.
    await store.append({
      actor: human,
      correlationId: 'c',
      event: { type: 'DependencyEdgeDeclared', edgeId: dependencyEdgeId('edge-merchant-console'), consumerServiceId: serviceId('merchant-console'), operationId: operationId('contract-payments:GET:/payments/{paymentId}'), usage: { fields: ['status'], statusValues: [], enumNullability: [], errorMeanings: [], orderingConsistencySideEffects: [] }, compatibility: strictPolicy, source: 'explicit', criticality: 'high' }
    });

    const staleSnapshot = pinImpactAnalysis({ proposalId: proposal, computedBy: human, computedAt: new Date(), edges: [], impacts: [] });
    let rejected = false;
    try {
      await service.recordImpactAnalysis({ actor: human, proposalId: proposal, snapshot: staleSnapshot });
    } catch (error) {
      rejected = error instanceof DomainRuleError && /stale/u.test(error.message);
    }
    assert.ok(rejected, 'stale snapshot must be rejected');

    // Compute from the ledger's current edges, as a real caller would.
    const ledgerEdges = allDependencyEdges(await store.getAll());
    const freshSnapshot = pinImpactAnalysis({ proposalId: proposal, computedBy: human, computedAt: new Date(), edges: ledgerEdges, impacts: [] });
    const recorded = await service.recordImpactAnalysis({ actor: human, proposalId: proposal, snapshot: freshSnapshot });
    assert.ok(recorded.version > 0);
    assert.ok((await store.getAll()).some((event) => event.event.type === 'ImpactAnalysisRecorded'));
  });

  it('requires reason and evidence for a human amendment (INV-012)', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p-imp2');
    await service.openChangeProposal({ actor: human, proposalId: proposal, contractId: apiContractId('c-imp2'), title: 'x' });

    assert.equal(canAmendImpactAnalysis({ reason: '', evidence: 'ev' }).ok, false);
    assert.equal(canAmendImpactAnalysis({ reason: 'risk accepted', evidence: '' }).ok, false);

    await service.amendImpactAnalysis({ actor: human, proposalId: proposal, reason: 'manual review overrides', evidence: 'decision dec-7' });
    assert.ok((await store.getAll()).some((event) => event.event.type === 'ImpactAnalysisAmended'));
  });
});
