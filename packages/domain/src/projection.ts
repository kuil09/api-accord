// Pure projections: reconstruct current state and point-in-time state from the
// append-only event stream (INV-035). No side effects; given the same events,
// the result is deterministic. Corrections and supersedes never destroy the
// past — the original events remain and the derived state simply points at the
// newer item.

import type { ChangeProposalState, ContextItem, DependencyAssumption, DependencyEdge } from './model.js';
import type { ChangeProposalId, Confidence, ContextItemId, ContextScope, DependencyEdgeId } from './primitives.js';
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
      case 'ConsumerMigrationCompleted':
        consumerMigrationComplete = true;
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
        validFrom: new Date(0),
        visibility: 'organization',
        disputed: false
      };
    } else if (event.type === 'ContextConfirmed' && item !== undefined) {
      item = { ...item, confidence: 'confirmed', validFrom: event.validFrom };
    } else if (event.type === 'ContextCorrected' && item !== undefined) {
      item = { ...item, correctedBy: event.correctionContextItemId, correctedAt: envelope.occurredAt };
    } else if (event.type === 'ContextSuperseded' && item !== undefined) {
      item = { ...item, supersededBy: event.supersedingContextItemId };
    } else if (event.type === 'ContextChallenged' && item !== undefined) {
      item = { ...item, disputed: true, challengedBy: event.challenger };
    } else if (event.type === 'ContextNarrowedScope' && item !== undefined) {
      item = { ...item, scope: event.scope };
    } else if (event.type === 'ContextEvidenceAdded' && item !== undefined) {
      item = { ...item, evidenceRef: event.evidenceRef };
    } else if (event.type === 'ContextExpired' && item !== undefined) {
      item = { ...item, validUntil: event.at };
    } else if (event.type === 'ContextVisibilityChanged' && item !== undefined) {
      item = { ...item, visibility: event.visibility };
    }
  }

  return item;
}

// Detects contradictory context items in the same scope (never averaged away).
// Returns the conflicting pair ids and their scopes. Semantic conflict detection
// is later (#18); this is a keyword-based first pass.
export function detectContextConflicts(
  items: ReadonlyArray<ContextItem>
): ReadonlyArray<readonly [ContextItemId, ContextItemId]> {
  const conflicts: Array<readonly [ContextItemId, ContextItemId]> = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i];
      const b = items[j];
      if (a === undefined || b === undefined) continue;
      if (a.scope !== b.scope) continue;
      const sameStatement = normalize(a.statement) === normalize(b.statement);
      if (!sameStatement && contradicts(a.statement, b.statement)) {
        conflicts.push([a.id, b.id]);
      }
    }
  }
  return conflicts;
}

export interface ContextQuery {
  readonly scope?: ContextScope;
  readonly confidence?: Confidence;
  readonly visibility?: 'public' | 'organization' | 'team';
  readonly includeExpired?: boolean;
  readonly includeConfirmedOnly?: boolean;
  readonly includeDisputedOnly?: boolean;
}

// Filters context items by structured criteria (issue #7 query surface).
export function queryContext(
  items: ReadonlyArray<ContextItem>,
  query: ContextQuery,
  now: Date = new Date()
): ReadonlyArray<ContextItem> {
  return items.filter((item) => {
    if (query.scope !== undefined && item.scope !== query.scope) return false;
    if (query.confidence !== undefined && item.confidence !== query.confidence) return false;
    if (query.visibility !== undefined && item.visibility !== query.visibility) return false;
    if (query.includeConfirmedOnly === true && item.confidence !== 'confirmed') return false;
    if (query.includeDisputedOnly === true && item.disputed !== true) return false;
    if (query.includeExpired === false || query.includeExpired === undefined) {
      if (item.validUntil !== undefined && item.validUntil.getTime() < now.getTime()) return false;
    }
    return true;
  });
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function contradicts(statementA: string, statementB: string): boolean {
  const pa = polarity(statementA);
  const pb = polarity(statementB);
  if (pa === 0 || pb === 0) return false;
  return pa + pb === 0;
}

function polarity(text: string): 1 | -1 | 0 {
  const t = text.toLowerCase();
  if (/not|never|does not|doesn't|isn't|aren't|without/u.test(t)) return -1;
  if (/always|must|is|exists|requires|guarantees/u.test(t)) return 1;
  return 0;
}


// Reconstructs a DependencyEdge from its event stream (issue #6). Assumptions
// from different consumers/sources are preserved rather than averaged; when two
// assumptions on the same edge contradict, both stay visible as `conflicting`.
export function dependencyEdgeFrom(
  events: ReadonlyArray<EventEnvelope<DomainEvent>>,
  edgeId: DependencyEdgeId
): DependencyEdge | undefined {
  const stream = events
    .filter((envelope) => envelope.aggregateType === 'dependencyEdge' && envelope.aggregateId === edgeId)
    .sort((left, right) => left.version - right.version);

  let edge: DependencyEdge | undefined;
  const assumptions = new Map<string, DependencyAssumption>();

  for (const envelope of stream) {
    const event = envelope.event;
    if (event.type === 'DependencyEdgeDeclared') {
      edge = {
        id: edgeId,
        consumerServiceId: event.consumerServiceId,
        operationId: event.operationId,
        usage: event.usage,
        assumptions: [],
        compatibility: event.compatibility,
        criticality: event.criticality,
        ownerTeamId: event.ownerTeamId,
        source: event.source,
        confirmedAt: envelope.occurredAt,
        deprecated: false
      };
    } else if (event.type === 'DependencyAssumptionAdded' && edge !== undefined) {
      assumptions.set(event.assumptionId, {
        id: event.assumptionId,
        statement: event.statement,
        source: event.source,
        confidence: event.confidence,
        conflictStatus: event.conflictStatus
      });
      edge = { ...edge, assumptions: [...assumptions.values()] };
    } else if (event.type === 'DependencyEdgeDeprecated' && edge !== undefined) {
      edge = { ...edge, deprecated: true };
    }
  }

  return edge;
}

// Detects conflicting assumptions on the same operation (INV-008: never average
// or overwrite opposing consumer assumptions). Returns the conflicting pair ids.
export function findConflictingAssumptions(
  edges: ReadonlyArray<DependencyEdge>
): ReadonlyArray<readonly [DependencyEdgeId, string, DependencyEdgeId, string]> {
  const conflicts: Array<readonly [DependencyEdgeId, string, DependencyEdgeId, string]> = [];
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const a = edges[i];
      const b = edges[j];
      if (a === undefined || b === undefined) {
        continue;
      }
      if (a.operationId !== b.operationId) {
        continue;
      }
      for (const assumptionA of a.assumptions) {
        for (const assumptionB of b.assumptions) {
          if (assumptionA.statement !== assumptionB.statement && contradicts(assumptionA.statement, assumptionB.statement)) {
            conflicts.push([a.id, assumptionA.id, b.id, assumptionB.id]);
          }
        }
      }
    }
  }
  return conflicts;
}

