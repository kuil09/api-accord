// Reusable UI components for Web UI

import { escapeHtml } from './layout.js';

// ============================================================================
// Badge Components
// ============================================================================

export const Badge = {
  human(): string {
    return '<span class="badge badge-human">HUMAN</span>';
  },
  ai(): string {
    return '<span class="badge badge-ai">AI</span>';
  },
  blocking(): string {
    return '<span class="badge badge-blocking">BLOCKING</span>';
  },
  provider(): string {
    return '<span class="badge badge-provider">PROVIDER</span>';
  },
  consumer(): string {
    return '<span class="badge badge-consumer">CONSUMER</span>';
  },
  superseded(): string {
    return '<span class="badge badge-superseded">SUPERSEDED</span>';
  },
  phase(name: string): string {
    return `<span class="badge badge-phase">${escapeHtml(name)}</span>`;
  },
  count(value: number): string {
    return `<span class="badge badge-count">${String(value)}</span>`;
  },
  custom(text: string, variant: 'default' | 'success' | 'warning' | 'error' | 'info' = 'default'): string {
    return `<span class="badge badge-${variant}">${escapeHtml(text)}</span>`;
  }
};

// Helper to get badge by author kind
export function authorBadge(kind: string): string {
  switch (kind) {
    case 'human': return Badge.human();
    case 'ai': return Badge.ai();
    case 'service': return Badge.custom('SERVICE', 'info');
    case 'ci': return Badge.custom('CI', 'info');
    default: return Badge.custom(kind.toUpperCase(), 'default');
  }
}

// ============================================================================
// Section Box
// ============================================================================

export function sectionBox(title: string, content: string, count?: number): string {
  const countBadge = count !== undefined ? ` ${Badge.count(count)}` : '';
  return `
<div class="section-box">
  <h2>${title}${countBadge}</h2>
  ${content}
</div>`;
}

// ============================================================================
// Table Component
// ============================================================================

export interface ColumnDef<T> {
  key: string;
  header: string;
  render?: (row: T, value: unknown) => string;
  sortable?: boolean;
}

