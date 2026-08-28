import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CatalogService, DependencyService, DomainService, OpenApiImporter } from './index.js';
import { InMemoryEventStore } from './events.js';
import { changeProposalState, consumerReadinessFrom, proposalApprovalsFrom } from './projection.js';
import {
  apiContractId,
  changeProposalId,
  contractVersionId,
  dependencyEdgeId,
  contextItemId,
  decisionRecordId,
  discussionEntryId,
  operationId,
  organizationId,
  principalRef,
  serviceId,
  teamId
} from './primitives.js';

const org = organizationId('org-1');
const providerTeam = teamId('team-payments');
const payments = serviceId('payment-service');
const merchantConsole = serviceId('merchant-console');
const settlementWorker = serviceId('settlement-worker');
const mobileApp = serviceId('mobile-app');
const providerOwner = principalRef('human', 'payments-owner');
const merchantOwner = principalRef('human', 'merchant-owner');

describe('approvals (issue #9)', () => {
  it('acceptance without an explicit flag computes the requirement from the ledger', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p-a1');
    await service.openChangeProposal({ actor: providerOwner, proposalId: proposal, contractId: apiContractId('c-a1'), title: 'x' });
    await service.declareRequiredApprovers({ actor: providerOwner, proposalId: proposal, requiredApprovers: [providerOwner, merchantOwner] });
    await service.recordApproval({ actor: providerOwner, proposalId: proposal });

    // merchant-owner has NOT approved yet -> acceptance must be rejected.
    let blocked = false;
    try {
      await service.acceptChangeProposal({ actor: providerOwner, proposalId: proposal, openBlockingObjections: 0 });
    } catch (error) {
      blocked = error instanceof Error && /INV-005/.test(error.message);
    }
    assert.ok(blocked, 'missing required approver blocks acceptance');

    await service.recordApproval({ actor: merchantOwner, proposalId: proposal });
    const approvals = proposalApprovalsFrom(await store.getAll(), proposal);
    assert.equal(approvals.satisfied, true);
    assert.equal(approvals.missingApprovers.length, 0);
    const result = await service.acceptChangeProposal({ actor: providerOwner, proposalId: proposal, openBlockingObjections: 0 });
    assert.ok(result.version > 0);
  });

  it('a withdrawn approval no longer counts, keeping the requirement honest', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p-a2');
    await service.openChangeProposal({ actor: providerOwner, proposalId: proposal, contractId: apiContractId('c-a2'), title: 'x' });
    await service.declareRequiredApprovers({ actor: providerOwner, proposalId: proposal, requiredApprovers: [providerOwner] });
    await service.recordApproval({ actor: providerOwner, proposalId: proposal, comment: 'looks good' });
    await service.withdrawApproval({ actor: providerOwner, proposalId: proposal, reason: 'changed my mind' });

    const approvals = proposalApprovalsFrom(await store.getAll(), proposal);
    assert.equal(approvals.satisfied, false, 'withdrawn approval is not counted');
    assert.equal(approvals.missingApprovers.length, 1);
  });

  it('blocks version publishing without full approval but allows it after acceptance (INV-001, INV-005)', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p-a3');
    const contract = apiContractId('c-a3');
    await service.openChangeProposal({ actor: providerOwner, proposalId: proposal, contractId: contract, title: 'Add REVERSED' });
    await service.declareRequiredApprovers({ actor: providerOwner, proposalId: proposal, requiredApprovers: [providerOwner] });

    let blocked = false;
    try {
      await service.publishContractVersion({
        actor: providerOwner,
        versionId: contractVersionId('c-a3@rev-2'),
        contractId: contract,
        sourceRevision: 'rev-2',
        checksum: 'cs-2',
        proposalId: proposal
      });
    } catch (error) {
      blocked = error instanceof Error && (/INV-001/.test(error.message) || /INV-005/.test(error.message));
    }
    assert.ok(blocked, 'publishing through an un-accepted proposal is rejected');

    await service.recordApproval({ actor: providerOwner, proposalId: proposal });
    await service.acceptChangeProposal({ actor: providerOwner, proposalId: proposal, openBlockingObjections: 0 });
    const published = await service.publishContractVersion({
      actor: providerOwner,
      versionId: contractVersionId('c-a3@rev-2'),
      contractId: contract,
      sourceRevision: 'rev-2',
      checksum: 'cs-2',
      proposalId: proposal
    });
    assert.ok(published.version > 0, 'publishing succeeds after acceptance with approvals');
  });
});

