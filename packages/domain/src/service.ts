// Domain service layer: orchestrates invariant guards with the append-only event
// ledger. Each command loads the current state via projections, applies the
// corresponding guard from rules.ts, and only then appends an event through the
// EventStore port. Nothing here touches a database, HTTP layer, or external SDK
// (per AGENTS.md package responsibilities); it depends only on the EventStore
// port, projections, and guards — all framework-independent.
//
// All mutations carry an expectedVersion so the EventStore rejects lost updates
// under concurrency (optimistic concurrency, INV-035).

import type {
  ApiContractId,
  ChangeProposalId,
  ContextItemId,
  ContextScope,
  ContractVersionId,
  DecisionRecordId,
  DiscussionEntryId,
  PrincipalRef,
  ServiceId
} from './primitives.js';
import type { ChangeProposalState } from './model.js';
import type { AppendResult, AggregateType, EventStore } from './events.js';
import { changeProposalState, contextItemFrom } from './projection.js';
import {
  canAcceptProposal,
  canConfirmContext,
  canCorrectContext,
  canMarkCompleted,
  canRecordDecision,
  canPublishContractVersion
} from './rules.js';

// Raised when a command is rejected by a domain guard. Callers (API/MCP/worker)
// catch this to return a 4xx / structured rejection rather than crashing.
export class DomainRuleError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'DomainRuleError';
  }
}

export interface DomainServiceOptions {
  readonly defaultCorrelationId?: string;
}

export class DomainService {
  readonly #store: EventStore;
  readonly #defaultCorrelationId: string;

  constructor(store: EventStore, options: DomainServiceOptions = {}) {
    this.#store = store;
    this.#defaultCorrelationId = options.defaultCorrelationId ?? 'domain-service';
  }

