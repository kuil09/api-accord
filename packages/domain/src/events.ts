// Domain events and the append-only event ledger.
//
// The event stream is the source of truth (INV-035). Events are never updated
// or deleted; corrections and supersedes are new events that reference the
// originals (INV-012). The EventStore port is framework-independent; the
// PostgreSQL-backed implementation lives in apps/api (per AGENTS.md package
// responsibilities).

import { randomUUID } from 'node:crypto';

import type {
  ApiContractId,
  ChangeProposalId,
  Confidence,
  ContextItemId,
  ContextScope,
  ContractVersionId,
  CredentialId,
  DecisionRecordId,
  DependencyEdgeId,
  DiscussionEntryId,
  DiscussionEntryKind,
  DriftSeverity,
  EvidenceId,
  EvidenceStatus,
  ObservationId,
  OperationId,
  PrincipalId,
  PrincipalKind,
  SchemaId,
  PrincipalRef,
  Scope,
  ServiceId,
  TeamId,
  OrganizationId
} from './primitives.js';
import type { CompatibilityPolicy, EvidenceKind, ResolutionStatus, UsageDeclaration, WorkItemKind } from './model.js';
import type { ImpactAnalysisSnapshot } from './impact.js';
import type { ObservationKind } from './observation.js';

export type AggregateType =
  | 'organization'
  | 'team'
  | 'service'
  | 'apiContract'
  | 'contractVersion'
  | 'operation'
  | 'schema'
  | 'dependencyEdge'
  | 'contextItem'
  | 'discussionEntry'
  | 'changeProposal'
  | 'decisionRecord'
  | 'evidence'
  | 'deployment'
  | 'observation'
  | 'principal'
  | 'credential'
  | 'driftIncident'
  | 'service'
  | 'apiContract'
  | 'contractVersion'
  | 'operation'
  | 'schema';