describe('per-consumer readiness (issue #9)', () => {
  it('tracks per-consumer readiness, deadlines and acknowledgement separately', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p-r1');
    await service.openChangeProposal({ actor: providerOwner, proposalId: proposal, contractId: apiContractId('c-r1'), title: 'x' });

    await service.declareConsumerReadiness({ actor: merchantOwner, proposalId: proposal, consumerServiceId: merchantConsole, ready: false });
    await service.declareConsumerReadiness({
      actor: merchantOwner,
      proposalId: proposal,
      consumerServiceId: settlementWorker,
      ready: true,
      deadline: new Date('2026-12-01'),
      evidenceRef: 'pr-42'
    });
    await service.acknowledgeConsumerMigration({ actor: merchantOwner, proposalId: proposal, consumerServiceId: settlementWorker });

    const readiness = consumerReadinessFrom(await store.getAll(), proposal);
    const merchant = readiness.find((r) => r.consumerServiceId === merchantConsole);
    const settlement = readiness.find((r) => r.consumerServiceId === settlementWorker);
    assert.ok(merchant);
    assert.equal(merchant.ready, false, 'a consumer that declared not-ready is not silently ready');
    assert.ok(settlement);
    assert.equal(settlement.ready, true);
    assert.equal(settlement.acknowledged, true);
    assert.equal(settlement.deadline?.toISOString(), new Date('2026-12-01').toISOString());
    assert.equal(settlement.evidenceRef, 'pr-42');
  });

  it('records the reason for a state transition in the ledger', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const proposal = changeProposalId('p-r2');
    await service.openChangeProposal({ actor: providerOwner, proposalId: proposal, contractId: apiContractId('c-r2'), title: 'x' });
    await service.rejectProposal({ actor: providerOwner, proposalId: proposal, reason: 'wrong direction for v1' });
    const rejected = (await store.getAll()).find((e) => e.event.type === 'ChangeProposalRejected');
    assert.ok(rejected);
    if (rejected && rejected.event.type === 'ChangeProposalRejected') {
      assert.equal(rejected.event.reason, 'wrong direction for v1');
    }
  });
});

