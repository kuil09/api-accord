// Workspace screen renderer

import { htmlPage } from './layout.js';
import {
  sectionBox,
  renderTable,
  renderList,
  card,
  Badge,
  emptyState,
  phaseProgress
} from './components.js';
import type { ChangeProposalState } from '@api-accord/domain';

export interface WorkspaceData {
  readonly services: ReadonlyArray<{ readonly serviceId: string; readonly name: string; readonly kind: string }>;
  readonly contracts: ReadonlyArray<{ readonly contractId: string; readonly title: string; readonly providerServiceId: string }>;
  readonly proposals: ReadonlyArray<{
    readonly proposalId: string;
    readonly title: string;
    readonly phase: string;
    readonly accepted: boolean;
    readonly openBlockingObjections: number;
  }>;
  readonly openDriftCount: number;
}

export function renderWorkspace(data: WorkspaceData, orgId?: string): string {
  const orgParam = orgId ? `?organizationId=${encodeURIComponent(orgId)}` : '';

  // Services table
  const servicesContent =
    data.services.length > 0
      ? renderTable(
          [
            { key: 'name', header: 'Service', render: (row) => `<a href="/ui/operations/${encodeURIComponent(`${row.serviceId}:`)}/context${orgParam}">${escapeHtml(row.name)}</a>` },
            { key: 'kind', header: 'Kind', render: (_, v) => v === 'provider' ? Badge.provider() : Badge.consumer() }
          ],
          data.services,
          { emptyMessage: 'No services registered' }
        )
      : emptyState('No services registered', { label: 'Register Service', href: '/ui/workspace' + orgParam });

  // Contracts table
  const contractsContent =
    data.contracts.length > 0
      ? renderTable(
          [
            { key: 'title', header: 'Contract', render: (row) => `<a href="/ui/operations/${encodeURIComponent(`${row.providerServiceId}:`)}/context${orgParam}">${escapeHtml(row.title)}</a>` },
            { key: 'providerServiceId', header: 'Provider' },
            { key: 'contractId', header: 'Contract ID' }
          ],
          data.contracts,
          { emptyMessage: 'No contracts imported' }
        )
      : emptyState('No contracts imported');

  // Proposals as timeline cards
  const proposalsContent =
    data.proposals.length > 0
      ? data.proposals
          .map((p) => card({
            title: p.title,
            content: phaseProgress(p.phase),
            badges: [
              Badge.phase(p.phase),
              p.openBlockingObjections > 0 ? Badge.custom(`${p.openBlockingObjections} blocking`, 'error') : Badge.custom('no objections', 'success'),
              p.accepted ? Badge.custom('accepted', 'success') : Badge.custom('pending', 'warning')
            ],
            actions: [{ label: 'View', href: `/ui/proposals/${encodeURIComponent(p.proposalId)}${orgParam}`, variant: 'primary' }]
          }))
          .join('')
      : emptyState('No open change proposals');

  // Drift summary card
  const driftContent = card({
    title: 'Open Drift Incidents',
    content: data.openDriftCount > 0
      ? `<p class="drift-count">${data.openDriftCount} open incident${data.openDriftCount > 1 ? 's' : ''} requiring attention</p>`
      : '<p>No open drift incidents</p>',
    badges: [Badge.count(data.openDriftCount)],
    actions: data.openDriftCount > 0 ? [{ label: 'View Drift', href: `/ui/dependencies${orgParam}`, variant: 'primary' }] : []
  });

  const content = `
<div class="workspace">
  <header class="page-header">
    <h1>API Workspace</h1>
    <p class="page-subtitle">Services, contracts, and change proposals for <code>${orgId ?? 'default'}</code></p>
  </header>

  <section class="workspace-section">
    <h2>Services</h2>
    ${servicesContent}
  </section>

  <section class="workspace-section">
    <h2>Contracts</h2>
    ${contractsContent}
  </section>

  <section class="workspace-section">
    <h2>Open Change Proposals</h2>
    <div class="proposals-grid">${proposalsContent}</div>
  </section>

  <section class="workspace-section">
    <h2>Runtime Drift</h2>
    ${driftContent}
  </section>
</div>`;

  return htmlPage('API Workspace', content, orgId);
}

function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&').replace(/</gu, '<').replace(/>/gu, '>').replace(/"/gu, '"');
}