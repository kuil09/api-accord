// Domain-backed read API and minimal server-rendered screens for the Web UI
// (issue #20, #52). These routes serve the SAME projections the MCP tools use,
// enforcing the organization boundary on every read (INV-029). Mutations stay
// in the domain commands (exposed via MCP/workflow); this increment ships the
// core read surfaces: workspace, proposals, operation context inspector,
// dependency detail and the personal action inbox.

import type { EventEnvelope, DomainEvent, EventStore } from '@api-accord/domain';
import {
  allDependencyEdges,
  assembleContextBundle,
  buildActionInbox,
  changeProposalState,
  decisionRecordFrom,
  discussionSummary,
  driftIncidentsFrom,
  enforceOrganizationBoundary,
  notificationsFrom,
  type ContextBundle,
  type DependencyEdge,
  type DriftIncident
} from '@api-accord/domain';
import {
  renderWorkspace,
  renderProposalDetail,
  renderContextInspector,
  renderInbox,
  renderLanding
} from './views/index.js';

export interface WebDomainContext {
  readonly store: EventStore;
}

export class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

function organizationOfContract(events: ReadonlyArray<EventEnvelope<DomainEvent>>, contractId: string): string | undefined {
  for (const envelope of events) {
    if (envelope.event.type === 'ApiContractImported' && envelope.event.contractId === contractId) {
      return envelope.event.organizationId;
    }
    if (envelope.event.type === 'ContractImported' && envelope.event.contractId === contractId) {
      return envelope.event.organizationId;
    }
  }
  return undefined;
}

function organizationOfProposal(events: ReadonlyArray<EventEnvelope<DomainEvent>>, proposalId: string): string | undefined {
  for (const envelope of events) {
    if (envelope.aggregateType === 'changeProposal' && envelope.aggregateId === proposalId && envelope.event.type === 'ChangeProposalOpened') {
      return organizationOfContract(events, envelope.event.contractId);
    }
  }
  return undefined;
}

function requireOrganization(callerOrganizationId: string | undefined, resourceOrganizationId: string | undefined, resourceLabel = 'resource'): void {
  if (resourceOrganizationId === undefined) {
    throw new HttpError(404, 'not_found', `${resourceLabel} not found`);
  }
  const check = enforceOrganizationBoundary({
    callerOrganizationId: callerOrganizationId ?? '',
    resourceOrganizationId
  });
  if (!check.ok) {
    throw new HttpError(403, 'organization_boundary', check.reason);
  }
}

function pendingProposals(events: ReadonlyArray<EventEnvelope<DomainEvent>>): ReadonlyArray<{ readonly proposalId: string; readonly title: string; readonly phase: string; readonly accepted: boolean; readonly openBlockingObjections: number }> {
  const ids = new Set<string>();
  for (const envelope of events) {
    if (envelope.aggregateType === 'changeProposal') {
      ids.add(envelope.aggregateId);
    }
  }
  const pending: Array<{ proposalId: string; title: string; phase: string; accepted: boolean; openBlockingObjections: number }> = [];
  for (const proposalId of ids) {
    const state = changeProposalState(events, proposalId as import('@api-accord/domain').ChangeProposalId);
    if (state === undefined || state.phase === 'closed') {
      continue;
    }
    pending.push({ proposalId, title: state.title, phase: state.phase, accepted: state.accepted, openBlockingObjections: state.openBlockingObjections });
  }
  return pending.sort((left, right) => left.proposalId.localeCompare(right.proposalId));
}

function contractIdOfProposal(events: ReadonlyArray<EventEnvelope<DomainEvent>>, proposalId: string): string | undefined {
  for (const envelope of events) {
    if (envelope.aggregateType === 'changeProposal' && envelope.aggregateId === proposalId && envelope.event.type === 'ChangeProposalOpened') {
      return envelope.event.contractId;
    }
  }
  return undefined;
}

// --- JSON API handlers ---

