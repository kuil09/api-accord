import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { createLogger } from '@api-accord/config';
import { DomainService, InMemoryEventStore, observationId, principalRef, seedBaselineCatalog } from '@api-accord/domain';

import { createWebApplication } from './app.js';

function silentLogger() {
  return createLogger({ service: 'test', minimumLevel: 'debug', sink: () => undefined });
}

async function listen(server: import('node:http').Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function seededApplication(context: { after(callback: () => void | Promise<void>): void }) {
  const store = new InMemoryEventStore();
  const seed = await seedBaselineCatalog(store, principalRef('human', 'acceptance-runner'));
  const application = createWebApplication({ logger: silentLogger(), domain: { store } });
  context.after(() => application.close());
  const baseUrl = await listen(application.server);
  return { application, store, seed, baseUrl };
}

describe('web domain read API (issue #20, INV-029)', () => {
  it('returns the same domain state as MCP for the workspace', async (context) => {
    const { baseUrl } = await seededApplication(context);

    const response = await fetch(`${baseUrl}/api/workspace?organizationId=org-acme`, {
      headers: { 'x-organization-id': 'org-acme' }
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { services: ReadonlyArray<{ name: string }>; openDriftCount: number };
    assert.ok(body.services.some((service) => service.name === 'payment-service'));
    assert.ok(body.services.some((service) => service.name === 'merchant-console'));
  });

  it('denies cross-organization workspace reads (INV-029)', async (context) => {
    const { baseUrl } = await seededApplication(context);

    const response = await fetch(`${baseUrl}/api/workspace?organizationId=org-acme`, {
      headers: { 'x-organization-id': 'org-other' }
    });
    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, 'organization_boundary');
  });

  it('returns a typed 404 for a missing proposal, never an empty success', async (context) => {
    const { baseUrl } = await seededApplication(context);

    const response = await fetch(`${baseUrl}/api/proposals/proposal-missing`, {
      headers: { 'x-organization-id': 'org-acme' }
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, 'not_found');
  });

  it('serves the operation context inspector with sections and author provenance', async (context) => {
    const { application, store, baseUrl } = await seededApplication(context);
    const service = new DomainService(store);
    await service.recordRuntimeObservation({
      actor: { kind: 'integration', id: 'runtime-observer' },
      correlationId: 'c',
      observationId: observationId('obs-web-1'),
      operationId: 'contract-payments:GET:/payments/{paymentId}',
      environment: 'production',
      contractVersionId: 'contract-payments@rev-2',
      deploymentRevision: 'rev-2',
      collectorVersion: 'collector-1.4.2',
      kind: 'enum-violation',
      detail: { status: 'CHARGEBACK' },
      redactionPolicy: { deniedFields: [], literalFields: ['status'] },
      sampleSize: 30
    });
    context.after(() => application.close());

    const key = encodeURIComponent('contract-payments:GET:/payments/{paymentId}');
    const response = await fetch(`${baseUrl}/api/operations/${key}/context`, {
      headers: { 'x-organization-id': 'org-acme' }
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      sections: {
        confirmedFacts: ReadonlyArray<unknown>;
        mismatches: ReadonlyArray<{ statement: string; author: { kind: string } }>;
      };
    };
    assert.equal(body.sections.mismatches.length, 1, 'drift lands in the mismatches section');
    assert.equal(body.sections.mismatches[0]?.author.kind, 'integration', 'runtime provenance is distinguished from AI/human');
  });

  it('serves the action inbox for a recipient', async (context) => {
    const { baseUrl } = await seededApplication(context);

    const response = await fetch(`${baseUrl}/api/actions?recipient=team-merchant`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { awaitingMyApproval: ReadonlyArray<unknown>; overdue: ReadonlyArray<unknown> };
    assert.equal(body.awaitingMyApproval.length, 0, 'no notifications dispatched in the bare seed');
    assert.equal(body.overdue.length, 0);
  });

  it('renders html screens for workspace and inbox', async (context) => {
    const { baseUrl } = await seededApplication(context);
    const workspace = await fetch(`${baseUrl}/ui/workspace?organizationId=org-acme`, { headers: { 'x-organization-id': 'org-acme' } });
    assert.equal(workspace.status, 200);
    const workspaceHtml = await workspace.text();
    assert.match(workspaceHtml, /API Workspace/u);
    assert.match(workspaceHtml, /payment-service/u);

    const inbox = await fetch(`${baseUrl}/ui/inbox?recipient=team-merchant`);
    assert.equal(inbox.status, 200);
    assert.match(await inbox.text(), /Action Inbox/u);
  });

});
