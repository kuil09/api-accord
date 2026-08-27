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
  | 'service'
  | 'apiContract'
  | 'contractVersion'
  | 'operation'
  | 'schema';

// The union of every domain event. Each event describes a single fact.
export type DomainEvent =
  | { type: 'ServiceRegistered'; serviceId: ServiceId; organizationId: OrganizationId; owningTeamId: TeamId; name: string; kind: 'provider' | 'consumer' | 'both' }
  | { type: 'ContractImported'; contractId: ApiContractId; organizationId: OrganizationId; providerServiceId: ServiceId; title: string }
  | { type: 'ContractVersionPublished'; versionId: ContractVersionId; contractId: ApiContractId; sourceRevision: string; checksum: string; decisionRecordId?: DecisionRecordId }
  | { type: 'OperationDeclared'; operationId: OperationId; contractId: ApiContractId; method: string; path: string; title: string }
  | { type: 'DependencyDeclared'; edgeId: DependencyEdgeId; consumerServiceId: ServiceId; operationId: OperationId; source: string }
  | { type: 'ContextProposed'; contextItemId: ContextItemId; scope: ContextScope; statement: string; contextType: string; author: PrincipalRef; source: string; confidence: Confidence }
  | { type: 'ContextConfirmed'; contextItemId: ContextItemId; validFrom: Date }
  | { type: 'ContextCorrected'; originalContextItemId: ContextItemId; correctionContextItemId: ContextItemId }
  | { type: 'ContextSuperseded'; originalContextItemId: ContextItemId; supersedingContextItemId: ContextItemId; from: Date }
  | { type: 'ChangeProposalOpened'; proposalId: ChangeProposalId; contractId: ApiContractId; title: string }
  | { type: 'ChangeProposalAccepted'; proposalId: ChangeProposalId }
  | { type: 'ProviderImplementationRecorded'; proposalId: ChangeProposalId }
  | { type: 'ConsumerReadinessRecorded'; proposalId: ChangeProposalId }
  | { type: 'ContractVerificationRecorded'; proposalId: ChangeProposalId }
  | { type: 'DeploymentRecorded'; proposalId: ChangeProposalId }
  | { type: 'ObservationRecorded'; proposalId: ChangeProposalId }
  | { type: 'ConsumerMigrationCompleted'; proposalId: ChangeProposalId }
  | { type: 'ChangeProposalCompleted'; proposalId: ChangeProposalId }
  | { type: 'ChangeProposalRejected'; proposalId: ChangeProposalId }
  | { type: 'ChangeProposalWithdrawn'; proposalId: ChangeProposalId }
  | { type: 'BlockingObjectionRaised'; proposalId: ChangeProposalId; entryId: DiscussionEntryId }
  | { type: 'BlockingObjectionResolved'; proposalId: ChangeProposalId; entryId: DiscussionEntryId }
  | { type: 'DecisionRecorded'; decisionRecordId: DecisionRecordId; proposalId: ChangeProposalId; decision: string; rationale: string; approvers: ReadonlyArray<PrincipalRef> }
  | { type: 'DecisionSuperseded'; originalDecisionRecordId: DecisionRecordId; supersedingDecisionRecordId: DecisionRecordId }
  | { type: 'EvidenceAttached'; evidenceId: EvidenceId; contractVersionId: ContractVersionId; sourceRevision: string; status: EvidenceStatus }
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
    case 'DependencyDeclared':
      return { type: 'dependencyEdge', id: event.edgeId };
    case 'ContextProposed':
      return { type: 'contextItem', id: event.contextItemId };
    case 'ContextConfirmed':
      return { type: 'contextItem', id: event.contextItemId };
    case 'ContextCorrected':
      return { type: 'contextItem', id: event.originalContextItemId };
    case 'ContextSuperseded':
      return { type: 'contextItem', id: event.originalContextItemId };
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
      return { type: 'changeProposal', id: event.proposalId };
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
