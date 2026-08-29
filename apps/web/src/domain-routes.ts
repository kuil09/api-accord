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

function htmlPage(title: string, bodyContent: string, orgId?: string): string {
  const orgParam = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} - API Accord</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <main>
    <nav class="navbar">
      <a href="/ui/workspace${orgParam}" class="nav-brand">API Accord</a>
      <div class="nav-links">
        <a href="/ui/workspace${orgParam}">Workspace</a>
        <a href="/ui/inbox?recipient=team-merchant${orgId ? `&organizationId=${encodeURIComponent(orgId)}` : ''}">Inbox</a>
        <a href="/">Home</a>
      </div>
    </nav>
    ${bodyContent}
    <footer>
      API Accord &middot; Contract &middot; Context &middot; Decision &middot; Evidence
    </footer>
  </main>
</body>
</html>`;
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

export function renderContextInspector(bundle: ContextBundle, orgId?: string): string {
  const content = [
    '<h1 class="page-title">Context Inspector</h1>',
    `<div class="section-box"><h2>Confirmed facts (${String(bundle.sections.confirmedFacts.length)})</h2><ul class="data-list">${claimList(bundle.sections.confirmedFacts)}</ul></div>`,
    `<div class="section-box"><h2>Assumptions / inferences (${String(bundle.sections.assumptions.length)})</h2><ul class="data-list">${claimList(bundle.sections.assumptions)}</ul></div>`,
    `<div class="section-box"><h2>Conflicts (${String(bundle.sections.conflicts.length)})</h2><ul class="data-list">${bundle.sections.conflicts.map((conflict) => `<li>${escapeHtml(conflict.claimA.statement)} &lt;-&gt; ${escapeHtml(conflict.claimB.statement)}</li>`).join('') || '<li class="empty">none</li>'}</ul></div>`,
    `<div class="section-box"><h2>Stale (${String(bundle.sections.stale.length)})</h2><ul class="data-list">${claimList(bundle.sections.stale)}</ul></div>`,
    `<div class="section-box"><h2>Unsupported - 근거 없음 (${String(bundle.sections.unsupported.length)})</h2><ul class="data-list">${claimList(bundle.sections.unsupported)}</ul></div>`,
    `<div class="section-box"><h2>Contract/implementation/runtime mismatches (${String(bundle.sections.mismatches.length)})</h2><ul class="data-list">${claimList(bundle.sections.mismatches)}</ul></div>`,
    `<div class="section-box"><h2>Needs human review (${String(bundle.sections.needsHumanReview.length)})</h2><ul class="data-list">${claimList(bundle.sections.needsHumanReview)}</ul></div>`
  ].join('\n');
  return htmlPage('Context Inspector', content, orgId);
}

export function renderWorkspace(data: {
  readonly services: ReadonlyArray<{ readonly serviceId: string; readonly name: string; readonly kind: string }>;
  readonly proposals: ReadonlyArray<{ readonly proposalId: string; readonly title: string; readonly phase: string; readonly accepted: boolean; readonly openBlockingObjections: number }>;
}, orgId?: string): string {
  const orgParam = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';
  const serviceList = data.services
    .map((service) => `<li><a href="/ui/operations/${encodeURIComponent(`${service.serviceId}:`)}/context${orgParam}"><strong>${escapeHtml(service.name)}</strong></a> <span class="badge badge-${escapeHtml(service.kind)}">${escapeHtml(service.kind)}</span></li>`)
    .join('');
  const proposalList = data.proposals
    .map((proposal) => `<li><a href="/ui/proposals/${encodeURIComponent(proposal.proposalId)}${orgParam}"><strong>${escapeHtml(proposal.title)}</strong></a> <span class="badge">phase: ${escapeHtml(proposal.phase)}</span> ${proposal.openBlockingObjections > 0 ? '<span class="badge badge-blocking">blocking objections</span>' : ''}</li>`)
    .join('');
  const content = [
    '<h1 class="page-title">API Workspace</h1>',
    `<div class="section-box"><h2>Services (${String(data.services.length)})</h2><ul class="data-list">${serviceList || '<li class="empty">none</li>'}</ul></div>`,
    `<div class="section-box"><h2>Open change proposals (${String(data.proposals.length)})</h2><ul class="data-list">${proposalList || '<li class="empty">none</li>'}</ul></div>`
  ].join('\n');
  return htmlPage('API Workspace', content, orgId);
}

export function renderProposalDetail(data: {
  readonly proposal: { readonly id: string; readonly title: string; readonly phase: string; readonly accepted: boolean; readonly openBlockingObjections: number };
  readonly discussion: { readonly unresolvedQuestions: ReadonlyArray<{ readonly body: string }>; readonly openBlockingObjections: ReadonlyArray<{ readonly body: string }>; readonly resolvedCount: number };
  readonly decisions: ReadonlyArray<{ readonly id: string; readonly decision: string; readonly supersededBy?: string | undefined }>;
}, orgId?: string): string {
  const content = [
    '<h1 class="page-title">Change Proposal</h1>',
    `<div class="section-box"><p><strong>${escapeHtml(data.proposal.title)}</strong> &middot; <span class="badge">phase: ${escapeHtml(data.proposal.phase)}</span> <span class="badge">accepted: ${String(data.proposal.accepted)}</span> ${data.proposal.openBlockingObjections > 0 ? '<span class="badge badge-blocking">open objections: ' + String(data.proposal.openBlockingObjections) + '</span>' : ''}</p></div>`,
    `<div class="section-box"><h2>Unresolved questions</h2><ul class="data-list">${data.discussion.unresolvedQuestions.map((question) => `<li>${escapeHtml(question.body)}</li>`).join('') || '<li class="empty">none</li>'}</ul></div>`,
    `<div class="section-box"><h2>Open blocking objections</h2><ul class="data-list">${data.discussion.openBlockingObjections.map((objection) => `<li><span class="badge badge-blocking">BLOCKING</span> ${escapeHtml(objection.body)}</li>`).join('') || '<li class="empty">none</li>'}</ul></div>`,
    `<div class="section-box"><h2>Decisions</h2><ul class="data-list">${data.decisions.map((record) => `<li>${escapeHtml(record.decision)}${record.supersededBy !== undefined ? ' <span class="badge">SUPERSEDED</span>' : ''}</li>`).join('') || '<li class="empty">none</li>'}</ul></div>`
  ].join('\n');
  return htmlPage(data.proposal.title, content, orgId);
}

export function renderInbox(data: {
  readonly awaitingMyApproval: ReadonlyArray<{ readonly reason: string }>;
  readonly awaitingMyImplementation: ReadonlyArray<{ readonly reason: string }>;
  readonly contextsToReview: ReadonlyArray<{ readonly reason: string }>;
  readonly overdue: ReadonlyArray<{ readonly reason: string }>;
  readonly informational: ReadonlyArray<{ readonly reason: string }>;
}, orgId?: string): string {
  const section = (title: string, items: ReadonlyArray<{ readonly reason: string }>): string =>
    `<div class="section-box"><h2>${title} (${String(items.length)})</h2><ul class="data-list">${items.map((item) => `<li>${escapeHtml(item.reason)}</li>`).join('') || '<li class="empty">none</li>'}</ul></div>`;
  const content = [
    '<h1 class="page-title">Action Inbox</h1>',
    section('Awaiting my approval', data.awaitingMyApproval),
    section('Awaiting my implementation', data.awaitingMyImplementation),
    section('Contexts to review', data.contextsToReview),
    section('Overdue', data.overdue),
    section('Informational', data.informational)
  ].join('\n');
  return htmlPage('Action Inbox', content, orgId);
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

  return { handled: false };
}
