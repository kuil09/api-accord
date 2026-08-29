// Action Inbox screen renderer

import { htmlPage, escapeHtml } from './layout.js';
import {
  tabs
} from './components.js';

export interface InboxData {
  readonly awaitingMyApproval: ReadonlyArray<{ readonly reason: string; readonly proposalId?: string; readonly dueDate?: string }>;
  readonly awaitingMyImplementation: ReadonlyArray<{ readonly reason: string; readonly proposalId?: string; readonly dueDate?: string }>;
  readonly contextsToReview: ReadonlyArray<{ readonly reason: string; readonly contextId?: string }>;
  readonly overdue: ReadonlyArray<{ readonly reason: string; readonly dueDate?: string }>;
  readonly informational: ReadonlyArray<{ readonly reason: string }>;
}

export function renderInbox(data: InboxData, orgId?: string): string {
  const orgParam = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';

  function renderInboxItems(
    items: ReadonlyArray<{ readonly reason: string; readonly proposalId?: string; readonly dueDate?: string; readonly contextId?: string }>,
    type: 'approval' | 'implementation' | 'review' | 'overdue' | 'info'
  ): string {
    if (items.length === 0) {
      return '<p class="empty-section">No items</p>';
    }
    return `
<ul class="inbox-list">
  ${items
    .map(
      (item) => `
    <li class="inbox-item">
      <div class="inbox-item-main">
        <p class="inbox-reason">${escapeHtml(item.reason)}</p>
        <div class="inbox-meta">
          ${item.proposalId ? `<a href="/ui/proposals/${encodeURIComponent(item.proposalId)}${orgParam}" class="inbox-link">Proposal: ${escapeHtml(item.proposalId)}</a>` : ''}
          ${item.contextId ? `<a href="/ui/operations/${encodeURIComponent(item.contextId)}/context${orgParam}" class="inbox-link">Context: ${escapeHtml(item.contextId)}</a>` : ''}
          ${item.dueDate ? `<time class="inbox-due" datetime="${escapeHtml(item.dueDate)}">Due: ${escapeHtml(item.dueDate)}</time>` : ''}
        </div>
      </div>
      <div class="inbox-actions">
        ${type === 'approval'
          ? `<button class="btn btn-primary btn-sm" data-action="approve" data-proposal="${escapeHtml(item.proposalId ?? '')}">Approve</button>
             <button class="btn btn-secondary btn-sm" data-action="request-changes" data-proposal="${escapeHtml(item.proposalId ?? '')}">Request Changes</button>`
          : type === 'implementation'
            ? `<button class="btn btn-primary btn-sm" data-action="start-implementation" data-proposal="${escapeHtml(item.proposalId ?? '')}">Start</button>
               <button class="btn btn-secondary btn-sm" data-action="view-plan" data-proposal="${escapeHtml(item.proposalId ?? '')}">View Plan</button>`
            : type === 'review'
              ? `<button class="btn btn-primary btn-sm" data-action="review-context" data-context="${escapeHtml(item.contextId ?? '')}">Review</button>`
              : type === 'overdue'
                ? `<button class="btn btn-danger btn-sm" data-action="escalate" data-reason="${escapeHtml(item.reason)}">Escalate</button>`
                : `<button class="btn btn-secondary btn-sm" data-action="mark-read" data-reason="${escapeHtml(item.reason)}">Mark Read</button>`
        }
        <button class="btn btn-ghost btn-sm" data-action="snooze" data-reason="${escapeHtml(item.reason)}">Snooze</button>
      </div>
    </li>`
    )
    .join('')}
</ul>`;
  }

  const tabItems = [
    {
      id: 'approval',
      label: 'Awaiting My Approval',
      count: data.awaitingMyApproval.length,
      badgeVariant: data.awaitingMyApproval.length > 0 ? 'blocking' : 'default',
      content: renderInboxItems(data.awaitingMyApproval, 'approval')
    },
    {
      id: 'implementation',
      label: 'Awaiting My Implementation',
      count: data.awaitingMyImplementation.length,
      badgeVariant: data.awaitingMyImplementation.length > 0 ? 'warning' : 'default',
      content: renderInboxItems(data.awaitingMyImplementation, 'implementation')
    },
    {
      id: 'review',
      label: 'Contexts to Review',
      count: data.contextsToReview.length,
      badgeVariant: data.contextsToReview.length > 0 ? 'warning' : 'default',
      content: renderInboxItems(data.contextsToReview, 'review')
    },
    {
      id: 'overdue',
      label: 'Overdue',
      count: data.overdue.length,
      badgeVariant: data.overdue.length > 0 ? 'blocking' : 'default',
      content: renderInboxItems(data.overdue, 'overdue')
    },
    {
      id: 'informational',
      label: 'Informational',
      count: data.informational.length,
      content: renderInboxItems(data.informational, 'info')
    }
  ];

  const content = `
<div class="inbox">
  <header class="page-header">
    <h1>Action Inbox</h1>
    <p class="page-subtitle">Your personalized action items across all proposals and contexts</p>
  </header>

  ${tabs(tabItems)}
</div>`;

  return htmlPage('Action Inbox', content, orgId);
}