// The union of every domain event. Each event describes a single fact.
export type DomainEvent =
  | { type: 'ServiceRegistered'; serviceId: ServiceId; organizationId: OrganizationId; owningTeamId: TeamId; name: string; kind: 'provider' | 'consumer' | 'both' }
  | { type: 'ContractImported'; contractId: ApiContractId; organizationId: OrganizationId; providerServiceId: ServiceId; title: string }
  | { type: 'ContractVersionPublished'; versionId: ContractVersionId; contractId: ApiContractId; sourceRevision: string; checksum: string; decisionRecordId?: DecisionRecordId; proposalId?: ChangeProposalId | undefined }
  | { type: 'OperationDeclared'; operationId: OperationId; contractId: ApiContractId; method: string; path: string; title: string }
  | { type: 'DependencyEdgeDeclared'; edgeId: DependencyEdgeId; consumerServiceId: ServiceId; operationId: OperationId; usage: UsageDeclaration; compatibility: CompatibilityPolicy; source: 'explicit' | 'code-analysis' | 'runtime-observation'; criticality: 'low' | 'medium' | 'high' | 'critical'; ownerTeamId?: TeamId | undefined }
  | { type: 'DependencyAssumptionAdded'; edgeId: DependencyEdgeId; assumptionId: string; statement: string; source: 'explicit' | 'code-analysis' | 'runtime-observation'; confidence: 'unverified' | 'inferred' | 'confirmed' | 'disputed'; conflictStatus: 'none' | 'conflicting' }
  | { type: 'DependencyEdgeDeprecated'; edgeId: DependencyEdgeId; reason: string }
  | { type: 'ContextProposed'; contextItemId: ContextItemId; scope: ContextScope; statement: string; contextType: string; author: PrincipalRef; source: string; confidence: Confidence }
  | { type: 'ContextConfirmed'; contextItemId: ContextItemId; validFrom: Date }
  | { type: 'ContextCorrected'; originalContextItemId: ContextItemId; correctionContextItemId: ContextItemId }
  | { type: 'ContextSuperseded'; originalContextItemId: ContextItemId; supersedingContextItemId: ContextItemId; from: Date }
  | { type: 'ContextChallenged'; contextItemId: ContextItemId; challenger: PrincipalRef; reason: string }
  | { type: 'ContextNarrowedScope'; contextItemId: ContextItemId; scope: ContextScope; previousScope: ContextScope }
  | { type: 'ContextEvidenceAdded'; contextItemId: ContextItemId; evidenceRef: string }
  | { type: 'ContextExpired'; contextItemId: ContextItemId; at: Date }
  | { type: 'ContextVisibilityChanged'; contextItemId: ContextItemId; visibility: 'public' | 'organization' | 'team' }
  | { type: 'ChangeProposalOpened'; proposalId: ChangeProposalId; contractId: ApiContractId; title: string }
  | { type: 'ChangeProposalAccepted'; proposalId: ChangeProposalId; reason?: string | undefined }
  | { type: 'ProviderImplementationRecorded'; proposalId: ChangeProposalId; reason?: string | undefined }
  | { type: 'ConsumerReadinessRecorded'; proposalId: ChangeProposalId; reason?: string | undefined }
  | { type: 'ContractVerificationRecorded'; proposalId: ChangeProposalId; reason?: string | undefined }
  | { type: 'DeploymentRecorded'; proposalId: ChangeProposalId; reason?: string | undefined }
  | { type: 'ObservationRecorded'; proposalId: ChangeProposalId; reason?: string | undefined }
  | { type: 'ConsumerMigrationCompleted'; proposalId: ChangeProposalId; reason?: string | undefined }
  | { type: 'RequiredApproversDeclared'; proposalId: ChangeProposalId; requiredApprovers: ReadonlyArray<PrincipalRef>; declaredBy: PrincipalRef }
  | { type: 'ApprovalRecorded'; proposalId: ChangeProposalId; approver: PrincipalRef; comment?: string | undefined }
  | { type: 'ApprovalWithdrawn'; proposalId: ChangeProposalId; approver: PrincipalRef; reason: string }
  | { type: 'ConsumerReadinessDeclared'; proposalId: ChangeProposalId; consumerServiceId: ServiceId; ready: boolean; deadline?: Date | undefined; evidenceRef?: string | undefined; declaredBy: PrincipalRef }
  | { type: 'ConsumerMigrationAcknowledged'; proposalId: ChangeProposalId; consumerServiceId: ServiceId; acknowledgedBy: PrincipalRef }
  | { type: 'ChangeProposalCompleted'; proposalId: ChangeProposalId }
  | { type: 'ChangeProposalRejected'; proposalId: ChangeProposalId; reason?: string | undefined }
  | { type: 'ChangeProposalWithdrawn'; proposalId: ChangeProposalId; reason?: string | undefined }
  | { type: 'BlockingObjectionRaised'; proposalId: ChangeProposalId; entryId: DiscussionEntryId }
  | { type: 'BlockingObjectionResolved'; proposalId: ChangeProposalId; entryId: DiscussionEntryId }
  | { type: 'ProposalWorkItemCreated'; proposalId: ChangeProposalId; workItemId: string; kind: WorkItemKind; description: string; assignedTo: PrincipalRef; at: Date }
  | { type: 'ProposalWorkItemCompleted'; proposalId: ChangeProposalId; workItemId: string; completedBy: PrincipalRef; at: Date }
  | { type: 'ImpactAnalysisRecorded'; proposalId: ChangeProposalId; computedBy: PrincipalRef; computedAt: Date; snapshot: ImpactAnalysisSnapshot }
  | { type: 'ImpactAnalysisAmended'; proposalId: ChangeProposalId; amendedBy: PrincipalRef; reason: string; evidence: string; at: Date }
  | { type: 'RuntimeObservationRecorded'; observationId: ObservationId; operationId: string; environment: string; contractVersionId: string; deploymentRevision: string; collectorVersion: string; kind: ObservationKind; severity: DriftSeverity; fingerprint: string; redactedDetail: Record<string, unknown>; sampleSize: number; at: Date }
  | { type: 'DriftIncidentResolved'; incidentId: string; resolution: 'false-positive' | 'accepted-deviation' | 'fixed' | 'expired'; reason: string; resolvedBy: PrincipalRef; at: Date }
  | { type: 'DriftPromotedToCandidate'; incidentId: string; contextItemId: ContextItemId; promotedBy: PrincipalRef; at: Date }
  | { type: 'DiscussionEntryCreated'; entryId: DiscussionEntryId; proposalId: ChangeProposalId; kind: DiscussionEntryKind; author: PrincipalRef; body: string; isBlockingObjection: boolean; affectedConsumers: ReadonlyArray<ServiceId>; severity?: 'low' | 'medium' | 'high' | 'critical' | undefined; evidenceRef?: string | undefined; inReplyTo?: DiscussionEntryId | undefined; quotes?: DiscussionEntryId | undefined; duplicateOf?: DiscussionEntryId | undefined }
  | { type: 'DiscussionEntryResolved'; entryId: DiscussionEntryId; proposalId: ChangeProposalId; status: Exclude<ResolutionStatus, 'open'>; resolvedBy: PrincipalRef }
  | { type: 'DecisionRecorded'; decisionRecordId: DecisionRecordId; proposalId: ChangeProposalId; decision: string; rationale: string; constraints: ReadonlyArray<string>; rejectedAlternatives: ReadonlyArray<{ readonly alternative: string; readonly reason: string }>; approvers: ReadonlyArray<PrincipalRef>; validFrom: Date; validUntil?: Date | undefined; sourceEntryIds: ReadonlyArray<DiscussionEntryId>; supersedes?: DecisionRecordId | undefined }
  | { type: 'DecisionSuperseded'; originalDecisionRecordId: DecisionRecordId; supersedingDecisionRecordId: DecisionRecordId }
  | { type: 'EvidenceAttached'; evidenceId: EvidenceId; contractVersionId: ContractVersionId; sourceRevision: string; status: EvidenceStatus; kind?: EvidenceKind | undefined; producer?: PrincipalRef | undefined; environment?: string | undefined; source?: string | undefined; checksum?: string | undefined; observedAt?: Date | undefined; expiresAt?: Date | undefined; consumerServiceId?: ServiceId | undefined; provenance?: 'github-check' | 'direct-submission' | undefined; waivedKind?: EvidenceKind | undefined }
  | { type: 'DriftDetected'; observationId: ObservationId; operationId: OperationId; environment: string; kind: string; severity: DriftSeverity; sampleSize: number }
  | { type: 'PrincipalRegistered'; principalId: PrincipalId; kind: PrincipalKind; organizationId: OrganizationId; name: string; createdBy: PrincipalRef; status: 'active' | 'inactive' }
  | { type: 'PrincipalDeactivated'; principalId: PrincipalId; reason: string }
  | { type: 'CredentialIssued'; credentialId: CredentialId; principalId: PrincipalId; name: string; scopes: ReadonlyArray<Scope>; expiresAt: Date | undefined; issuedBy: PrincipalRef; secretHash: string }
  | { type: 'CredentialRevoked'; credentialId: CredentialId; revokedBy: PrincipalRef; reason: string }
  | { type: 'CredentialRotated'; credentialId: CredentialId; rotatedBy: PrincipalRef; secretHash: string; supersededCredentialId: CredentialId | undefined }
  | { type: 'ScopeGranted'; principalId: PrincipalId; scope: Scope; grantedBy: PrincipalRef }
  | { type: 'ScopeRevoked'; principalId: PrincipalId; scope: Scope; revokedBy: PrincipalRef }
  | { type: 'ServiceRegistered'; serviceId: ServiceId; organizationId: OrganizationId; owningTeamId: TeamId; name: string; kind: 'provider' | 'consumer' | 'both'; repositoryUrl?: string; environments: ReadonlyArray<string> }
  | { type: 'ApiContractImported'; contractId: ApiContractId; organizationId: OrganizationId; providerServiceId: ServiceId; title: string; importSource: string; importSourceUrl?: string }
  | { type: 'ContractVersionImported'; versionId: ContractVersionId; contractId: ApiContractId; sourceRevision: string; checksum: string }
  | { type: 'OperationImported'; operationId: OperationId; opId: string; contractId: ApiContractId; method: string; path: string; title: string }
  | { type: 'SchemaImported'; schemaId: SchemaId; operationId: OperationId; role: 'request' | 'response' | 'error' | 'event'; shape: unknown }
  | { type: 'ImportPartialFailure'; contractId: ApiContractId; sourceRevision: string; errors: ReadonlyArray<string> };

