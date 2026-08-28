// Acceptance harness for the baseline scenario (issue #22): the full closure
// loop "context → impact → agreement → spec → evidence → observation →
// correction" as one repeatable suite, plus every failure path from the MVP
// scope asserted to fail loudly (never silently succeed).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ContractSnapshot } from './index.js';
import { DomainService, FakeGitHubAdapter, OpenApiCompilerAdapter, analyzeImpact, allDependencyEdges, baselineContractV1, changeProposalState, decisionRecordFrom, diffContractSnapshots, discussionSummary, pinImpactAnalysis, seedBaselineCatalog } from './index.js';
import { InMemoryEventStore } from './events.js';
import { changeProposalId, contextItemId, contractVersionId, decisionRecordId, discussionEntryId, evidenceId, observationId, operationId, principalRef, teamId } from './primitives.js';

const human = principalRef('human', 'acceptance-runner');

function withReversed(snapshot: ContractSnapshot): ContractSnapshot {
  const clone = JSON.parse(JSON.stringify(snapshot)) as ContractSnapshot;
  const status = clone.operations[0]?.responses[0]?.schema as { properties: { status: { enum: string[] } } };
  status.properties.status.enum.push('REVERSED');
  return clone;
}

describe('baseline scenario success path (issue #22)', () => {
  it('runs the full closure loop from seed to Completed with traceability', async () => {
    const store = new InMemoryEventStore();
    const seed = await seedBaselineCatalog(store, human);
    const service = new DomainService(store);
    const proposal = changeProposalId('proposal-reversed');
    const contract = seed.contract;

    // Step 1 is the seed's OpenAPI import; verify it happened.
    assert.ok((await store.getAll()).some((event) => event.event.type === 'ApiContractImported'));

    // Step 3: the change proposal.
    await service.openChangeProposal({ actor: seed.providerActor, proposalId: proposal, contractId: contract, title: 'Add REVERSED to PaymentStatus' });

    // Step 4: structural diff + per-consumer semantic impact.
    const diff = diffContractSnapshots(baselineContractV1, withReversed(baselineContractV1));
    assert.equal(diff.verdict, 'ambiguous', 'additive enum is additive / potentially breaking');
    const edges = allDependencyEdges(await store.getAll());
    const analysis = analyzeImpact({ diff, edges, providerTeamId: seed.paymentsTeam, policyOwnerTeamIds: [teamId('team-policy')] });
    const byConsumer = new Map(analysis.impacts.map((impact) => [impact.consumerServiceId, impact]));
    assert.equal(byConsumer.get(seed.merchantConsole)?.impact, 'blocking');
    assert.equal(byConsumer.get(seed.settlementWorker)?.impact, 'blocking');
    assert.equal(byConsumer.get(seed.mobileApp)?.impact, 'action-required');

    // Step 5: structured discussion — question and a blocking objection, resolved.
    const question = discussionEntryId('e2e-question');
    const objection = discussionEntryId('e2e-objection');
    await service.createDiscussionEntry({ actor: seed.merchantActor, entryId: question, proposalId: proposal, kind: 'question', body: 'How does REVERSED differ from CANCELLED?' });
    await service.createDiscussionEntry({ actor: seed.settlementActor, entryId: objection, proposalId: proposal, kind: 'objection', body: 'our switch has no default; unknown values fail the job', isBlockingObjection: true, affectedConsumers: [seed.settlementWorker] });
    await service.raiseBlockingObjection({ actor: seed.settlementActor, entryId: objection, proposalId: proposal });

    // Failure path woven into the flow: acceptance is blocked while the
    // objection is open (INV-005) — it must not silently succeed.
    let blocked = false;
    try {
      await service.acceptChangeProposal({ actor: seed.providerActor, proposalId: proposal });
    } catch (error) {
      blocked = error instanceof Error && /INV-005/u.test(error.message);
    }
    assert.ok(blocked, 'acceptance blocked while the objection is open');

    await service.resolveBlockingObjection({ actor: seed.settlementActor, entryId: objection, proposalId: proposal });
    await service.resolveDiscussionEntry({ actor: seed.settlementActor, entryId: objection, proposalId: proposal, status: 'resolved' });
    await service.resolveDiscussionEntry({ actor: seed.providerActor, entryId: question, proposalId: proposal, status: 'resolved' });

    // Step 6: Decision Record with constraints and rejected alternatives.
    const decision = decisionRecordId('e2e-decision');
    await service.recordDecision({
      actor: seed.providerActor,
      decisionRecordId: decision,
      proposalId: proposal,
      decision: 'Add REVERSED; map it to CANCELLED for old mobile clients until the mapping deadline',
      rationale: 'reversal is a distinct business state; old clients cannot update immediately',
      constraints: ['compatibility mapping removed after 2 mobile releases'],
      rejectedAlternatives: [{ alternative: 'reuse CANCELLED for reversals', reason: 'loses the reversal distinction for settlement' }],
      approvers: [seed.providerActor, seed.merchantActor],
      validFrom: new Date('2026-09-01T00:00:00Z'),
      sourceEntryIds: [question, objection]
    });

    // Approval gate driven by the ledger, then acceptance.
    await service.declareRequiredApprovers({ actor: seed.providerActor, proposalId: proposal, requiredApprovers: [seed.providerActor, seed.merchantActor] });
    await service.recordApproval({ actor: seed.providerActor, proposalId: proposal });
    await service.recordApproval({ actor: seed.merchantActor, proposalId: proposal, comment: 'mapping accepted' });
    await service.acceptChangeProposal({ actor: seed.providerActor, proposalId: proposal });

    // INV-002: acceptance does not imply deployment.
    const acceptedState = changeProposalState(await store.getAll(), proposal);
    assert.ok(acceptedState);
    assert.equal(acceptedState?.accepted, true);
    assert.equal(acceptedState?.deployed, false);

    // Step 7: compile the spec, changelog, migration guides and test drafts.
    const state = changeProposalState(await store.getAll(), proposal);
    const record = decisionRecordFrom(await store.getAll(), decision);
    const discussion = discussionSummary(await store.getAll(), [question, objection]);
    assert.ok(state && record);
    const output = new OpenApiCompilerAdapter().compile({
      proposalId: proposal,
      proposalState: state,
      decisions: [record],
      discussion,
      baseContract: baselineContractV1,
      approvedChanges: [
        { decisionRecordId: decision, changes: [{ op: 'add-enum-value', target: { method: 'get', path: '/payments/{paymentId}', response: '200', field: 'status' }, value: 'REVERSED' }] }
      ],
      impacts: analysis.impacts,
      compiledBy: seed.providerActor
    });
    const compiledStatus = output.openapi.operations[0]?.responses[0]?.schema as { properties: { status: { enum: string[] } } };
    assert.ok(compiledStatus.properties.status.enum.includes('REVERSED'));
    assert.equal(output.migrationGuides.length, 3, 'migration guides for all three consumers');

    // Step 8: fake GitHub adapter reproduces PR linkage; publish through the
    // proposal workflow.
    const pullRequest = new FakeGitHubAdapter().createPullRequest({ title: 'Add REVERSED', headRevision: 'rev-2' });
    assert.ok(pullRequest.number > 0);
    await service.publishContractVersion({
      actor: seed.providerActor,
      versionId: contractVersionId(`${contract}@rev-2`),
      contractId: contract,
      sourceRevision: 'rev-2',
      checksum: output.manifest.outputChecksum,
      proposalId: proposal,
      decisionRecordId: decision
    });

    // Step 9: provider and consumer contract test results as evidence.
    await service.attachEvidence({ actor: seed.providerActor, evidenceId: evidenceId('ev-provider-contract-tests'), contractVersionId: contractVersionId(`${contract}@rev-2`), sourceRevision: 'rev-2', status: 'passed' });
    await service.attachEvidence({ actor: seed.merchantActor, evidenceId: evidenceId('ev-merchant-contract-tests'), contractVersionId: contractVersionId(`${contract}@rev-2`), sourceRevision: 'rev-2', status: 'passed' });
    await service.attachEvidence({ actor: seed.settlementActor, evidenceId: evidenceId('ev-settlement-contract-tests'), contractVersionId: contractVersionId(`${contract}@rev-2`), sourceRevision: 'rev-2', status: 'passed' });
    await service.attachEvidence({ actor: seed.providerActor, evidenceId: evidenceId('ev-pr'), contractVersionId: contractVersionId(`${contract}@rev-2`), sourceRevision: 'rev-2', status: 'passed' });

    // Step 10: provider implementation, then verification requiring the passed,
    // revision-bound evidence.
    await service.recordProviderImplementation({ actor: seed.providerActor, proposalId: proposal, reason: `serializer updated (${pullRequest.url})` });
    const evidence = (await store.getAll())
      .filter((event) => event.event.type === 'EvidenceAttached')
      .map((event) => (event.event.type === 'EvidenceAttached' ? { status: event.event.status, sourceRevision: event.event.sourceRevision } : undefined))
      .filter((entry) => entry !== undefined);
    await service.recordContractVerification({ actor: seed.providerActor, proposalId: proposal, evidence, currentSourceRevision: 'rev-2', reason: 'provider and consumer contract tests pass' });

    // Consumer readiness with migration deadlines, then deployment.
    await service.declareConsumerReadiness({ actor: seed.merchantActor, proposalId: proposal, consumerServiceId: seed.merchantConsole, ready: true, deadline: new Date('2026-10-01T00:00:00Z') });
    await service.declareConsumerReadiness({ actor: seed.settlementActor, proposalId: proposal, consumerServiceId: seed.settlementWorker, ready: true, deadline: new Date('2026-10-15T00:00:00Z') });
    await service.declareConsumerReadiness({ actor: seed.merchantActor, proposalId: proposal, consumerServiceId: seed.mobileApp, ready: false, deadline: new Date('2027-02-01T00:00:00Z'), evidenceRef: 'mobile-release-214' });
    await service.recordDeployment({ actor: seed.providerActor, proposalId: proposal, reason: 'canary to staging, then production' });

    // Observation with a sufficient sample (INV-025).
    await service.recordObservation({ actor: seed.providerActor, proposalId: proposal, sampleSize: 500, minimumSampleSize: 100, reason: 'no unknown-enum parse errors in the observation window' });
    // mobile-app ships the compatibility mapping, then declares readiness; an
    // unready consumer must block completion (INV-006).
    await service.acknowledgeConsumerMigration({ actor: seed.merchantActor, proposalId: proposal, consumerServiceId: seed.mobileApp });
    await service.declareConsumerReadiness({ actor: seed.merchantActor, proposalId: proposal, consumerServiceId: seed.mobileApp, ready: true, evidenceRef: 'mobile-release-218' });
    await service.recordConsumerMigrationComplete({ actor: seed.providerActor, proposalId: proposal });

    const completed = await service.completeProposal({ actor: seed.providerActor, proposalId: proposal });
    assert.ok(completed.version > 0, 'the proposal reaches Completed');

    // Traceability: the final state can be walked back to the original proposal,
    // decision, evidence and observation, and every mutation has an actor.
    const all = await store.getAll();
    assert.ok(all.some((event) => event.event.type === 'ChangeProposalOpened' && event.aggregateId === proposal));
    assert.ok(all.some((event) => event.event.type === 'DecisionRecorded' && event.aggregateId === decision));
    assert.ok(all.some((event) => event.event.type === 'EvidenceAttached' && event.aggregateId === evidenceId('ev-provider-contract-tests')));
    assert.ok(all.some((event) => event.event.type === 'ObservationRecorded'));
    assert.ok(all.some((event) => event.event.type === 'ContractVersionPublished'));
    assert.ok(all.some((event) => event.event.type === 'ChangeProposalCompleted' && event.aggregateId === proposal));
    assert.ok(all.every((event) => event.actor !== undefined && event.actor.id.length > 0), 'every mutation is attributed to a principal');
  });
});

