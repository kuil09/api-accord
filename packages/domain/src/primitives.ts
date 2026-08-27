// Framework-independent domain primitives: branded identifiers, principals, enums.
//
// These types are the shared vocabulary of API Accord. They carry no behavior
// and no dependency on a database, HTTP layer, or external SDK (per AGENTS.md
// package responsibilities).

declare const brand: unique symbol;

// A phantom brand keeps identifiers distinct at compile time while remaining
// plain strings at runtime so they serialize cleanly into events and the DB.
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrganizationId = Brand<string, 'OrganizationId'>;
export type TeamId = Brand<string, 'TeamId'>;
export type PrincipalId = Brand<string, 'PrincipalId'>;
export type ServiceId = Brand<string, 'ServiceId'>;
export type ApiContractId = Brand<string, 'ApiContractId'>;
export type ContractVersionId = Brand<string, 'ContractVersionId'>;
export type OperationId = Brand<string, 'OperationId'>;
export type SchemaId = Brand<string, 'SchemaId'>;
export type DependencyEdgeId = Brand<string, 'DependencyEdgeId'>;
export type ContextItemId = Brand<string, 'ContextItemId'>;
export type DiscussionEntryId = Brand<string, 'DiscussionEntryId'>;
export type ChangeProposalId = Brand<string, 'ChangeProposalId'>;
export type DecisionRecordId = Brand<string, 'DecisionRecordId'>;
export type EvidenceId = Brand<string, 'EvidenceId'>;
export type DeploymentId = Brand<string, 'DeploymentId'>;
export type ObservationId = Brand<string, 'ObservationId'>;

function asId<T extends Brand<string, string>>(value: string, label: string): T {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return value as T;
}

export const organizationId = (value: string): OrganizationId => asId(value, 'OrganizationId');
export const teamId = (value: string): TeamId => asId(value, 'TeamId');
export const principalId = (value: string): PrincipalId => asId(value, 'PrincipalId');
export const serviceId = (value: string): ServiceId => asId(value, 'ServiceId');
export const apiContractId = (value: string): ApiContractId => asId(value, 'ApiContractId');
export const contractVersionId = (value: string): ContractVersionId => asId(value, 'ContractVersionId');
export const operationId = (value: string): OperationId => asId(value, 'OperationId');
export const schemaId = (value: string): SchemaId => asId(value, 'SchemaId');
export const dependencyEdgeId = (value: string): DependencyEdgeId => asId(value, 'DependencyEdgeId');
export const contextItemId = (value: string): ContextItemId => asId(value, 'ContextItemId');
export const discussionEntryId = (value: string): DiscussionEntryId => asId(value, 'DiscussionEntryId');
export const changeProposalId = (value: string): ChangeProposalId => asId(value, 'ChangeProposalId');
export const decisionRecordId = (value: string): DecisionRecordId => asId(value, 'DecisionRecordId');
export const evidenceId = (value: string): EvidenceId => asId(value, 'EvidenceId');
export const deploymentId = (value: string): DeploymentId => asId(value, 'DeploymentId');
export const observationId = (value: string): ObservationId => asId(value, 'ObservationId');

// A principal is the accountable actor behind any mutation (INV-026, INV-028).
// We never record anonymous system actions; every actor is one of these kinds.
export type PrincipalKind = 'human' | 'agent' | 'service' | 'ci' | 'integration';

export interface PrincipalRef {
  readonly kind: PrincipalKind;
  readonly id: string;
}

export function principalRef(kind: PrincipalKind, id: string): PrincipalRef {
  if (id.trim().length === 0) {
    throw new Error('PrincipalRef.id must not be empty');
  }
  return { kind, id };
}

// Confidence of a Context Item (INV-016: AI output defaults to unverified/inferred).
export type Confidence = 'unverified' | 'inferred' | 'confirmed' | 'disputed';

// Structured discussion utterance kinds.
export type DiscussionEntryKind =
  | 'question'
  | 'proposal'
  | 'objection'
  | 'constraint'
  | 'assumption'
  | 'evidence'
  | 'alternative'
  | 'correction'
  | 'acknowledgement';

// Evidence status must never collapse failed/skipped/waived into passed (INV-023).
export type EvidenceStatus = 'passed' | 'failed' | 'skipped' | 'not-run' | 'waived' | 'evidence-missing';

export type DriftSeverity = 'low' | 'medium' | 'high' | 'critical';

// Change Proposal coarse phase. The finer lifecycle is expressed by independent
// boolean flags on the projection (see model.ts) to honor INV-002.
export type ChangeProposalPhase = 'draft' | 'opened' | 'closed';

export type ChangeProposalOutcome = 'none' | 'completed' | 'rejected' | 'withdrawn';

// Scope a Context Item applies to.
export type ContextScope =
  | 'organization'
  | 'service'
  | 'apiContract'
  | 'operation'
  | 'dependencyEdge'
  | 'changeProposal';