export interface EventEnvelope<E extends DomainEvent = DomainEvent> {
  readonly eventId: string;
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  // Every mutation is attributable to a real principal (INV-026, INV-028).
  readonly actor: PrincipalRef;
  readonly correlationId: string;
  // Stream version after this event; used for optimistic concurrency.
  readonly version: number;
  readonly event: E;
}

// Maps an event to its owning aggregate so a single object's history can be
// fetched. This is the append-only ledger's primary key shape.
export function aggregateOf(event: DomainEvent): { type: AggregateType; id: string } {
  switch (event.type) {
    case 'ServiceRegistered':
      return { type: 'service', id: event.serviceId };
    case 'ContractImported':
      return { type: 'apiContract', id: event.contractId };
    case 'ContractVersionPublished':
      return { type: 'contractVersion', id: event.versionId };
    case 'OperationDeclared':
      return { type: 'operation', id: event.operationId };
    case 'ContextProposed':
      return { type: 'contextItem', id: event.contextItemId };
    case 'ContextConfirmed':
      return { type: 'contextItem', id: event.contextItemId };
    case 'ContextCorrected':
      return { type: 'contextItem', id: event.originalContextItemId };
    case 'ContextSuperseded':
      return { type: 'contextItem', id: event.originalContextItemId };
    case 'ContextChallenged':
    case 'ContextNarrowedScope':
    case 'ContextEvidenceAdded':
    case 'ContextExpired':
    case 'ContextVisibilityChanged':
      return { type: 'contextItem', id: event.contextItemId };
    case 'ChangeProposalOpened':
    case 'ChangeProposalAccepted':
    case 'ProviderImplementationRecorded':
    case 'ConsumerReadinessRecorded':
    case 'ContractVerificationRecorded':
    case 'DeploymentRecorded':
    case 'ObservationRecorded':
    case 'ChangeProposalCompleted':
    case 'ConsumerMigrationCompleted':
    case 'ChangeProposalRejected':
    case 'ChangeProposalWithdrawn':
    case 'BlockingObjectionRaised':
    case 'BlockingObjectionResolved':
    case 'RequiredApproversDeclared':
    case 'ApprovalRecorded':
    case 'ApprovalWithdrawn':
    case 'ConsumerReadinessDeclared':
    case 'ConsumerMigrationAcknowledged':
      return { type: 'changeProposal', id: event.proposalId };
    case 'ProposalWorkItemCreated':
    case 'ProposalWorkItemCompleted':
    case 'ImpactAnalysisRecorded':
    case 'ImpactAnalysisAmended':
      return { type: 'changeProposal', id: event.proposalId };
    case 'RuntimeObservationRecorded':
      return { type: 'observation', id: event.observationId };
    case 'DriftIncidentResolved':
    case 'DriftPromotedToCandidate':
      return { type: 'driftIncident', id: event.incidentId };
    case 'DiscussionEntryCreated':
    case 'DiscussionEntryResolved':
      return { type: 'discussionEntry', id: event.entryId };
    case 'DecisionRecorded':
      return { type: 'decisionRecord', id: event.decisionRecordId };
    case 'DecisionSuperseded':
      return { type: 'decisionRecord', id: event.originalDecisionRecordId };
    case 'EvidenceAttached':
      return { type: 'evidence', id: event.evidenceId };
    case 'DriftDetected':
      return { type: 'observation', id: event.observationId };
    case 'PrincipalRegistered':
    case 'PrincipalDeactivated':
    case 'ScopeGranted':
    case 'ScopeRevoked':
      return { type: 'principal', id: event.principalId };
    case 'CredentialIssued':
    case 'CredentialRevoked':
    case 'CredentialRotated':
      return { type: 'credential', id: event.credentialId };
    case 'ServiceRegistered':
      return { type: 'service', id: event.serviceId };
    case 'ApiContractImported':
      return { type: 'apiContract', id: event.contractId };
    case 'ContractVersionImported':
      return { type: 'contractVersion', id: event.versionId };
    case 'OperationImported':
      return { type: 'operation', id: event.operationId };
    case 'SchemaImported':
      return { type: 'schema', id: event.schemaId };
    case 'ImportPartialFailure':
      return { type: 'apiContract', id: event.contractId };
    case 'DependencyEdgeDeclared':
    case 'DependencyAssumptionAdded':
    case 'DependencyEdgeDeprecated':
      return { type: 'dependencyEdge', id: event.edgeId };
  }
}