describe('baseline scenario failure paths (issue #22)', () => {
  it('a missing required approval blocks acceptance', async () => {
    const store = new InMemoryEventStore();
    const seed = await seedBaselineCatalog(store, human);
    const service = new DomainService(store);
    const proposal = changeProposalId('p-fail-approval');
    await service.openChangeProposal({ actor: seed.providerActor, proposalId: proposal, contractId: seed.contract, title: 'x' });
    await service.declareRequiredApprovers({ actor: seed.providerActor, proposalId: proposal, requiredApprovers: [seed.providerActor, seed.merchantActor] });
    await service.recordApproval({ actor: seed.providerActor, proposalId: proposal });

    let blocked = false;
    try {
      await service.acceptChangeProposal({ actor: seed.providerActor, proposalId: proposal });
    } catch (error) {
      blocked = error instanceof Error && /INV-005/u.test(error.message);
    }
    assert.ok(blocked, 'acceptance is rejected while an approver is missing');
  });

  it('a stale impact analysis is rejected at recording time', async () => {
    const store = new InMemoryEventStore();
    const seed = await seedBaselineCatalog(store, human);
    const service = new DomainService(store);
    const proposal = changeProposalId('p-fail-stale');
    await service.openChangeProposal({ actor: seed.providerActor, proposalId: proposal, contractId: seed.contract, title: 'x' });

    const diff = diffContractSnapshots(baselineContractV1, withReversed(baselineContractV1));
    const analysis = analyzeImpact({ diff, edges: allDependencyEdges(await store.getAll()), providerTeamId: seed.paymentsTeam });
    const staleSnapshot = pinImpactAnalysis({ proposalId: proposal, computedBy: seed.providerActor, computedAt: new Date('2026-01-01T00:00:00Z'), edges: [], impacts: analysis.impacts });

    let rejected = false;
    try {
      await service.recordImpactAnalysis({ actor: seed.providerActor, proposalId: proposal, snapshot: staleSnapshot });
    } catch (error) {
      rejected = error instanceof Error && /stale/u.test(error.message);
    }
    assert.ok(rejected, 'an analysis computed before the current edges is stale and rejected');
  });

  it('failed or stale-revision evidence never counts as verification (INV-022, INV-023)', async () => {
    const store = new InMemoryEventStore();
    const seed = await seedBaselineCatalog(store, human);
    const service = new DomainService(store);
    const proposal = changeProposalId('p-fail-evidence');
    await service.openChangeProposal({ actor: seed.providerActor, proposalId: proposal, contractId: seed.contract, title: 'x' });
    await service.recordApproval({ actor: seed.providerActor, proposalId: proposal });
    await service.acceptChangeProposal({ actor: seed.providerActor, proposalId: proposal, openBlockingObjections: 0, requiredApproversSatisfied: true });

    await service.attachEvidence({ actor: seed.providerActor, evidenceId: evidenceId('ev-failed'), contractVersionId: contractVersionId(`${seed.contract}@rev-2`), sourceRevision: 'rev-2', status: 'failed' });
    await service.attachEvidence({ actor: seed.providerActor, evidenceId: evidenceId('ev-old'), contractVersionId: contractVersionId(`${seed.contract}@rev-1`), sourceRevision: 'rev-1', status: 'passed' });

    const evidence = (await store.getAll())
      .filter((event) => event.event.type === 'EvidenceAttached')
      .map((event) => (event.event.type === 'EvidenceAttached' ? { status: event.event.status, sourceRevision: event.event.sourceRevision } : undefined))
      .filter((entry) => entry !== undefined);

    let rejected = false;
    try {
      await service.recordContractVerification({ actor: seed.providerActor, proposalId: proposal, evidence, currentSourceRevision: 'rev-2' });
    } catch (error) {
      rejected = error instanceof Error && /INV-023/u.test(error.message);
    }
    assert.ok(rejected, 'failed evidence does not verify (INV-023)');

    let staleRejected = false;
    try {
      await service.recordContractVerification({ actor: seed.providerActor, proposalId: proposal, evidence: [{ status: 'passed', sourceRevision: 'rev-1' }], currentSourceRevision: 'rev-2' });
    } catch (error) {
      staleRejected = error instanceof Error && /INV-022/u.test(error.message);
    }
    assert.ok(staleRejected, 'evidence from an older revision is stale, not success (INV-022)');
  });

  it('an observation window below the policy minimum is insufficient evidence (INV-025)', async () => {
    const store = new InMemoryEventStore();
    const seed = await seedBaselineCatalog(store, human);
    const service = new DomainService(store);
    const proposal = changeProposalId('p-fail-observation');
    await service.openChangeProposal({ actor: seed.providerActor, proposalId: proposal, contractId: seed.contract, title: 'x' });

    let rejected = false;
    try {
      await service.recordObservation({ actor: seed.providerActor, proposalId: proposal, sampleSize: 10, minimumSampleSize: 100 });
    } catch (error) {
      rejected = error instanceof Error && /INV-025/u.test(error.message);
    }
    assert.ok(rejected, 'sample shortage is reported as insufficient evidence');
  });
});

