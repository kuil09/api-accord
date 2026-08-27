// Current-state read models (snapshots reconstructed from the event ledger).
//
// These are plain data shapes. They are never mutated in place: the source of
// truth is the append-only event stream, and these projections are derived from
// it (INV-035). A mutation is always a new event, never an UPDATE on a row.

import type {
  ApiContractId,
  ChangeProposalId,
  ChangeProposalOutcome,
  ChangeProposalPhase,
  Confidence,
  ContextItemId,
  ContextScope,
  ContractVersionId,
  CredentialId,
  DependencyEdgeId,
  DeploymentId,
  DiscussionEntryId,
  DiscussionEntryKind,
  EvidenceId,
  EvidenceStatus,
  ObservationId,
  OperationId,
  OrganizationId,
  PrincipalId,
  PrincipalKind,
  PrincipalRef,
  SchemaId,
  Scope,
  ServiceId,
  TeamId,
  DecisionRecordId
} from './primitives.js';

export interface Organization {
  readonly id: OrganizationId;
  readonly name: string;
  readonly createdAt: Date;
}

export interface Team {
  readonly id: TeamId;
  readonly organizationId: OrganizationId;
  readonly name: string;
}

export interface Service {
  readonly id: ServiceId;
  readonly organizationId: OrganizationId;
  readonly owningTeamId: TeamId;
  readonly name: string;
  readonly kind: 'provider' | 'consumer' | 'both';
}

export interface ApiContract {
  readonly id: ApiContractId;
  readonly organizationId: OrganizationId;
  readonly providerServiceId: ServiceId;
  readonly title: string;
}

export interface ContractVersion {
  readonly id: ContractVersionId;
  // INV-003: a published version is immutable; the version id never reappears.
  readonly contractId: ApiContractId;
  readonly sourceRevision: string;
  readonly checksum: string;
  readonly publishedAt: Date;
  readonly decisionRecordId?: DecisionRecordId;
}

export interface Operation {
  readonly id: OperationId;
  readonly contractId: ApiContractId;
  readonly method: string;
  readonly path: string;
  readonly title: string;
}

export interface Schema {
  readonly id: SchemaId;
  readonly operationId: OperationId;
  readonly role: 'request' | 'response' | 'error' | 'event';
  readonly shape: unknown;
}

export interface DependencyEdge {
  readonly id: DependencyEdgeId;
  readonly consumerServiceId: ServiceId;
  readonly operationId: OperationId;
  readonly usage: unknown;
  readonly source: string; // explicit | code-analysis | runtime-observation (INV-010)
  readonly confirmedAt: Date;
}

export interface ContextItem {
  readonly id: ContextItemId;
  readonly scope: ContextScope;
  readonly statement: string;
  readonly contextType: string;
  readonly author: PrincipalRef;
  readonly source: string;
  readonly confidence: Confidence;
  readonly validFrom: Date;
  readonly validUntil?: Date;
  // INV-012: corrections and supersedes leave a new item and reference it here.
  readonly correctedBy?: ContextItemId;
  readonly supersededBy?: ContextItemId;
}

export interface DiscussionEntry {
  readonly id: DiscussionEntryId;
  readonly proposalId: ChangeProposalId;
  readonly kind: DiscussionEntryKind;
  readonly author: PrincipalRef;
  readonly body: string;
  // A blocking objection that is unresolved prevents Accepted (INV-005).
  readonly isBlockingObjection: boolean;
  readonly resolved: boolean;
}

// INV-002: acceptance, provider implementation, consumer readiness, contract
// verification, deployment and observation are independent states. A single
// success never implies another.
export interface ChangeProposalState {
  readonly id: ChangeProposalId;
  readonly contractId: ApiContractId;
  readonly title: string;
  readonly phase: ChangeProposalPhase;
  readonly accepted: boolean;
  readonly implemented: boolean;
  readonly consumerReady: boolean;
  readonly verified: boolean;
  readonly deployed: boolean;
  readonly observed: boolean;
  readonly outcome: ChangeProposalOutcome;
  readonly openBlockingObjections: number;
  readonly requiredApproversSatisfied: boolean;
  // INV-006: completion requires every confirmed consumer migration complete.
  readonly consumerMigrationComplete: boolean;
}

export interface DecisionRecord {
  readonly id: DecisionRecordId;
  readonly proposalId: ChangeProposalId;
  readonly decision: string;
  readonly rationale: string;
  readonly approvers: ReadonlyArray<PrincipalRef>;
  readonly supersededBy?: DecisionRecordId;
}

export interface Evidence {
  readonly id: EvidenceId;
  readonly contractVersionId: ContractVersionId;
  readonly sourceRevision: string;
  readonly status: EvidenceStatus;
  readonly attachedAt: Date;
}

export interface Deployment {
  readonly id: DeploymentId;
  readonly contractVersionId: ContractVersionId;
  readonly environment: string;
  readonly deployedAt: Date;
}

export interface Observation {
  readonly id: ObservationId;
  readonly operationId: OperationId;
  readonly environment: string;
  readonly observedAt: Date;
  readonly sampleSize: number;
}

// A participant in the system. Never anonymous; every mutation is attributed to
// one of these (INV-026, INV-028).
export interface Principal {
  readonly id: PrincipalId;
  readonly kind: PrincipalKind;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly status: 'active' | 'inactive';
  readonly createdBy: PrincipalRef;
  readonly createdAt: Date;
}

// MCP credential. The plaintext secret is exposed exactly once at issuance and
// never stored; only the salted hash is persisted (INV-031).
export interface Credential {
  readonly id: CredentialId;
  readonly principalId: PrincipalId;
  readonly name: string;
  readonly scopes: ReadonlyArray<Scope>;
  readonly secretHash: string;
  readonly issuedBy: PrincipalRef;
  readonly issuedAt: Date;
  readonly expiresAt: Date | undefined;
  readonly lastUsedAt: Date | undefined;
  readonly lastUsedIp: string | undefined;
  readonly lastUsedClient: string | undefined;
  readonly revokedAt: Date | undefined;
  readonly rotatedFrom: CredentialId | undefined;
}

export type { PrincipalId };