export interface AppendInput {
  readonly actor: PrincipalRef;
  readonly correlationId: string;
  readonly event: DomainEvent;
  // Optimistic concurrency: when set, the append fails if the stream version
  // differs, preventing lost updates under concurrent writers.
  readonly expectedVersion?: number;
  readonly occurredAt?: Date;
}

export interface AppendResult {
  readonly eventId: string;
  readonly version: number;
}

export class ConcurrencyError extends Error {
  constructor(
    readonly aggregateType: AggregateType,
    readonly aggregateId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number
  ) {
    super(
      `Concurrency conflict on ${aggregateType}:${aggregateId}: expected version ${String(expectedVersion)} but stream is at ${String(actualVersion)}`
    );
    this.name = 'ConcurrencyError';
  }
}

// Port for the append-only event ledger. No update or delete operations exist.
export interface EventStore {
  append(input: AppendInput): Promise<AppendResult>;
  getStream(aggregateType: AggregateType, aggregateId: string): Promise<ReadonlyArray<EventEnvelope>>;
  getAll(): Promise<ReadonlyArray<EventEnvelope>>;
}

// In-memory ledger for domain logic, unit tests, and local execution. The same
// port is implemented against PostgreSQL in apps/api. Append-only is enforced:
// there is no path that rewrites or removes an existing envelope.
export class InMemoryEventStore implements EventStore {
  readonly #events: EventEnvelope[] = [];
  readonly #versions = new Map<string, number>();

  async append(input: AppendInput): Promise<AppendResult> {
    const { type, id } = aggregateOf(input.event);
    const key = `${type}:${id}`;
    const last = this.#versions.get(key) ?? 0;

    if (input.expectedVersion !== undefined && input.expectedVersion !== last) {
      throw new ConcurrencyError(type, id, input.expectedVersion, last);
    }

    const version = last + 1;
    const envelope: EventEnvelope = {
      eventId: randomUUID(),
      aggregateType: type,
      aggregateId: id,
      occurredAt: input.occurredAt ?? new Date(),
      actor: input.actor,
      correlationId: input.correlationId,
      version,
      event: input.event
    };

    this.#events.push(envelope);
    this.#versions.set(key, version);
    return { eventId: envelope.eventId, version };
  }

  async getStream(aggregateType: AggregateType, aggregateId: string): Promise<ReadonlyArray<EventEnvelope>> {
    return this.#events
      .filter((envelope) => envelope.aggregateType === aggregateType && envelope.aggregateId === aggregateId)
      .sort((left, right) => left.version - right.version);
  }

  async getAll(): Promise<ReadonlyArray<EventEnvelope>> {
    return [...this.#events];
  }
}