export function workspaceData(events: ReadonlyArray<EventEnvelope<DomainEvent>>, organizationId: string): unknown {
  const services = events
    .filter((envelope) => envelope.event.type === 'ServiceRegistered' && envelope.event.organizationId === organizationId)
    .map((envelope) => (envelope.event.type === 'ServiceRegistered' ? { serviceId: envelope.event.serviceId, name: envelope.event.name, kind: envelope.event.kind } : undefined))
    .filter((service) => service !== undefined);
  const contracts = events
    .filter((envelope) => envelope.event.type === 'ApiContractImported' && envelope.event.organizationId === organizationId)
    .map((envelope) => (envelope.event.type === 'ApiContractImported' ? { contractId: envelope.event.contractId, title: envelope.event.title, providerServiceId: envelope.event.providerServiceId } : undefined))
    .filter((contract) => contract !== undefined);
  const contractIds = new Set<string>(contracts.map((contract) => contract?.contractId));
  const proposals = pendingProposals(events).filter((proposal) => {
    const contractId = contractIdOfProposal(events, proposal.proposalId);
    return contractId !== undefined && contractIds.has(contractId);
  });
  const openDrift = driftIncidentsFrom(events).filter((incident) => incident.status === 'open');
  return { organizationId, services, contracts, proposals, openDriftCount: openDrift.length };
}

export function proposalDetailData(events: ReadonlyArray<EventEnvelope<DomainEvent>>, proposalId: string): unknown {
  const state = changeProposalState(events, proposalId as import('@api-accord/domain').ChangeProposalId);
  if (state === undefined) {
    throw new HttpError(404, 'not_found', `proposal '${proposalId}' not found`);
  }
  const entryIds: import('@api-accord/domain').DiscussionEntryId[] = [];
  for (const envelope of events) {
    if (envelope.aggregateType === 'discussionEntry' && envelope.event.type === 'DiscussionEntryCreated' && envelope.event.proposalId === proposalId) {
      entryIds.push(envelope.event.entryId);
    }
  }
  const decisions = events
    .filter((envelope) => envelope.aggregateType === 'decisionRecord')
    .map((envelope) => envelope.aggregateId)
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .map((id) => decisionRecordFrom(events, id as never))
    .filter((record) => record !== undefined && record.proposalId === proposalId);
  return { proposal: state, discussion: discussionSummary(events, entryIds), decisions };
}

export function operationContextData(events: ReadonlyArray<EventEnvelope<DomainEvent>>, operationKey: string): ContextBundle {
  return assembleContextBundle({ events, computedBy: { kind: 'human', id: 'web-ui' }, now: new Date(), operationKey });
}

export function inboxData(events: ReadonlyArray<EventEnvelope<DomainEvent>>, recipientId: string, now: Date): unknown {
  return buildActionInbox({ recipient: { kind: 'team', id: recipientId }, notifications: notificationsFrom(events), now });
}

// --- Route dispatch ---

