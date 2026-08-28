// Pure projections: reconstruct current state and point-in-time state from the
// append-only event stream (INV-035). No side effects; given the same events,
// the result is deterministic. Corrections and supersedes never destroy the
// past — the original events remain and the derived state simply points at the
// newer item.

import type { ChangeProposalState, ContextItem, DecisionRecord, DependencyAssumption, DependencyEdge, DiscussionEntry, ProposalWorkItem } from './model.js';
import type { ChangeProposalId, Confidence, ContextItemId, ContextScope, DecisionRecordId, DependencyEdgeId, DiscussionEntryId, PrincipalRef, ServiceId } from './primitives.js';
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
  if (/optional/u.test(t) || (/not|never|does not|doesn't|isn't|aren't|without/u.test(t))) return -1;
  if (/always|must|is|exists|requires|guarantees|present/u.test(t)) return 1;
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


// Reconstructs a structured discussion entry (issue #8).
export function discussionEntryFrom(
  events: ReadonlyArray<EventEnvelope<DomainEvent>>,
  entryId: DiscussionEntryId
): DiscussionEntry | undefined {
  const stream = events
    .filter((envelope) => envelope.aggregateType === 'discussionEntry' && envelope.aggregateId === entryId)
    .sort((left, right) => left.version - right.version);

  let entry: DiscussionEntry | undefined;
  for (const envelope of stream) {
    const event = envelope.event;
    if (event.type === 'DiscussionEntryCreated') {
      entry = {
        id: entryId,
        proposalId: event.proposalId,
        kind: event.kind,
        author: event.author,
        body: event.body,
        isBlockingObjection: event.isBlockingObjection,
        status: 'open',
        affectedConsumers: event.affectedConsumers,
        severity: event.severity,
        evidenceRef: event.evidenceRef,
        inReplyTo: event.inReplyTo,
        quotes: event.quotes,
        duplicateOf: event.duplicateOf
      };
    } else if (event.type === 'DiscussionEntryResolved' && entry !== undefined) {
      entry = { ...entry, status: event.status };
    }
  }
  return entry;
}

// Reconstructs a Decision Record with its full lineage (issue #8, INV-013).
export function decisionRecordFrom(
  events: ReadonlyArray<EventEnvelope<DomainEvent>>,
  decisionRecordId: DecisionRecordId
): DecisionRecord | undefined {
  const stream = events
    .filter((envelope) => envelope.aggregateType === 'decisionRecord' && envelope.aggregateId === decisionRecordId)
    .sort((left, right) => left.version - right.version);

  let record: DecisionRecord | undefined;
  for (const envelope of stream) {
    const event = envelope.event;
    if (event.type === 'DecisionRecorded') {
      record = {
        id: decisionRecordId,
        proposalId: event.proposalId,
        decision: event.decision,
        rationale: event.rationale,
        constraints: event.constraints,
        rejectedAlternatives: event.rejectedAlternatives,
        approvers: event.approvers,
        validFrom: event.validFrom,
        validUntil: event.validUntil,
        sourceEntryIds: event.sourceEntryIds,
        supersedes: event.supersedes,
        supersededBy: undefined
      };
    } else if (event.type === 'DecisionSuperseded' && record !== undefined) {
      record = { ...record, supersededBy: event.supersedingDecisionRecordId };
    }
  }
  return record;
}

export interface DiscussionSummary {
  readonly entries: ReadonlyArray<DiscussionEntry>;
  // INV-014: unresolved questions and blocking objections never disappear.
  readonly unresolvedQuestions: ReadonlyArray<DiscussionEntry>;
  readonly openBlockingObjections: ReadonlyArray<DiscussionEntry>;
  readonly resolvedCount: number;
  readonly wontFixCount: number;
}

// Builds a summary of a proposal's discussion, preserving unresolved items and
// source links so a summary can never silently drop disagreement.
export function discussionSummary(
  events: ReadonlyArray<EventEnvelope<DomainEvent>>,
  entryIds: ReadonlyArray<DiscussionEntryId>
): DiscussionSummary {
  const entries: DiscussionEntry[] = [];
  for (const entryId of entryIds) {
    const entry = discussionEntryFrom(events, entryId);
    if (entry !== undefined) {
      entries.push(entry);
    }
  }
  return {
    entries,
    unresolvedQuestions: entries.filter((entry) => entry.kind === 'question' && entry.status === 'open'),
    openBlockingObjections: entries.filter((entry) => entry.isBlockingObjection && entry.status === 'open'),
    resolvedCount: entries.filter((entry) => entry.status === 'resolved').length,
    wontFixCount: entries.filter((entry) => entry.status === 'wont-fix').length
  };
}

export interface ProposalApprovals {
  readonly requiredApprovers: ReadonlyArray<PrincipalRef>;
  readonly givenApprovals: ReadonlyArray<PrincipalRef>;
  // Required approvers who have not approved yet (never silently dropped).
  readonly missingApprovers: ReadonlyArray<PrincipalRef>;
  readonly satisfied: boolean;
}

// Computes the required-approver state from the ledger (issue #9). A recorded
// approval whose approver has since withdrawn is not counted, so the requirement
// stays honest rather than latching to an old approval.
export function proposalApprovalsFrom(
  events: ReadonlyArray<EventEnvelope<DomainEvent>>,
  proposalId: ChangeProposalId
): ProposalApprovals {
  const stream = events
    .filter((envelope) => envelope.aggregateType === 'changeProposal' && envelope.aggregateId === proposalId)
    .sort((left, right) => left.version - right.version);

  const required: PrincipalRef[] = [];
  const given: PrincipalRef[] = [];
  for (const envelope of stream) {
    const event = envelope.event;
    if (event.type === 'RequiredApproversDeclared') {
      required.length = 0;
      required.push(...event.requiredApprovers);
    } else if (event.type === 'ApprovalRecorded') {
      const existing = given.findIndex((approver) => approver.id === event.approver.id);
      if (existing >= 0) {
        given[existing] = event.approver;
      } else {
        given.push(event.approver);
      }
    } else if (event.type === 'ApprovalWithdrawn') {
      const index = given.findIndex((approver) => approver.id === event.approver.id);
      if (index >= 0) {
        given.splice(index, 1);
      }
    }
  }

  const givenIds = new Set(given.map((approver) => approver.id));
  const missing = required.filter((approver) => !givenIds.has(approver.id));
  const satisfied = required.length > 0 && missing.length === 0;
  return { requiredApprovers: required, givenApprovals: given, missingApprovers: missing, satisfied };
}

export interface ConsumerReadinessState {
  readonly consumerServiceId: ServiceId;
  readonly ready: boolean;
  readonly deadline?: Date | undefined;
  readonly evidenceRef?: string | undefined;
  readonly acknowledged: boolean;
}

// Computes per-consumer readiness and migration deadlines (issue #9). Consumers
// with no declaration are not silently treated as ready; they simply do not
// appear here, so "unknown" stays distinguishable from "ready" (INV-009).
export function consumerReadinessFrom(
  events: ReadonlyArray<EventEnvelope<DomainEvent>>,
  proposalId: ChangeProposalId
): ReadonlyArray<ConsumerReadinessState> {
  const stream = events
    .filter((envelope) => envelope.aggregateType === 'changeProposal' && envelope.aggregateId === proposalId)
    .sort((left, right) => left.version - right.version);

  const states = new Map<string, ConsumerReadinessState>();
  for (const envelope of stream) {
    const event = envelope.event;
    if (event.type === 'ConsumerReadinessDeclared') {
      states.set(event.consumerServiceId, {
        consumerServiceId: event.consumerServiceId,
        ready: event.ready,
        deadline: event.deadline,
        evidenceRef: event.evidenceRef,
        acknowledged: false
      });
    } else if (event.type === 'ConsumerMigrationAcknowledged') {
      const current = states.get(event.consumerServiceId);
      if (current !== undefined) {
        states.set(event.consumerServiceId, { ...current, acknowledged: true });
      } else {
        states.set(event.consumerServiceId, {
          consumerServiceId: event.consumerServiceId,
          ready: false,
          deadline: undefined,
          evidenceRef: undefined,
          acknowledged: true
        });
      }
    }
  }
  return [...states.values()];
}

// Reconstructs the change work items of a proposal with their assignees and
// completion state (issue #9).
export function proposalWorkItemsFrom(
  events: ReadonlyArray<EventEnvelope<DomainEvent>>,
  proposalId: ChangeProposalId
): ReadonlyArray<ProposalWorkItem> {
  const stream = events
    .filter((envelope) => envelope.aggregateType === 'changeProposal' && envelope.aggregateId === proposalId)
    .sort((left, right) => left.version - right.version);

  const items = new Map<string, ProposalWorkItem>();
  for (const envelope of stream) {
    const event = envelope.event;
    if (event.type === 'ProposalWorkItemCreated') {
      items.set(event.workItemId, {
        id: event.workItemId,
        kind: event.kind,
        description: event.description,
        assignedTo: event.assignedTo,
        createdAt: event.at,
        completedAt: undefined
      });
    } else if (event.type === 'ProposalWorkItemCompleted') {
      const current = items.get(event.workItemId);
      if (current !== undefined) {
        items.set(event.workItemId, { ...current, completedAt: event.at });
      }
    }
  }
  return [...items.values()];
}

// Reconstructs every dependency edge in the ledger (issue #11 staleness input).
export function allDependencyEdges(events: ReadonlyArray<EventEnvelope<DomainEvent>>): ReadonlyArray<DependencyEdge> {
  const edgeIds = new Set<DependencyEdgeId>();
  for (const envelope of events) {
    if (envelope.aggregateType === 'dependencyEdge') {
      edgeIds.add(envelope.aggregateId as DependencyEdgeId);
    }
  }
  const edges: DependencyEdge[] = [];
  for (const edgeId of edgeIds) {
    const edge = dependencyEdgeFrom(events, edgeId);
    if (edge !== undefined) {
      edges.push(edge);
    }
  }
  return edges.sort((left, right) => left.id.localeCompare(right.id));
}

// Reconstructs every context item in the ledger (issue #14 MCP reads).
export function allContextItems(events: ReadonlyArray<EventEnvelope<DomainEvent>>): ReadonlyArray<ContextItem> {
  const ids = new Set<ContextItemId>();
  for (const envelope of events) {
    if (envelope.aggregateType === 'contextItem') {
      ids.add(envelope.aggregateId as ContextItemId);
    }
  }
  const items: ContextItem[] = [];
  for (const id of ids) {
    const item = contextItemFrom(events, id);
    if (item !== undefined) {
      items.push(item);
    }
  }
  return items.sort((left, right) => left.id.localeCompare(right.id));
}
