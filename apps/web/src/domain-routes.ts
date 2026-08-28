// Domain-backed read API and minimal server-rendered screens for the Web UI
// (issue #20). These routes serve the SAME projections the MCP tools use,
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

// --- HTML rendering (minimal desktop-first screens) ---

function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

function authorBadge(claim: { readonly author?: { readonly kind: string } | undefined }): string {
  const kind = claim.author?.kind ?? 'unknown';
  return `<span class="badge badge-${escapeHtml(kind)}">${escapeHtml(kind.toUpperCase())}</span>`;
}

function claimList(claims: ReadonlyArray<{ readonly statement: string; readonly author?: { readonly kind: string } | undefined; readonly sourceRef?: string | undefined; readonly confidence: string }>): string {
  if (claims.length === 0) {
    return '<li class="empty">none</li>';
  }
  return claims
    .map((claim) => `<li>${authorBadge(claim)} <strong>${escapeHtml(claim.confidence)}</strong> ${escapeHtml(claim.statement)} <code>${escapeHtml(claim.sourceRef ?? '근거 없음')}</code></li>`)
    .join('');
}

export function renderContextInspector(bundle: ContextBundle): string {
  return [
    '<h1>Context Inspector</h1>',
    `<h2>Confirmed facts (${String(bundle.sections.confirmedFacts.length)})</h2><ul>${claimList(bundle.sections.confirmedFacts)}</ul>`,
    `<h2>Assumptions / inferences (${String(bundle.sections.assumptions.length)})</h2><ul>${claimList(bundle.sections.assumptions)}</ul>`,
    `<h2>Conflicts (${String(bundle.sections.conflicts.length)})</h2><ul>${bundle.sections.conflicts.map((conflict) => `<li>${escapeHtml(conflict.claimA.statement)} &lt;-&gt; ${escapeHtml(conflict.claimB.statement)}</li>`).join('') || '<li class="empty">none</li>'}</ul>`,
    `<h2>Stale (${String(bundle.sections.stale.length)})</h2><ul>${claimList(bundle.sections.stale)}</ul>`,
    `<h2>Unsupported - 근거 없음 (${String(bundle.sections.unsupported.length)})</h2><ul>${claimList(bundle.sections.unsupported)}</ul>`,
    `<h2>Contract/implementation/runtime mismatches (${String(bundle.sections.mismatches.length)})</h2><ul>${claimList(bundle.sections.mismatches)}</ul>`,
    `<h2>Needs human review (${String(bundle.sections.needsHumanReview.length)})</h2><ul>${claimList(bundle.sections.needsHumanReview)}</ul>`
  ].join('\n');
}

export function renderWorkspace(data: {
  readonly services: ReadonlyArray<{ readonly serviceId: string; readonly name: string; readonly kind: string }>;
  readonly proposals: ReadonlyArray<{ readonly proposalId: string; readonly title: string; readonly phase: string; readonly accepted: boolean; readonly openBlockingObjections: number }>;
}): string {
  const serviceList = data.services
    .map((service) => `<li><a href="/ui/operations/${encodeURIComponent(`${service.serviceId}:`)}">${escapeHtml(service.name)}</a> <span class="badge">${escapeHtml(service.kind)}</span></li>`)
    .join('');
  const proposalList = data.proposals
    .map((proposal) => `<li><a href="/ui/proposals/${encodeURIComponent(proposal.proposalId)}">${escapeHtml(proposal.title)}</a> phase=${escapeHtml(proposal.phase)} objections=${String(proposal.openBlockingObjections)}</li>`)
    .join('');
  return [
    '<h1>API Workspace</h1>',
    `<h2>Services (${String(data.services.length)})</h2><ul>${serviceList || '<li class="empty">none</li>'}</ul>`,
    `<h2>Open change proposals (${String(data.proposals.length)})</h2><ul>${proposalList || '<li class="empty">none</li>'}</ul>`,
    '<p><a href="/ui/inbox">Action Inbox</a></p>'
  ].join('\n');
}

