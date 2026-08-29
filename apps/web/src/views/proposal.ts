// Proposal detail screen renderer

import { htmlPage } from './layout.js';
import {
  sectionBox,
  card,
  renderList,
  timeline,
  Badge,
  tabs,
  emptyState,
  phaseProgress
} from './components.js';
import type { DiscussionSummary } from '@api-accord/domain';

export interface ProposalData {
  readonly proposal: {
    readonly id: string;
    readonly title: string;
    readonly phase: string;
    readonly accepted: boolean;
    readonly openBlockingObjections: number;
  };
  readonly discussion: DiscussionSummary;
  readonly decisions: ReadonlyArray<{
    readonly id: string;
    readonly decision: string;
    readonly constraints?: string;
    readonly rejectedAlternatives?: string;
    readonly supersededBy?: string | undefined;
    readonly validityWindow?: { readonly from: string; readonly to?: string } | undefined;
  }>;
}

export function renderProposalDetail(data: ProposalData, orgId?: string): string {
  const orgParam = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';

  // Discussion tabs
  const discussionTabs = tabs([
    {
      id: 'questions',
      label: 'Questions',
      count: data.discussion.unresolvedQuestions.length,
      content: renderList(
        data.discussion.unresolvedQuestions.map((q) => ({
          label: q.body,
          badges: [Badge.custom('unresolved', 'warning')]
        })),
        'No unresolved questions'
      )
    },
    {
      id: 'objections',
      label: 'Objections',
      count: data.discussion.openBlockingObjections.length,
      badgeVariant: 'blocking',
      content: renderList(
        data.discussion.openBlockingObjections.map((o) => ({
          label: o.body,
          badges: [Badge.blocking(), Badge.custom('blocking', 'error')]
        })),
        'No open blocking objections'
      )
    },
    {
      id: 'resolved',
      label: 'Resolved',
      count: data.discussion.resolvedCount,
      content: `<p class="muted">${data.discussion.resolvedCount} entries resolved</p>`
    }
  ]);

  // Decisions list
  const decisionsContent =
    data.decisions.length > 0
      ? data.decisions
          .map((d) => card({
            title: `Decision: ${d.id}`,
            content: `
<div class="decision-body">
  <p><strong>Decision:</strong> ${escapeHtml(d.decision)}</p>
  ${d.constraints ? `<p><strong>Constraints:</strong> ${escapeHtml(d.constraints)}</p>` : ''}
  ${d.rejectedAlternatives ? `<p><strong>Rejected Alternatives:</strong> ${escapeHtml(d.rejectedAlternatives)}</p>` : ''}
  ${d.validityWindow ? `<p><strong>Validity:</strong> ${escapeHtml(d.validityWindow.from)}${d.validityWindow.to ? ` → ${escapeHtml(d.validityWindow.to)}` : ' (open-ended)'}</p>` : ''}
  ${d.supersededBy ? `<p><strong>Superseded by:</strong> ${escapeHtml(d.supersededBy)}</p>` : ''}
</div>`,
            badges: [d.supersededBy ? Badge.superseded() : Badge.custom('active', 'success')],
            actions: [{ label: 'View Details', href: `#`, variant: 'secondary' }]
          }))
          .join('')
      : emptyState('No decisions recorded for this proposal');

  const content = `
<div class="proposal-detail">
  <header class="page-header">
    <h1>${escapeHtml(data.proposal.title)}</h1>
    <p class="page-subtitle">Proposal ID: <code>${escapeHtml(data.proposal.id)}</code></p>
  </header>

  <div class="proposal-meta">
    ${phaseProgress(data.proposal.phase)}
    <div class="proposal-status-badges">
      ${Badge.phase(data.proposal.phase)}
      ${data.proposal.openBlockingObjections > 0 ? Badge.custom(`${data.proposal.openBlockingObjections} blocking objections`, 'error') : Badge.custom('no blocking objections', 'success')}
      ${data.proposal.accepted ? Badge.custom('accepted', 'success') : Badge.custom('pending acceptance', 'warning')}
    </div>
  </div>

  <section class="proposal-section">
    <h2>Discussion</h2>
    ${discussionTabs}
  </section>

  <section class="proposal-section">
    <h2>Decisions</h2>
    ${decisionsContent}
  </section>
</div>`;

  return htmlPage(data.proposal.title, content, orgId);
}

function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&').replace(/</gu, '<').replace(/>/gu, '>').replace(/"/gu, '"');
}