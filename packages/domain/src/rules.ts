// Domain rules enforced at the domain layer (AGENTS.md §4: domain rules are not
// implemented only in the HTTP handler or MCP adapter). Each guard returns a
// discriminated result so callers never treat a rejection as success.

import type { ChangeProposalState, ContextItem } from './model.js';
import type { ContextScope, ContractVersionId, PrincipalRef } from './primitives.js';

export type GuardResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

// INV-005: an unresolved blocking objection or a missing required approver must
// prevent the Accepted transition. Override requires a Decision Record.
export function canAcceptProposal(ctx: {
  readonly openBlockingObjections: number;
  readonly requiredApproversSatisfied: boolean;
}): GuardResult {
  if (ctx.openBlockingObjections > 0) {
    return { ok: false, reason: 'INV-005: unresolved blocking objection prevents acceptance' };
  }
  if (!ctx.requiredApproversSatisfied) {
    return { ok: false, reason: 'INV-005: missing required approver prevents acceptance' };
  }
  return { ok: true };
}

// INV-002 + INV-006: the proposal can only be Completed when acceptance and
// every independent lifecycle state hold, and confirmed consumers finished
// migration. No single success implies another.
export function canMarkCompleted(state: ChangeProposalState): GuardResult {
  if (!state.accepted) {
    return { ok: false, reason: 'INV-002: proposal must be accepted before completion' };
  }
  if (!(state.implemented && state.verified && state.deployed && state.observed)) {
    return { ok: false, reason: 'INV-002: lifecycle states are independent; completion requires implementation, verification, deployment and observation' };
  }
  if (!state.consumerMigrationComplete) {
    return { ok: false, reason: 'INV-006: completion requires all confirmed consumer migrations complete' };
  }
  return { ok: true };
}

// INV-011: a confirmed Context Item requires source, author, scope and a valid
// time. A statement alone cannot become confirmed fact.
export function canConfirmContext(input: {
  readonly source: string;
  readonly author: PrincipalRef;
  readonly scope: ContextScope;
  readonly validFrom: Date;
}): GuardResult {
  if (input.source.trim().length === 0) {
    return { ok: false, reason: 'INV-011: confirmed context requires a source' };
  }
  if (input.author.id.trim().length === 0) {
    return { ok: false, reason: 'INV-011: confirmed context requires an author principal' };
  }
  if (input.validFrom === undefined) {
    return { ok: false, reason: 'INV-011: confirmed context requires a valid-from time' };
  }
  return { ok: true };
}

// INV-012: corrections never destroy the past. A correction is allowed unless the
// item is already corrected; it always produces a *new* context item that
// references the original.
export function canCorrectContext(original: ContextItem): GuardResult {
  if (original.correctedBy !== undefined) {
    return { ok: false, reason: 'INV-012: item already has a correction; create a new correction instead of overwriting' };
  }
  return { ok: true };
}

// INV-003: a published Contract Version is immutable. Re-publishing the same
// version id is rejected.
export function canPublishContractVersion(
  existingVersionIds: ReadonlyArray<ContractVersionId>,
  candidate: ContractVersionId
): GuardResult {
  if (existingVersionIds.some((id) => id === candidate)) {
    return { ok: false, reason: 'INV-003: contract version is immutable once published; publish a new version instead' };
  }
  return { ok: true };
}

// INV-002 helper for callers: acceptance does not imply deployment (or any other
// lifecycle state). Used by projections/adapters to keep flags independent.
export function areLifecycleStatesIndependent(state: ChangeProposalState): boolean {
  return state.accepted !== state.deployed && state.accepted !== state.observed;
}