  async openChangeProposal(input: {
    actor: PrincipalRef;
    correlationId?: string;
    proposalId: ChangeProposalId;
    contractId: ApiContractId;
    title: string;
  }): Promise<AppendResult> {
    return this.#append('changeProposal', input.proposalId, input.actor, input.correlationId, {
      type: 'ChangeProposalOpened',
      proposalId: input.proposalId,
      contractId: input.contractId,
      title: input.title
    });
  }

  // INV-005: blocked while a blocking objection is open or a required approver is missing.
  async acceptChangeProposal(input: {
    actor: PrincipalRef;
    correlationId?: string;
    proposalId: ChangeProposalId;
    openBlockingObjections: number;
    requiredApproversSatisfied: boolean;
  }): Promise<AppendResult> {
    const guard = canAcceptProposal({
      openBlockingObjections: input.openBlockingObjections,
      requiredApproversSatisfied: input.requiredApproversSatisfied
    });
    if (!guard.ok) {
      throw new DomainRuleError(guard.reason);
    }
    return this.#append('changeProposal', input.proposalId, input.actor, input.correlationId, {
      type: 'ChangeProposalAccepted',
      proposalId: input.proposalId
    });
  }

  async recordProviderImplementation(input: {
    actor: PrincipalRef;
    correlationId?: string;
    proposalId: ChangeProposalId;
  }): Promise<AppendResult> {
    return this.#append('changeProposal', input.proposalId, input.actor, input.correlationId, {
      type: 'ProviderImplementationRecorded',
      proposalId: input.proposalId
    });
  }

  async recordConsumerReadiness(input: {
    actor: PrincipalRef;
    correlationId?: string;
    proposalId: ChangeProposalId;
  }): Promise<AppendResult> {
    return this.#append('changeProposal', input.proposalId, input.actor, input.correlationId, {
      type: 'ConsumerReadinessRecorded',
      proposalId: input.proposalId
    });
  }

  async recordContractVerification(input: {
    actor: PrincipalRef;
    correlationId?: string;
    proposalId: ChangeProposalId;
  }): Promise<AppendResult> {
    return this.#append('changeProposal', input.proposalId, input.actor, input.correlationId, {
      type: 'ContractVerificationRecorded',
      proposalId: input.proposalId
    });
  }

  async recordDeployment(input: {
    actor: PrincipalRef;
    correlationId?: string;
    proposalId: ChangeProposalId;
  }): Promise<AppendResult> {
    return this.#append('changeProposal', input.proposalId, input.actor, input.correlationId, {
      type: 'DeploymentRecorded',
      proposalId: input.proposalId
    });
  }

  async recordObservation(input: {
    actor: PrincipalRef;
    correlationId?: string;
    proposalId: ChangeProposalId;
  }): Promise<AppendResult> {
    return this.#append('changeProposal', input.proposalId, input.actor, input.correlationId, {
      type: 'ObservationRecorded',
      proposalId: input.proposalId
    });
  }

  // INV-006: every confirmed consumer migration must complete before a proposal
  // can be marked Completed.
  async recordConsumerMigrationComplete(input: {
    actor: PrincipalRef;
    correlationId?: string;
    proposalId: ChangeProposalId;
  }): Promise<AppendResult> {
    return this.#append('changeProposal', input.proposalId, input.actor, input.correlationId, {
      type: 'ConsumerMigrationCompleted',
      proposalId: input.proposalId
    });
  }

  // INV-002 + INV-006: requires acceptance and every independent lifecycle state,
  // plus confirmed consumer migration complete.
  async completeProposal(input: {
    actor: PrincipalRef;
    correlationId?: string;
    proposalId: ChangeProposalId;
  }): Promise<AppendResult> {
    const state = await this.#proposalState(input.proposalId);
    const guard = canMarkCompleted(state);
    if (!guard.ok) {
      throw new DomainRuleError(guard.reason);
    }
    return this.#append('changeProposal', input.proposalId, input.actor, input.correlationId, {
      type: 'ChangeProposalCompleted',
      proposalId: input.proposalId
    });
  }

  async rejectProposal(input: {
    actor: PrincipalRef;
    correlationId?: string;
    proposalId: ChangeProposalId;
  }): Promise<AppendResult> {
    return this.#append('changeProposal', input.proposalId, input.actor, input.correlationId, {
      type: 'ChangeProposalRejected',
      proposalId: input.proposalId
    });
  }

  async withdrawProposal(input: {
    actor: PrincipalRef;
    correlationId?: string;
    proposalId: ChangeProposalId;
  }): Promise<AppendResult> {
    return this.#append('changeProposal', input.proposalId, input.actor, input.correlationId, {
      type: 'ChangeProposalWithdrawn',
      proposalId: input.proposalId
    });
  }

  // INV-011: a confirmed context requires source, author, and a valid-from time.
  async confirmContext(input: {
    actor: PrincipalRef;
    correlationId?: string;
    contextItemId: ContextItemId;
    validFrom: Date;
    source: string;
  }): Promise<AppendResult> {
    const guard = canConfirmContext({
      source: input.source,
      author: input.actor,
      scope: 'operation',
      validFrom: input.validFrom
    });
    if (!guard.ok) {
      throw new DomainRuleError(guard.reason);
    }
    return this.#append('contextItem', input.contextItemId, input.actor, input.correlationId, {
      type: 'ContextConfirmed',
      contextItemId: input.contextItemId,
      validFrom: input.validFrom
    });
  }

  // INV-012: correction never destroys the past; it produces a new item. The
  // original must not already be corrected.
  async correctContext(input: {
    actor: PrincipalRef;
    correlationId?: string;
    originalContextItemId: ContextItemId;
    correctionContextItemId: ContextItemId;
  }): Promise<AppendResult> {
    const original = await this.#contextItem(input.originalContextItemId);
    if (original === undefined) {
      throw new DomainRuleError('INV-012: original context item not found');
    }
    const guard = canCorrectContext(original);
    if (!guard.ok) {
      throw new DomainRuleError(guard.reason);
    }
    return this.#append('contextItem', input.originalContextItemId, input.actor, input.correlationId, {
      type: 'ContextCorrected',
      originalContextItemId: input.originalContextItemId,
      correctionContextItemId: input.correctionContextItemId
    });
  }

  // INV-003: a published contract version is immutable; publishing the same id is rejected.
  async publishContractVersion(input: {
    actor: PrincipalRef;
    correlationId?: string;
    versionId: ContractVersionId;
    contractId: ApiContractId;
    sourceRevision: string;
    checksum: string;
    decisionRecordId?: DecisionRecordId;
  }): Promise<AppendResult> {
    const existing = await this.#publishedVersionIds();
    const guard = canPublishContractVersion(existing, input.versionId);
    if (!guard.ok) {
      throw new DomainRuleError(guard.reason);
    }
    const event: Parameters<EventStore['append']>[0]['event'] =
      input.decisionRecordId === undefined
        ? {
            type: 'ContractVersionPublished',
            versionId: input.versionId,
            contractId: input.contractId,
            sourceRevision: input.sourceRevision,
            checksum: input.checksum
          }
        : {
            type: 'ContractVersionPublished',
            versionId: input.versionId,
            contractId: input.contractId,
            sourceRevision: input.sourceRevision,
            checksum: input.checksum,
            decisionRecordId: input.decisionRecordId
          };
    return this.#append('contractVersion', input.versionId, input.actor, input.correlationId, event);
  }

  async #append(
    aggregateType: AggregateType,
    aggregateId: string,
    actor: PrincipalRef,
    correlationId: string | undefined,
    event: Parameters<EventStore['append']>[0]['event']
  ): Promise<AppendResult> {
    const expectedVersion = await this.#currentVersion(aggregateType, aggregateId);
    return this.#store.append({
      actor,
      correlationId: correlationId ?? this.#defaultCorrelationId,
      event,
      expectedVersion
    });
  }

  async #currentVersion(aggregateType: AggregateType, aggregateId: string): Promise<number> {
    const stream = await this.#store.getStream(aggregateType, aggregateId);
    const last = stream[stream.length - 1];
    return last?.version ?? 0;
  }

  async #proposalState(proposalId: ChangeProposalId): Promise<ChangeProposalState> {
    const all = await this.#store.getAll();
    const state = changeProposalState(all, proposalId);
    if (state === undefined) {
      throw new DomainRuleError('Change proposal has not been opened');
    }
    return state;
  }

  async #contextItem(contextItemId: ContextItemId) {
    const all = await this.#store.getAll();
    return contextItemFrom(all, contextItemId);
  }

  async #publishedVersionIds(): Promise<ReadonlyArray<ContractVersionId>> {
    const all = await this.#store.getAll();
    return all
      .filter((envelope) => envelope.event.type === 'ContractVersionPublished')
      .map((envelope) => (envelope.event as { versionId: ContractVersionId }).versionId);
  }

  async challengeContext(input: {
    actor: PrincipalRef;
    correlationId?: string;
    contextItemId: ContextItemId;
    reason: string;
  }): Promise<AppendResult> {
    return this.#append('contextItem', input.contextItemId, input.actor, input.correlationId, {
      type: 'ContextChallenged',
      contextItemId: input.contextItemId,
      challenger: input.actor,
      reason: input.reason
    });
  }

  async narrowContextScope(input: {
    actor: PrincipalRef;
    correlationId?: string;
    contextItemId: ContextItemId;
    scope: ContextScope;
    previousScope: ContextScope;
  }): Promise<AppendResult> {
    return this.#append('contextItem', input.contextItemId, input.actor, input.correlationId, {
      type: 'ContextNarrowedScope',
      contextItemId: input.contextItemId,
      scope: input.scope,
      previousScope: input.previousScope
    });
  }

  async addContextEvidence(input: {
    actor: PrincipalRef;
    correlationId?: string;
    contextItemId: ContextItemId;
    evidenceRef: string;
  }): Promise<AppendResult> {
    return this.#append('contextItem', input.contextItemId, input.actor, input.correlationId, {
      type: 'ContextEvidenceAdded',
      contextItemId: input.contextItemId,
      evidenceRef: input.evidenceRef
    });
  }

  async expireContext(input: {
    actor: PrincipalRef;
    correlationId?: string;
    contextItemId: ContextItemId;
    at: Date;
  }): Promise<AppendResult> {
    return this.#append('contextItem', input.contextItemId, input.actor, input.correlationId, {
      type: 'ContextExpired',
      contextItemId: input.contextItemId,
      at: input.at
    });
  }

  async changeContextVisibility(input: {
    actor: PrincipalRef;
    correlationId?: string;
    contextItemId: ContextItemId;
    visibility: 'public' | 'organization' | 'team';
  }): Promise<AppendResult> {
    return this.#append('contextItem', input.contextItemId, input.actor, input.correlationId, {
      type: 'ContextVisibilityChanged',
      contextItemId: input.contextItemId,
      visibility: input.visibility
    });
  }

  // INV-014: a structured utterance keeps its type, links and source so a summary
  // can never silently drop it. A blocking objection feeds the proposal's counter.
  async createDiscussionEntry(input: {
    actor: PrincipalRef;
    correlationId?: string;
    entryId: DiscussionEntryId;
    proposalId: ChangeProposalId;
    kind: 'question' | 'proposal' | 'objection' | 'constraint' | 'assumption' | 'evidence' | 'alternative' | 'correction' | 'acknowledgement' | 'decision';
    body: string;
    isBlockingObjection?: boolean;
    affectedConsumers?: ReadonlyArray<ServiceId>;
    severity?: 'low' | 'medium' | 'high' | 'critical' | undefined;
    evidenceRef?: string | undefined;
    inReplyTo?: DiscussionEntryId | undefined;
    quotes?: DiscussionEntryId | undefined;
    duplicateOf?: DiscussionEntryId | undefined;
  }): Promise<AppendResult> {
    return this.#append('discussionEntry', input.entryId, input.actor, input.correlationId, {
      type: 'DiscussionEntryCreated',
      entryId: input.entryId,
      proposalId: input.proposalId,
      kind: input.kind,
      author: input.actor,
      body: input.body,
      isBlockingObjection: input.isBlockingObjection ?? false,
      affectedConsumers: input.affectedConsumers ?? [],
      severity: input.severity,
      evidenceRef: input.evidenceRef,
      inReplyTo: input.inReplyTo,
      quotes: input.quotes,
      duplicateOf: input.duplicateOf
    });
  }

  // Raises a blocking objection: it also increments the proposal's open-objection
  // counter so the acceptance guard (INV-005) sees it.
  async raiseBlockingObjection(input: {
    actor: PrincipalRef;
    correlationId?: string;
    entryId: DiscussionEntryId;
    proposalId: ChangeProposalId;
  }): Promise<AppendResult> {
    return this.#append('changeProposal', input.proposalId, input.actor, input.correlationId, {
      type: 'BlockingObjectionRaised',
      proposalId: input.proposalId,
      entryId: input.entryId
    });
  }

  async resolveDiscussionEntry(input: {
    actor: PrincipalRef;
    correlationId?: string;
    entryId: DiscussionEntryId;
    proposalId: ChangeProposalId;
    status: 'resolved' | 'wont-fix' | 'superseded';
  }): Promise<AppendResult> {
    return this.#append('discussionEntry', input.entryId, input.actor, input.correlationId, {
      type: 'DiscussionEntryResolved',
      entryId: input.entryId,
      proposalId: input.proposalId,
      status: input.status,
      resolvedBy: input.actor
    });
  }

  async resolveBlockingObjection(input: {
    actor: PrincipalRef;
    correlationId?: string;
    entryId: DiscussionEntryId;
    proposalId: ChangeProposalId;
  }): Promise<AppendResult> {
    return this.#append('changeProposal', input.proposalId, input.actor, input.correlationId, {
      type: 'BlockingObjectionResolved',
      proposalId: input.proposalId,
      entryId: input.entryId
    });
  }

  // INV-013: promotes a fixed decision (rationale, constraints, rejected
  // alternatives, approvers, validity) rather than a loose discussion summary.
  async recordDecision(input: {
    actor: PrincipalRef;
    correlationId?: string;
    decisionRecordId: DecisionRecordId;
    proposalId: ChangeProposalId;
    decision: string;
    rationale: string;
    constraints?: ReadonlyArray<string>;
    rejectedAlternatives?: ReadonlyArray<{ readonly alternative: string; readonly reason: string }>;
    approvers: ReadonlyArray<PrincipalRef>;
    validFrom: Date;
    validUntil?: Date | undefined;
    sourceEntryIds?: ReadonlyArray<DiscussionEntryId>;
    supersedes?: DecisionRecordId | undefined;
  }): Promise<AppendResult> {
    const guard = canRecordDecision({
      decision: input.decision,
      rationale: input.rationale,
      approvers: input.approvers,
      validFrom: input.validFrom
    });
    if (!guard.ok) {
      throw new DomainRuleError(guard.reason);
    }
    return this.#append('decisionRecord', input.decisionRecordId, input.actor, input.correlationId, {
      type: 'DecisionRecorded',
      decisionRecordId: input.decisionRecordId,
      proposalId: input.proposalId,
      decision: input.decision,
      rationale: input.rationale,
      constraints: input.constraints ?? [],
      rejectedAlternatives: input.rejectedAlternatives ?? [],
      approvers: input.approvers,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      sourceEntryIds: input.sourceEntryIds ?? [],
      supersedes: input.supersedes
    });
  }

  async supersedeDecision(input: {
    actor: PrincipalRef;
    correlationId?: string;
    originalDecisionRecordId: DecisionRecordId;
    supersedingDecisionRecordId: DecisionRecordId;
  }): Promise<AppendResult> {
    return this.#append('decisionRecord', input.originalDecisionRecordId, input.actor, input.correlationId, {
      type: 'DecisionSuperseded',
      originalDecisionRecordId: input.originalDecisionRecordId,
      supersedingDecisionRecordId: input.supersedingDecisionRecordId
    });
  }
}
