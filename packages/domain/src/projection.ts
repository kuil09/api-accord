// Pure projections: reconstruct current state and point-in-time state from the
// append-only event stream (INV-035). No side effects; given the same events,
// the result is deterministic. Corrections and supersedes never destroy the
// past — the original events remain and the derived state simply points at the
// newer item.

import type { ChangeProposalState, ContextItem } from './model.js';
import type { ChangeProposalId, ContextItemId } from './primitives.js';
import type { DomainEvent, EventEnvelope } from './events.js';

// Returns events whose occurrence is at or before `when`, enabling reconstruction
// of an aggregate's state at an arbitrary point in time.
export function eventsUpTo(events: ReadonlyArray<EventEnvelope>, when: Date): EventEnvelope[] {
  return events.filter((envelope) => envelope.occurredAt.getTime() <= when.getTime());
}

export function changeProposalState(
  events: ReadonlyArray<EventEnvelope<DomainEvent>>,
  proposalId: ChangeProposalId
): ChangeProposalState | undefined {
  const stream = events
    .filter((envelope) => envelope.aggregateType === 'changeProposal' && envelope.aggregateId === proposalId)
    .sort((left, right) => left.version - right.version);

  let contractId: ChangeProposalState['contractId'] | undefined;
  let title = '';
  let phase: ChangeProposalState['phase'] = 'draft';
  let accepted = false;
  let implemented = false;
  let consumerReady = false;
  let verified = false;
  let deployed = false;
  let observed = false;
  let outcome: ChangeProposalState['outcome'] = 'none';
  let openBlockingObjections = 0;
  let requiredApproversSatisfied = false;
  let consumerMigrationComplete = false;
  let opened = false;

  for (const envelope of stream) {
    const event = envelope.event;
    switch (event.type) {
      case 'ChangeProposalOpened':
        opened = true;
        contractId = event.contractId;
        title = event.title;
        phase = 'opened';
        break;
      case 'ChangeProposalAccepted':
        accepted = true;
        requiredApproversSatisfied = true;
        break;
      case 'ProviderImplementationRecorded':
        implemented = true;
        break;
      case 'ConsumerReadinessRecorded':
        consumerReady = true;
        break;
      case 'ContractVerificationRecorded':
        verified = true;
        break;
      case 'DeploymentRecorded':
        deployed = true;
        break;
      case 'ObservationRecorded':
        observed = true;
        break;
      case 'ChangeProposalCompleted':
        outcome = 'completed';
        phase = 'closed';
        consumerMigrationComplete = true;
        break;
      case 'ChangeProposalRejected':
        outcome = 'rejected';
        phase = 'closed';
        break;
      case 'ChangeProposalWithdrawn':
        outcome = 'withdrawn';
        phase = 'closed';
        break;
      case 'BlockingObjectionRaised':
        openBlockingObjections += 1;
        break;
      case 'BlockingObjectionResolved':
        openBlockingObjections = Math.max(0, openBlockingObjections - 1);
        break;
      default:
        break;
    }
  }

  if (!opened || contractId === undefined) {
    return undefined;
  }

  return {
    id: proposalId,
    contractId,
    title,
    phase,
    accepted,
    implemented,
    consumerReady,
    verified,
    deployed,
    observed,
    outcome,
    openBlockingObjections,
    requiredApproversSatisfied,
    consumerMigrationComplete
  };
}

// Resolves the "current" context item by replaying corrections/supersedes. The
// original events are untouched; only the derived pointer moves (INV-012).
export function contextItemFrom(
  events: ReadonlyArray<EventEnvelope<DomainEvent>>,
  contextItemId: ContextItemId
): ContextItem | undefined {
  const stream = events
    .filter((envelope) => envelope.aggregateType === 'contextItem' && envelope.aggregateId === contextItemId)
    .sort((left, right) => left.version - right.version);

  let item: ContextItem | undefined;
  for (const envelope of stream) {
    const event = envelope.event;
    if (event.type === 'ContextProposed') {
      item = {
        id: contextItemId,
        scope: event.scope,
        statement: event.statement,
        contextType: event.contextType,
        author: event.author,
        source: event.source,
        confidence: event.confidence,
        validFrom: new Date(0)
      };
    } else if (event.type === 'ContextConfirmed' && item !== undefined) {
      item = { ...item, confidence: 'confirmed', validFrom: event.validFrom };
    } else if (event.type === 'ContextCorrected' && item !== undefined) {
      item = { ...item, correctedBy: event.correctionContextItemId };
    } else if (event.type === 'ContextSuperseded' && item !== undefined) {
      item = { ...item, supersededBy: event.supersedingContextItemId };
    }
  }

  return item;
}
