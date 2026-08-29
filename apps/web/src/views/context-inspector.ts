// Context Inspector screen renderer

import { htmlPage, escapeHtml } from './layout.js';
import {
  tabs,
  Badge
} from './components.js';
import type { ContextBundle } from '@api-accord/domain';

export function renderContextInspector(bundle: ContextBundle, orgId?: string): string {
  function renderClaims(claims: ReadonlyArray<{
    readonly statement: string;
    readonly author?: { readonly kind: string } | undefined;
    readonly sourceRef?: string | undefined;
    readonly confidence: string;
  }>): string {
    if (claims.length === 0) {
      return '<p class="empty-section">No claims in this section</p>';
    }
    return `
<ul class="claims-list">
  ${claims
    .map(
      (claim) => `
    <li class="claim-item">
      <div class="claim-meta">
        ${authorBadge(claim.author?.kind)}
        <span class="claim-confidence confidence-${escapeHtml(claim.confidence.toLowerCase())}">${escapeHtml(claim.confidence)}</span>
      </div>
      <div class="claim-statement">${escapeHtml(claim.statement)}</div>
      <div class="claim-source"><code>${escapeHtml(claim.sourceRef ?? 'No source reference')}</code></div>
      <div class="claim-actions">
        <button class="btn btn-ghost btn-sm" data-action="challenge" data-claim="${encodeURIComponent(claim.statement)}">Challenge</button>
        <button class="btn btn-ghost btn-sm" data-action="correct" data-claim="${encodeURIComponent(claim.statement)}">Correct</button>
        <button class="btn btn-ghost btn-sm" data-action="evidence" data-claim="${encodeURIComponent(claim.statement)}">Add Evidence</button>
      </div>
    </li>`
    )
    .join('')}
</ul>`;
  }

  function authorBadge(kind?: string): string {
    if (!kind) return '';
    switch (kind) {
      case 'human': return Badge.human();
      case 'ai': return Badge.ai();
      case 'service': return Badge.custom('SERVICE', 'info');
      case 'ci': return Badge.custom('CI', 'info');
      default: return Badge.custom(kind.toUpperCase(), 'default');
    }
  }

  // Conflicts rendering
  const conflictsContent =
    bundle.sections.conflicts.length > 0
      ? bundle.sections.conflicts
          .map(
            (c) => `
<div class="conflict-card">
  <div class="conflict-pair">
    <div class="conflict-side">
      <h4>Claim A</h4>
      <p>${escapeHtml(c.claimA.statement)}</p>
      <div class="claim-meta">
        ${authorBadge(c.claimA.author?.kind)}
        <span class="claim-confidence confidence-${escapeHtml(c.claimA.confidence.toLowerCase())}">${escapeHtml(c.claimA.confidence)}</span>
      </div>
      <code>${escapeHtml(c.claimA.sourceRef ?? 'No source')}</code>
    </div>
    <div class="conflict-divider" aria-hidden="true">↔</div>
    <div class="conflict-side">
      <h4>Claim B</h4>
      <p>${escapeHtml(c.claimB.statement)}</p>
      <div class="claim-meta">
        ${authorBadge(c.claimB.author?.kind)}
        <span class="claim-confidence confidence-${escapeHtml(c.claimB.confidence.toLowerCase())}">${escapeHtml(c.claimB.confidence)}</span>
      </div>
      <code>${escapeHtml(c.claimB.sourceRef ?? 'No source')}</code>
    </div>
  </div>
</div>`
          )
          .join('')
      : '<p class="empty-section">No conflicts detected</p>';

  const tabItems = [
    {
      id: 'confirmed',
      label: 'Confirmed Facts',
      count: bundle.sections.confirmedFacts.length,
      content: renderClaims(bundle.sections.confirmedFacts)
    },
    {
      id: 'assumptions',
      label: 'Assumptions / Inferences',
      count: bundle.sections.assumptions.length,
      badgeVariant: 'warning',
      content: renderClaims(bundle.sections.assumptions)
    },
    {
      id: 'conflicts',
      label: 'Conflicts',
      count: bundle.sections.conflicts.length,
      badgeVariant: 'blocking',
      content: conflictsContent
    },
    {
      id: 'stale',
      label: 'Stale',
      count: bundle.sections.stale.length,
      badgeVariant: 'warning',
      content: renderClaims(bundle.sections.stale)
    },
    {
      id: 'unsupported',
      label: 'Unsupported',
      count: bundle.sections.unsupported.length,
      badgeVariant: 'error',
      content: renderClaims(bundle.sections.unsupported)
    },
    {
      id: 'mismatches',
      label: 'Mismatches',
      count: bundle.sections.mismatches.length,
      badgeVariant: 'error',
      content: renderClaims(bundle.sections.mismatches)
    },
    {
      id: 'needs-review',
      label: 'Needs Human Review',
      count: bundle.sections.needsHumanReview.length,
      badgeVariant: 'warning',
      content: renderClaims(bundle.sections.needsHumanReview)
    }
  ];

  const content = `
<div class="context-inspector">
  <header class="page-header">
    <h1>Context Inspector</h1>
    <p class="page-subtitle">Operation context bundle — 7 sections per INV-014/INV-016</p>
  </header>

  ${tabs(tabItems)}
</div>`;

  return htmlPage('Context Inspector', content, orgId);
}