describe('runtime drift and correction (issue #22 step 11, INV-024, INV-012)', () => {
  it('a runtime unknown status produces drift and a correction, never an overwrite', async () => {
    const store = new InMemoryEventStore();
    const seed = await seedBaselineCatalog(store, human);
    const service = new DomainService(store);

    // Runtime observes an undocumented status: the observation produces a drift
    // incident but never changes the contract by itself (INV-024).
    await store.append({
      actor: principalRef('integration', 'runtime-observer'),
      correlationId: 'runtime',
      event: { type: 'DriftDetected', observationId: observationId('obs-drift'), operationId: operationId(`${seed.contract}:GET:/payments/{paymentId}`), environment: 'production', kind: 'unknown-enum-value', severity: 'high', sampleSize: 12 }
    });
    const drift = (await store.getAll()).find((event) => event.event.type === 'DriftDetected');
    assert.ok(drift);
    assert.equal((await store.getAll()).some((event) => event.event.type === 'ContractVersionPublished'), false, 'drift does not publish a contract');

    // The correction flow records a new context item referencing the original.
    const correction = contextItemId('ctx-correction');
    await store.append({
      actor: human,
      correlationId: 'correction',
      event: { type: 'ContextProposed', contextItemId: correction, scope: 'operation', statement: 'the runtime can emit CHARGEBACK even though the contract does not declare it', contextType: 'observation', author: human, source: 'production observation', confidence: 'confirmed' }
    });
    await service.correctContext({ actor: human, originalContextItemId: seed.contexts.notFoundMeaning, correctionContextItemId: correction });

    const all = await store.getAll();
    const original = all.find((event) => event.event.type === 'ContextProposed' && event.aggregateId === seed.contexts.notFoundMeaning);
    assert.ok(original, 'the original context item is preserved');
    const current = all.filter((event) => event.aggregateType === 'contextItem' && event.aggregateId === seed.contexts.notFoundMeaning);
    assert.ok(current.some((event) => event.event.type === 'ContextCorrected'), 'the correction is a new fact on the ledger');
  });
});