export function renderProposalDetail(data: {
  readonly proposal: { readonly id: string; readonly title: string; readonly phase: string; readonly accepted: boolean; readonly openBlockingObjections: number };
  readonly discussion: { readonly unresolvedQuestions: ReadonlyArray<{ readonly body: string }>; readonly openBlockingObjections: ReadonlyArray<{ readonly body: string }>; readonly resolvedCount: number };
  readonly decisions: ReadonlyArray<{ readonly id: string; readonly decision: string; readonly supersededBy?: string | undefined }>;
}): string {
  return [
    '<h1>Change Proposal</h1>',
    `<p><strong>${escapeHtml(data.proposal.title)}</strong> phase=${escapeHtml(data.proposal.phase)} accepted=${String(data.proposal.accepted)} openObjections=${String(data.proposal.openBlockingObjections)}</p>`,
    `<h2>Unresolved questions</h2><ul>${data.discussion.unresolvedQuestions.map((question) => `<li>${escapeHtml(question.body)}</li>`).join('') || '<li class="empty">none</li>'}</ul>`,
    `<h2>Open blocking objections</h2><ul>${data.discussion.openBlockingObjections.map((objection) => `<li>${escapeHtml(objection.body)}</li>`).join('') || '<li class="empty">none</li>'}</ul>`,
    '<h2>Decisions</h2><ul>',
    data.decisions.map((record) => `<li>${escapeHtml(record.decision)}${record.supersededBy !== undefined ? ' <span class="badge">SUPERSEDED</span>' : ''}</li>`).join(''),
    '</ul>'
  ].join('\n');
}

export function renderInbox(data: {
  readonly awaitingMyApproval: ReadonlyArray<{ readonly reason: string }>;
  readonly awaitingMyImplementation: ReadonlyArray<{ readonly reason: string }>;
  readonly contextsToReview: ReadonlyArray<{ readonly reason: string }>;
  readonly overdue: ReadonlyArray<{ readonly reason: string }>;
  readonly informational: ReadonlyArray<{ readonly reason: string }>;
}): string {
  const section = (title: string, items: ReadonlyArray<{ readonly reason: string }>): string =>
    `<h2>${title} (${String(items.length)})</h2><ul>${items.map((item) => `<li>${escapeHtml(item.reason)}</li>`).join('') || '<li class="empty">none</li>'}</ul>`;
  return [
    '<h1>Action Inbox</h1>',
    section('Awaiting my approval', data.awaitingMyApproval),
    section('Awaiting my implementation', data.awaitingMyImplementation),
    section('Contexts to review', data.contextsToReview),
    section('Overdue', data.overdue),
    section('Informational', data.informational)
  ].join('\n');
}

// --- Route dispatch ---

export async function handleDomainRoute(
  url: URL,
  events: ReadonlyArray<EventEnvelope<DomainEvent>>,
  callerOrganizationId: string | undefined,
  _correlationId: string
): Promise<{ readonly handled: true; readonly statusCode: number; readonly body: string; readonly contentType: 'json' | 'html' } | { readonly handled: false }> {
  const path = url.pathname;

  if (path === '/api/workspace' || path === '/ui/workspace') {
    const organizationId = url.searchParams.get('organizationId') ?? callerOrganizationId ?? '';
    requireOrganization(callerOrganizationId, organizationId, 'workspace');
    const data = workspaceData(events, organizationId);
    return { handled: true, statusCode: 200, body: path.startsWith('/api/') ? JSON.stringify(data) : renderWorkspace(data as Parameters<typeof renderWorkspace>[0]), contentType: path.startsWith('/api/') ? 'json' : 'html' };
  }

  if (path.startsWith('/api/proposals/') || path.startsWith('/ui/proposals/')) {
    const proposalId = decodeURIComponent(path.split('/').pop() ?? '');
    const org = organizationOfProposal(events, proposalId);
    requireOrganization(callerOrganizationId, org, 'resource');
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
    return { handled: true, statusCode: 200, body: renderProposalDetail(data as Parameters<typeof renderProposalDetail>[0]), contentType: 'html' };
  }

  if (path.startsWith('/api/operations/') && path.endsWith('/context') || path.startsWith('/ui/operations/') && path.endsWith('/context')) {
    const operationKey = decodeURIComponent(path.replace('/context', '').replace('/api/operations/', '').replace('/ui/operations/', ''));
    const contractId = operationKey.slice(0, Math.max(0, operationKey.indexOf(':')));
    const org = organizationOfContract(events, contractId);
    requireOrganization(callerOrganizationId, org, 'resource');
    const bundle = operationContextData(events, operationKey);
    if (path.startsWith('/api/')) {
      return { handled: true, statusCode: 200, body: JSON.stringify(bundle), contentType: 'json' };
    }
    return { handled: true, statusCode: 200, body: renderContextInspector(bundle), contentType: 'html' };
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
    return { handled: true, statusCode: 200, body: renderInbox(data as Parameters<typeof renderInbox>[0]), contentType: 'html' };
  }

  return { handled: false };
}