export function renderTable<T>(
  columns: ColumnDef<T>[],
  rows: T[],
  options?: { emptyMessage?: string; orgId?: string }
): string {
  if (rows.length === 0) {
    return `<p class="empty-state">${escapeHtml(options?.emptyMessage ?? 'No data')}</p>`;
  }

  const thead = columns
    .map((col) => `<th${col.sortable ? ' class="sortable" data-sort="' + escapeHtml(col.key) + '"' : ''}>${escapeHtml(col.header)}</th>`)
    .join('');

  const tbody = rows
    .map((row) => {
      const tds = columns
        .map((col) => {
          const value = (row as Record<string, unknown>)[col.key];
          const rendered = col.render ? col.render(row, value) : escapeHtml(String(value ?? ''));
          return `<td>${rendered}</td>`;
        })
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');

  return `
<div class="table-wrapper">
  <table class="data-table">
    <thead><tr>${thead}</tr></thead>
    <tbody>${tbody}</tbody>
  </table>
</div>`;
}

// ============================================================================
// Card Component
// ============================================================================

export interface CardProps {
  title: string;
  content: string;
  badges?: string[];
  actions?: { label: string; href?: string; onclick?: string; variant?: 'primary' | 'secondary' | 'danger' }[];
  footer?: string;
}

export function card(props: CardProps): string {
  const badgesHtml = props.badges?.length ? `<div class="card-badges">${props.badges.join(' ')}</div>` : '';
  const actionsHtml = props.actions?.length
    ? `<div class="card-actions">${props.actions
        .map((a) => `<a href="${escapeHtml(a.href ?? '#')}" class="btn btn-${a.variant ?? 'secondary'}"${a.onclick ? ` onclick="${a.onclick}"` : ''}>${escapeHtml(a.label)}</a>`)
        .join('')}</div>`
    : '';
  const footerHtml = props.footer ? `<div class="card-footer">${props.footer}</div>` : '';

  return `
<article class="card">
  <header class="card-header">
    <h3>${escapeHtml(props.title)}</h3>
    ${badgesHtml}
  </header>
  <div class="card-body">${props.content}</div>
  ${actionsHtml}
  ${footerHtml}
</article>`;
}

// ============================================================================
// Timeline Card (for proposal phases)
// ============================================================================

export interface TimelineStep {
  label: string;
  status: 'completed' | 'current' | 'pending' | 'blocked';
  detail?: string;
}

export function timeline(steps: TimelineStep[]): string {
  return `
<div class="timeline">
  ${steps
    .map(
      (step, i) => `
    <div class="timeline-step ${step.status}">
      <div class="timeline-marker" aria-hidden="true"></div>
      <div class="timeline-content">
        <div class="timeline-label">${escapeHtml(step.label)} ${Badge.phase(step.status)}</div>
        ${step.detail ? `<div class="timeline-detail">${escapeHtml(step.detail)}</div>` : ''}
      </div>
    </div>`
    )
    .join('')}
</div>`;
}

// ============================================================================
// Modal Component
// ============================================================================

export function modal(id: string, title: string, body: string, size: 'sm' | 'md' | 'lg' = 'md'): string {
  return `
<div id="${escapeHtml(id)}" class="modal" role="dialog" aria-modal="true" aria-labelledby="${escapeHtml(id)}-title" hidden>
  <div class="modal-overlay" data-modal-close="${escapeHtml(id)}"></div>
  <div class="modal-panel modal-${size}">
    <header class="modal-header">
      <h3 id="${escapeHtml(id)}-title">${escapeHtml(title)}</h3>
      <button class="modal-close" data-modal-close="${escapeHtml(id)}" aria-label="Close">&times;</button>
    </header>
    <div class="modal-body">${body}</div>
  </div>
</div>`;
}

// ============================================================================
// Toast Notification
// ============================================================================

export function toast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info'): string {
  return `
<div class="toast toast-${type}" role="alert" aria-live="polite">
  <span class="toast-message">${escapeHtml(message)}</span>
  <button class="toast-close" aria-label="Dismiss">&times;</button>
</div>`;
}

// ============================================================================
// Tabs Component
// ============================================================================

export interface TabItem {
  id: string;
  label: string;
  content: string;
  count?: number;
  badgeVariant?: 'default' | 'blocking' | 'warning';
}

export function tabs(items: TabItem[], activeId?: string): string {
  const firstActive = activeId ?? items[0]?.id;
  return `
<div class="tabs" role="tablist">
  <nav class="tabs-nav" aria-label="Tabs">
    ${items
      .map(
        (item) => `
      <button
        role="tab"
        id="tab-${escapeHtml(item.id)}"
        class="tab-btn ${item.id === firstActive ? 'active' : ''}"
        data-tab="${escapeHtml(item.id)}"
        aria-selected="${item.id === firstActive}"
        aria-controls="panel-${escapeHtml(item.id)}"
      >
        ${escapeHtml(item.label)}
        ${item.count !== undefined ? Badge.count(item.count) : ''}
      </button>`
      )
      .join('')}
  </nav>
  ${items
    .map(
      (item) => `
    <div
      role="tabpanel"
      id="panel-${escapeHtml(item.id)}"
      class="tab-panel ${item.id === firstActive ? 'active' : ''}"
      aria-labelledby="tab-${escapeHtml(item.id)}"
      hidden="${item.id !== firstActive}"
    >
      ${item.content}
    </div>`
    )
    .join('')}
</div>`;
}

// ============================================================================
// List Component (for simple lists with badges)
// ============================================================================

export function renderList(
  items: Array<{ label: string; badges?: string[]; href?: string; detail?: string }>,
  emptyMessage = 'none'
): string {
  if (items.length === 0) {
    return `<ul class="data-list"><li class="empty">${escapeHtml(emptyMessage)}</li></ul>`;
  }
  return `
<ul class="data-list">
  ${items
    .map(
      (item) => `
    <li>
      ${item.href ? `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>` : `<span>${escapeHtml(item.label)}</span>`}
      ${item.badges?.map((b) => ` ${b}`).join('') ?? ''}
      ${item.detail ? `<span class="detail">${escapeHtml(item.detail)}</span>` : ''}
    </li>`
    )
    .join('')}
</ul>`;
}

// ============================================================================
// Phase Progress Bar
// ============================================================================

export const PROPOSAL_PHASES = [
  'draft',
  'opened',
  'accepted',
  'implemented',
  'verified',
  'deployed',
  'observed',
  'completed'
] as const;

export function phaseProgress(currentPhase: string): string {
  const currentIndex = PROPOSAL_PHASES.indexOf(currentPhase as typeof PROPOSAL_PHASES[number]);
  return `
<div class="phase-progress" role="progressbar" aria-valuenow="${currentIndex + 1}" aria-valuemin="1" aria-valuemax="${PROPOSAL_PHASES.length}">
  ${PROPOSAL_PHASES
    .map(
      (phase, i) => `
    <div class="phase-step ${i < currentIndex ? 'completed' : i === currentIndex ? 'current' : 'pending'}">
      <span class="phase-marker" aria-hidden="true"></span>
      <span class="phase-label">${escapeHtml(phase)}</span>
    </div>`
    )
    .join('')}
</div>`;
}

// ============================================================================
// Empty State
// ============================================================================

export function emptyState(message: string, action?: { label: string; href: string }): string {
  return `
<div class="empty-state">
  <p>${escapeHtml(message)}</p>
  ${action ? `<a href="${escapeHtml(action.href)}" class="btn btn-primary">${escapeHtml(action.label)}</a>` : ''}
</div>`;
}

// ============================================================================
// Detail/Summary (for collapsible sections)
// ============================================================================

export function details(summary: string, content: string, open = false): string {
  return `
<details class="details" ${open ? 'open' : ''}>
  <summary>${escapeHtml(summary)}</summary>
  <div class="details-content">${content}</div>
</details>`;
}