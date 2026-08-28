// MCP resource layer (issue #14): stable resource URIs backed by the SAME
// domain projections the Web UI uses (INV-029). No data copies; every read
// reconstructs state from the shared event ledger.

import type { EventEnvelope, DomainEvent } from '@api-accord/domain';
import {
  changeProposalState,
  decisionRecordFrom,
  dependencyEdgeFrom,
  discussionSummary,
  type ChangeProposalId,
  type DecisionRecordId,
  type DependencyEdgeId,
  type DiscussionEntryId
} from '@api-accord/domain';
import { McpError } from './errors.js';

export const MCP_RESOURCE_SCHEME = 'api';

export type ResourceType =
  | 'organizations'
  | 'services'
  | 'contracts'
  | 'operations'
  | 'dependencies'
  | 'proposals'
  | 'decisions'
  | 'principals'
  | 'changes';

export function formatResourceUri(type: ResourceType, id: string): string {
  return `${MCP_RESOURCE_SCHEME}://${type}/${id}`;
}

export function parseResourceUri(uri: string): { readonly type: ResourceType; readonly id: string } {
  const prefix = `${MCP_RESOURCE_SCHEME}://`;
  if (!uri.startsWith(prefix)) {
    throw new McpError('invalid-input', `resource uri must use the '${MCP_RESOURCE_SCHEME}://' scheme`);
  }
  const rest = uri.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) {
    throw new McpError('invalid-input', `resource uri '${uri}' is missing an id segment`);
  }
  const type = rest.slice(0, slash);
  const id = rest.slice(slash + 1);
  const known: ReadonlyArray<ResourceType> = ['organizations', 'services', 'contracts', 'operations', 'dependencies', 'proposals', 'decisions', 'principals', 'changes'];
  if (!known.includes(type as ResourceType)) {
    throw new McpError('invalid-input', `unknown resource type '${type}'`);
  }
  return { type: type as ResourceType, id };
}

export interface McpResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly status: 'available' | 'reserved';
}

// Capability discovery (issue #14). Resources whose aggregate projections are
// not built yet are listed as reserved rather than silently missing.
export function listResourceDescriptors(): ReadonlyArray<McpResourceDescriptor> {
  return [
    { uri: formatResourceUri('organizations', '{id}'), name: 'organization', status: 'reserved' },
    { uri: formatResourceUri('services', '{serviceId}'), name: 'service', status: 'reserved' },
    { uri: formatResourceUri('contracts', '{contractId}'), name: 'contract', status: 'reserved' },
    { uri: formatResourceUri('operations', '{operationId}'), name: 'operation', status: 'reserved' },
    { uri: formatResourceUri('dependencies', '{edgeId}'), name: 'dependency edge', status: 'available' },
    { uri: formatResourceUri('proposals', '{proposalId}'), name: 'change proposal', status: 'available' },
    { uri: formatResourceUri('decisions', '{decisionId}'), name: 'decision record', status: 'available' },
    { uri: formatResourceUri('principals', 'me/actions'), name: 'my pending actions', status: 'available' },
    { uri: formatResourceUri('changes', 'pending'), name: 'pending changes', status: 'available' }
  ];
}

function allProposalIds(events: ReadonlyArray<EventEnvelope<DomainEvent>>): ChangeProposalId[] {
  const ids = new Set<ChangeProposalId>();
  for (const envelope of events) {
    if (envelope.aggregateType === 'changeProposal') {
      ids.add(envelope.aggregateId as ChangeProposalId);
    }
  }
  return [...ids];
}

function allEntryIdsByProposal(events: ReadonlyArray<EventEnvelope<DomainEvent>>): Map<ChangeProposalId, DiscussionEntryId[]> {
  const map = new Map<ChangeProposalId, DiscussionEntryId[]>();
  for (const envelope of events) {
    if (envelope.aggregateType === 'discussionEntry' && envelope.event.type === 'DiscussionEntryCreated') {
      const list = map.get(envelope.event.proposalId) ?? [];
      list.push(envelope.event.entryId);
      map.set(envelope.event.proposalId, list);
    }
  }
  return map;
}

// Reads a resource. Aggregate ids must be handed in by the caller for the
// single-aggregate reads; the pending-change reads scan the whole ledger.
export function readResource(
  uri: string,
  events: ReadonlyArray<EventEnvelope<DomainEvent>>,
  resolveAggregateId: (type: ResourceType, id: string) => string
): unknown {
  const parsed = parseResourceUri(uri);
  switch (parsed.type) {
    case 'proposals': {
      const proposalId = resolveAggregateId(parsed.type, parsed.id) as ChangeProposalId;
      const state = changeProposalState(events, proposalId);
      if (state === undefined) {
        throw new McpError('not-found', `proposal '${parsed.id}' not found`);
      }
      const entryIds = allEntryIdsByProposal(events).get(proposalId) ?? [];
      return { proposal: state, discussion: discussionSummary(events, entryIds) };
    }
    case 'decisions': {
      const decisionId = resolveAggregateId(parsed.type, parsed.id) as DecisionRecordId;
      const record = decisionRecordFrom(events, decisionId);
      if (record === undefined) {
        throw new McpError('not-found', `decision record '${parsed.id}' not found`);
      }
      return record;
    }
    case 'dependencies': {
      const edgeId = resolveAggregateId(parsed.type, parsed.id) as DependencyEdgeId;
      const edge = dependencyEdgeFrom(events, edgeId);
      if (edge === undefined) {
        throw new McpError('not-found', `dependency edge '${parsed.id}' not found`);
      }
      return edge;
    }
    case 'changes':
      if (parsed.id !== 'pending') {
        throw new McpError('invalid-input', `unknown changes resource '${parsed.id}'`);
      }
      return listPendingChanges(events);
    case 'principals':
      if (parsed.id !== 'me/actions') {
        throw new McpError('invalid-input', `unknown principals resource '${parsed.id}'`);
      }
      return listPendingChanges(events);
    default:
      throw new McpError('not-implemented', `resource type '${parsed.type}' is reserved for a later increment`);
  }
}

export interface PendingChange {
  readonly proposalId: ChangeProposalId;
  readonly title: string;
  readonly phase: string;
  readonly accepted: boolean;
  readonly openBlockingObjections: number;
  readonly unresolvedQuestions: number;
}

function listPendingChanges(events: ReadonlyArray<EventEnvelope<DomainEvent>>): ReadonlyArray<PendingChange> {
  const entriesByProposal = allEntryIdsByProposal(events);
  const pending: PendingChange[] = [];
  for (const proposalId of allProposalIds(events)) {
    const state = changeProposalState(events, proposalId);
    if (state === undefined || state.phase === 'closed') {
      continue;
    }
    const summary = discussionSummary(events, entriesByProposal.get(proposalId) ?? []);
    pending.push({
      proposalId,
      title: state.title,
      phase: state.phase,
      accepted: state.accepted,
      openBlockingObjections: state.openBlockingObjections,
      unresolvedQuestions: summary.unresolvedQuestions.length
    });
  }
  return pending.sort((left, right) => left.proposalId.localeCompare(right.proposalId));
}