describe('REVERSED scenario E2E: Draft to Completed (issue #9, #22)', () => {
  it('reproduces the baseline scenario end to end', async () => {
    const store = new InMemoryEventStore();
    const catalog = new CatalogService(store);
    const dependencies = new DependencyService(store);
    const service = new DomainService(store);

    // 1. Register the provider and consumers.
    await catalog.registerService({
      actor: providerOwner,
      serviceId: payments,
      organizationId: org,
      owningTeamId: providerTeam,
      name: 'payment-service',
      kind: 'provider'
    });
    for (const consumer of [merchantConsole, settlementWorker, mobileApp]) {
      await catalog.registerService({
        actor: providerOwner,
        serviceId: consumer,
        organizationId: org,
        owningTeamId: providerTeam,
        name: consumer,
        kind: 'consumer'
      });
    }

    // 2. Import the current contract (v1: PENDING/APPROVED/CANCELLED only).
    const contract = apiContractId('contract-payments');
    await catalog.importContract({
      actor: providerOwner,
      contractId: contract,
      organizationId: org,
      providerServiceId: payments,
      importer: new OpenApiImporter(),
      source: {
        info: { title: 'Payment API' },
        paths: {
          '/payments/{id}': {
            get: {
              responses: {
                '200': {
                  description: 'payment',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['id', 'status'],
                        properties: {
                          id: { type: 'string' },
                          status: { type: 'string', enum: ['PENDING', 'APPROVED', 'CANCELLED'] },
                          approvedAt: { type: 'string', nullable: true }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      importSource: 'repo:payment-service/openapi.yaml'
    });

    // 3. Consumers declare their dependencies and hidden assumptions.
    await dependencies.declareDependency({
      actor: merchantOwner,
      edgeId: dependencyEdgeId('edge-merchant'),
      consumerServiceId: merchantConsole,
      operationId: operationId('contract-payments:GET:/payments/:id'),
      usage: {
        fields: ['id', 'status', 'approvedAt'],
        statusValues: ['PENDING', 'APPROVED', 'CANCELLED'],
        enumNullability: [],
        errorMeanings: ['404 means payment not created'],
        orderingConsistencySideEffects: []
      },
      compatibility: { allowAdditiveFields: true, allowNewEnumValues: false, allowNullableChange: false },
      criticality: 'high',
      source: 'explicit',
      assumptions: [
        { statement: 'status APPROVED always implies approvedAt exists', source: 'explicit', confidence: 'confirmed', conflictStatus: 'none' }
      ]
    });
    await dependencies.declareDependency({
      actor: merchantOwner,
      edgeId: dependencyEdgeId('edge-settlement'),
      consumerServiceId: settlementWorker,
      operationId: operationId('contract-payments:GET:/payments/:id'),
      usage: {
        fields: ['status'],
        statusValues: ['PENDING', 'APPROVED', 'CANCELLED'],
        enumNullability: [],
        errorMeanings: [],
        orderingConsistencySideEffects: ['settlement runs once per status']
      },
      compatibility: { allowAdditiveFields: true, allowNewEnumValues: false, allowNullableChange: false },
      criticality: 'critical',
      source: 'code-analysis',
      assumptions: [
        { statement: 'status enum is exhaustive with no default case', source: 'code-analysis', confidence: 'inferred', conflictStatus: 'none' }
      ]
    });

    // 4. Context: the shared assumption is recorded with source and author.
    const contextItem = contextItemId('ctx-reversed-1');
    await store.append({
      actor: merchantOwner,
      correlationId: 'e2e',
      event: {
        type: 'ContextProposed',
        contextItemId: contextItem,
        scope: 'operation',
        statement: 'status APPROVED always implies approvedAt exists',
        contextType: 'assumption',
        author: merchantOwner,
        source: 'merchant-console/usage.yaml',
        confidence: 'unverified'
      }
    });

    // 5. The change proposal is opened (Draft -> Opened).
    const proposal = changeProposalId('proposal-reversed');
    await service.openChangeProposal({ actor: providerOwner, proposalId: proposal, contractId: contract, title: 'Add REVERSED to PaymentStatus' });

    // 6. Each consumer takes a separate position.
    const merchantEntry = discussionEntryId('entry-merchant');
    const settlementEntry = discussionEntryId('entry-settlement');
    const mobileEntry = discussionEntryId('entry-mobile');
    await service.createDiscussionEntry({
      actor: principalRef('service', 'merchant-console'),
      entryId: merchantEntry,
      proposalId: proposal,
      kind: 'objection',
      body: 'merchant-console parser rejects unknown enum values',
      isBlockingObjection: true,
      affectedConsumers: [merchantConsole],
      severity: 'high'
    });
    await service.raiseBlockingObjection({ actor: providerOwner, entryId: merchantEntry, proposalId: proposal });
    await service.createDiscussionEntry({
      actor: principalRef('service', 'settlement-worker'),
      entryId: settlementEntry,
      proposalId: proposal,
      kind: 'objection',
      body: 'settlement-worker switch has no default and fails on unknown values',
      isBlockingObjection: true,
      affectedConsumers: [settlementWorker],
      severity: 'critical'
    });
    await service.raiseBlockingObjection({ actor: providerOwner, entryId: settlementEntry, proposalId: proposal });
    await service.createDiscussionEntry({
      actor: principalRef('service', 'mobile-app'),
      entryId: mobileEntry,
      proposalId: proposal,
      kind: 'alternative',
      body: 'map REVERSED to CANCELLED for old mobile clients',
      affectedConsumers: [mobileApp],
      severity: 'medium'
    });

    // 7. Acceptance is blocked while blocking objections remain open.
    let blocked = false;
    try {
      await service.acceptChangeProposal({ actor: providerOwner, proposalId: proposal, openBlockingObjections: 2 });
    } catch (error) {
      blocked = error instanceof Error && /INV-005/.test(error.message);
    }
    assert.ok(blocked, 'acceptance blocked by two open blocking objections');

    // 8. The discussion is resolved and a decision is recorded with source links.
    await service.resolveBlockingObjection({ actor: providerOwner, entryId: merchantEntry, proposalId: proposal });
    await service.resolveDiscussionEntry({ actor: merchantOwner, entryId: merchantEntry, proposalId: proposal, status: 'resolved' });
    await service.resolveBlockingObjection({ actor: providerOwner, entryId: settlementEntry, proposalId: proposal });
    await service.resolveDiscussionEntry({ actor: merchantOwner, entryId: settlementEntry, proposalId: proposal, status: 'resolved' });
    const decision = decisionRecordId('decision-reversed-mapping');
    await service.recordDecision({
      actor: providerOwner,
      decisionRecordId: decision,
      proposalId: proposal,
      decision: 'Add REVERSED; gateway maps it to CANCELLED for mobile-app until 2 releases',
      rationale: 'old clients cannot update immediately; settlement needs an explicit new status',
      constraints: ['mobile mapping removal after 2 releases'],
      rejectedAlternatives: [{ alternative: 'ship REVERSED without mapping', reason: 'mobile-app old versions break' }],
      approvers: [providerOwner, merchantOwner],
      validFrom: new Date('2026-09-01'),
      sourceEntryIds: [merchantEntry, settlementEntry, mobileEntry]
    });

    // 9. Required approvers approve, then the proposal is accepted.
    await service.declareRequiredApprovers({
      actor: providerOwner,
      proposalId: proposal,
      requiredApprovers: [providerOwner, merchantOwner]
    });
    await service.recordApproval({ actor: providerOwner, proposalId: proposal });
    await service.recordApproval({ actor: merchantOwner, proposalId: proposal, comment: 'mapping accepted' });
    await service.acceptChangeProposal({ actor: providerOwner, proposalId: proposal, openBlockingObjections: 0 });

    // 10. The new contract version is published through the accepted proposal.
    await service.publishContractVersion({
      actor: providerOwner,
      versionId: contractVersionId('contract-payments@rev-2'),
      contractId: contract,
      sourceRevision: 'rev-2',
      checksum: 'cs-reversed',
      proposalId: proposal,
      decisionRecordId: decision
    });

    // 11. Independent lifecycle states are recorded one by one.
    await service.recordProviderImplementation({ actor: providerOwner, proposalId: proposal, reason: 'serializer updated' });
    const intermediate = changeProposalState(await store.getAll(), proposal);
    assert.ok(intermediate);
    assert.equal(intermediate.accepted, true);
    assert.equal(intermediate.implemented, true);
    assert.equal(intermediate.deployed, false, 'implementation does not imply deployment');

    await service.declareConsumerReadiness({ actor: merchantOwner, proposalId: proposal, consumerServiceId: merchantConsole, ready: true, deadline: new Date('2026-10-01') });
    await service.declareConsumerReadiness({ actor: merchantOwner, proposalId: proposal, consumerServiceId: settlementWorker, ready: true, deadline: new Date('2026-10-15') });
    await service.declareConsumerReadiness({ actor: merchantOwner, proposalId: proposal, consumerServiceId: mobileApp, ready: false, deadline: new Date('2027-02-01'), evidenceRef: 'mobile-release-214' });
    await service.recordContractVerification({ actor: providerOwner, proposalId: proposal, reason: 'contract tests pass' });
    await service.recordDeployment({ actor: providerOwner, proposalId: proposal, reason: 'canary to staging' });
    await service.recordObservation({ actor: providerOwner, proposalId: proposal, reason: 'no unknown-enum parse errors in observation window' });
    await service.recordConsumerMigrationComplete({ actor: providerOwner, proposalId: proposal });

    // mobile-app is still not ready, so completion is blocked (INV-006 honesty).
    let completionBlocked = false;
    try {
      await service.completeProposal({ actor: providerOwner, proposalId: proposal });
    } catch (error) {
      completionBlocked = error instanceof Error && /INV-006/.test(error.message);
    }
    assert.ok(completionBlocked, 'completion blocked while a consumer has not migrated');

    // mobile-app acknowledges its migration, then the proposal completes.
    await service.acknowledgeConsumerMigration({ actor: merchantOwner, proposalId: proposal, consumerServiceId: mobileApp });
    await service.declareConsumerReadiness({ actor: merchantOwner, proposalId: proposal, consumerServiceId: mobileApp, ready: true, evidenceRef: 'mobile-release-218' });
    const completed = await service.completeProposal({ actor: providerOwner, proposalId: proposal });
    assert.ok(completed.version > 0, 'proposal completed');

    // Final assertions: every actor and transition is in the ledger.
    const all = await store.getAll();
    assert.ok(all.some((e) => e.event.type === 'ServiceRegistered'));
    assert.ok(all.some((e) => e.event.type === 'ContractImported' || e.event.type === 'ApiContractImported'));
    assert.ok(all.some((e) => e.event.type === 'OperationImported'));
    assert.ok(all.some((e) => e.event.type === 'DependencyEdgeDeclared'));
    assert.ok(all.some((e) => e.event.type === 'ContextProposed'));
    assert.ok(all.some((e) => e.event.type === 'ChangeProposalOpened'));
    assert.ok(all.some((e) => e.event.type === 'DecisionRecorded'));
    assert.ok(all.some((e) => e.event.type === 'ChangeProposalAccepted'));
    assert.ok(all.some((e) => e.event.type === 'ContractVersionPublished'));
    assert.ok(all.some((e) => e.event.type === 'ChangeProposalCompleted'));
    assert.ok(all.every((e) => e.actor !== undefined), 'every mutation is attributed to a principal');
  });
});