export async function handleDomainRoute(
  url: URL,
  events: ReadonlyArray<EventEnvelope<DomainEvent>>,
  callerOrganizationId: string | undefined,
  _correlationId: string
): Promise<{ readonly handled: true; readonly statusCode: number; readonly body: string; readonly contentType: 'json' | 'html' } | { readonly handled: false }> {
  const effectiveCallerOrg = callerOrganizationId ?? url.searchParams.get('organizationId') ?? undefined;
  const path = url.pathname;

  if (path === '/api/workspace' || path === '/ui/workspace') {
    const organizationId = url.searchParams.get('organizationId') ?? effectiveCallerOrg ?? '';
    requireOrganization(effectiveCallerOrg, organizationId, 'workspace');
    const data = workspaceData(events, organizationId);
    return { handled: true, statusCode: 200, body: path.startsWith('/api/') ? JSON.stringify(data) : renderWorkspace(data as Parameters<typeof renderWorkspace>[0], organizationId), contentType: path.startsWith('/api/') ? 'json' : 'html' };
  }

  if (path.startsWith('/api/proposals/') || path.startsWith('/ui/proposals/')) {
    const proposalId = decodeURIComponent(path.split('/').pop() ?? '');
    const org = organizationOfProposal(events, proposalId);
    requireOrganization(effectiveCallerOrg, org, 'resource');
    const state = changeProposalState(events, proposalId as import('@api-accord/domain').ChangeProposalId);
    if (state === undefined) {
      throw new HttpError(404, 'not_found', `proposal '${proposalId}' not found`);
    }
    const entryIds: import('@api-accord/domain').DiscussionEntryId[] = [];
    for (const envelope of events) {
      if (envelope.aggregateType === 'discussionEntry' && envelope.event.type === 'DiscussionEntryCreated' && envelope.event.proposalId === proposalId) {
        entryIds.push(envelope.event.entryId);
      }
    }
    const decisions = events
      .filter((envelope) => envelope.aggregateType === 'decisionRecord')
      .map((envelope) => envelope.aggregateId)
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .map((id) => decisionRecordFrom(events, id as never))
      .filter((record) => record !== undefined && record.proposalId === proposalId);
    const data = { proposal: state, discussion: discussionSummary(events, entryIds), decisions };
    if (path.startsWith('/api/')) {
      return { handled: true, statusCode: 200, body: JSON.stringify(data), contentType: 'json' };
    }
    return { handled: true, statusCode: 200, body: renderProposalDetail(data as Parameters<typeof renderProposalDetail>[0], org), contentType: 'html' };
  }

  if (path.startsWith('/api/operations/') && path.endsWith('/context') || path.startsWith('/ui/operations/') && path.endsWith('/context')) {
    const operationKey = decodeURIComponent(path.replace('/context', '').replace('/api/operations/', '').replace('/ui/operations/', ''));
    const contractId = operationKey.slice(0, Math.max(0, operationKey.indexOf(':')));
    const org = organizationOfContract(events, contractId);
    requireOrganization(effectiveCallerOrg, org, 'resource');
    const bundle = operationContextData(events, operationKey);
    if (path.startsWith('/api/')) {
      return { handled: true, statusCode: 200, body: JSON.stringify(bundle), contentType: 'json' };
    }
    return { handled: true, statusCode: 200, body: renderContextInspector(bundle, org), contentType: 'html' };
  }

  if (path === '/api/dependencies' || path === '/ui/dependencies') {
    const edges: ReadonlyArray<DependencyEdge> = allDependencyEdges(events);
    const incidents: ReadonlyArray<DriftIncident> = driftIncidentsFrom(events).filter((incident) => incident.status === 'open');
    const data = { dependencies: edges.map((edge) => ({ edgeId: edge.id, consumerServiceId: edge.consumerServiceId, operationId: edge.operationId, assumptions: edge.assumptions, deprecated: edge.deprecated })), openDrift: incidents.map((incident) => ({ incidentId: incident.incidentId, kind: incident.kind, occurrences: incident.occurrences })) };
    return { handled: true, statusCode: 200, body: JSON.stringify(data), contentType: 'json' };
  }

  if (path === '/api/actions' || path === '/ui/inbox') {
    const recipient = url.searchParams.get('recipient') ?? '';
    if (recipient.trim().length === 0) {
      throw new HttpError(400, 'invalid_input', "query parameter 'recipient' is required");
    }
    const data = inboxData(events, recipient, new Date());
    if (path === '/api/actions') {
      return { handled: true, statusCode: 200, body: JSON.stringify(data), contentType: 'json' };
    }
    return { handled: true, statusCode: 200, body: renderInbox(data as Parameters<typeof renderInbox>[0], effectiveCallerOrg), contentType: 'html' };
  }

  // Landing page at root
  if (path === '/' || path === '/ui') {
    return { handled: true, statusCode: 200, body: renderLanding(effectiveCallerOrg), contentType: 'html' };
  }

  return { handled: false };
}