import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import { createLogger } from '@api-accord/config';
import { DomainService, InMemoryEventStore, serviceId } from '@api-accord/domain';

import { createApiApplication } from './app.js';
import { computeWebhookSignature, GitRestAdapter, verifyWebhookSignature } from './github.js';

function silentLogger() {
  return createLogger({ service: 'test', minimumLevel: 'debug', sink: () => undefined });
}

async function listen(server: import('node:http').Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

const WEBHOOK_SECRET = 'github-webhook-secret';
const CHECK_RUN_PAYLOAD = JSON.stringify({
  action: 'completed',
  check_run: { conclusion: 'success', head_sha: 'abc123', html_url: 'https://github.example/run/1', name: 'contract-tests' },
  repository: { full_name: 'acme/payments' }
});

describe('webhook signature verification (issue #13)', () => {
  it('round-trips a valid signature and rejects tampered payloads', async () => {
    const signature = await computeWebhookSignature(CHECK_RUN_PAYLOAD, WEBHOOK_SECRET);
    assert.equal(await verifyWebhookSignature({ payload: CHECK_RUN_PAYLOAD, signatureHeader: signature, secret: WEBHOOK_SECRET }), true);
    assert.equal(await verifyWebhookSignature({ payload: CHECK_RUN_PAYLOAD + ' tampered', signatureHeader: signature, secret: WEBHOOK_SECRET }), false);
    assert.equal(await verifyWebhookSignature({ payload: CHECK_RUN_PAYLOAD, signatureHeader: undefined, secret: WEBHOOK_SECRET }), false);
  });
});

describe('POST /webhooks/github (issue #13)', () => {
  async function postWebhook(baseUrl: string, input: { deliveryId: string; event: string; payload: string; secret: string }): Promise<{ status: number; body: Record<string, unknown> }> {
    const signature = await computeWebhookSignature(input.payload, input.secret);
    const response = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': input.deliveryId,
        'x-github-event': input.event,
        'x-hub-signature-256': signature
      },
      body: input.payload
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('records a check_run as github-check provenance evidence', async (context) => {
    const store = new InMemoryEventStore();
    const seenDeliveryIds: string[] = [];
    const application = createApiApplication({
      logger: silentLogger(),
      readinessProbe: { name: 'test', check: () => Promise.resolve() },
      github: { webhookSecret: WEBHOOK_SECRET, store, domain: new DomainService(store), seenDeliveryIds }
    });
    context.after(() => application.close());
    const baseUrl = await listen(application.server);

    const result = await postWebhook(baseUrl, { deliveryId: 'd-1', event: 'check_run', payload: CHECK_RUN_PAYLOAD, secret: WEBHOOK_SECRET });
    assert.equal(result.status, 200);
    assert.equal(result.body['evidenceRecorded'], true);

    const evidence = (await store.getAll()).find((event) => event.event.type === 'EvidenceAttached');
    assert.ok(evidence);
    if (evidence && evidence.event.type === 'EvidenceAttached') {
      assert.equal(evidence.event.status, 'passed', 'successful check becomes passed evidence');
      assert.equal(evidence.event.kind, 'ci-check');
      assert.equal(evidence.event.provenance, 'github-check');
      assert.equal(evidence.event.sourceRevision, 'abc123');
    }
    assert.equal(seenDeliveryIds.includes('d-1'), true);
  });

  it('rejects forged webhooks with 401 (INV-031, issue #21)', async (context) => {
    const store = new InMemoryEventStore();
    const application = createApiApplication({
      logger: silentLogger(),
      readinessProbe: { name: 'test', check: () => Promise.resolve() },
      github: { webhookSecret: WEBHOOK_SECRET, store, domain: new DomainService(store), seenDeliveryIds: [] }
    });
    context.after(() => application.close());
    const baseUrl = await listen(application.server);

    const response = await fetch(`${baseUrl}/webhooks/github`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-delivery': 'd-forged', 'x-github-event': 'check_run', 'x-hub-signature-256': 'sha256=deadbeef' },
      body: CHECK_RUN_PAYLOAD
    });
    assert.equal(response.status, 401);
  });

  it('acknowledges duplicate deliveries without double-recording evidence', async (context) => {
    const store = new InMemoryEventStore();
    const seenDeliveryIds: string[] = [];
    const application = createApiApplication({
      logger: silentLogger(),
      readinessProbe: { name: 'test', check: () => Promise.resolve() },
      github: { webhookSecret: WEBHOOK_SECRET, store, domain: new DomainService(store), seenDeliveryIds }
    });
    context.after(() => application.close());
    const baseUrl = await listen(application.server);

    await postWebhook(baseUrl, { deliveryId: 'd-dup', event: 'check_run', payload: CHECK_RUN_PAYLOAD, secret: WEBHOOK_SECRET });
    const replay = await postWebhook(baseUrl, { deliveryId: 'd-dup', event: 'check_run', payload: CHECK_RUN_PAYLOAD, secret: WEBHOOK_SECRET });
    assert.equal(replay.status, 200);
    assert.equal(replay.body['ignored'], true, 'duplicate delivery is acknowledged but not re-handled');

    const evidenceCount = (await store.getAll()).filter((event) => event.event.type === 'EvidenceAttached').length;
    assert.equal(evidenceCount, 1, 'the evidence is not recorded twice');
  });

  it('acknowledges unknown events without inventing domain state', async (context) => {
    const store = new InMemoryEventStore();
    const application = createApiApplication({
      logger: silentLogger(),
      readinessProbe: { name: 'test', check: () => Promise.resolve() },
      github: { webhookSecret: WEBHOOK_SECRET, store, domain: new DomainService(store), seenDeliveryIds: [] }
    });
    context.after(() => application.close());
    const baseUrl = await listen(application.server);

    const result = await postWebhook(baseUrl, { deliveryId: 'd-install', event: 'installation', payload: JSON.stringify({ action: 'created' }), secret: WEBHOOK_SECRET });
    assert.equal(result.status, 200);
    assert.equal(result.body['evidenceRecorded'], false);
    assert.equal((await store.getAll()).filter((event) => event.event.type === 'EvidenceAttached').length, 0);
  });
});

describe('Git REST adapter (issue #13)', () => {
  it('creates a branch from the base ref and opens a PR with provenance in the body', async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const stub = createServer((request, response) => {
      const chunks: string[] = [];
      request.on('data', (chunk) => chunks.push(String(chunk)));
      request.on('end', () => {
        const path = request.url ?? '/';
        requests.push({ method: request.method ?? 'GET', path, body: chunks.length > 0 ? JSON.parse(chunks.join('')) : undefined });
        if (path.startsWith('/repos/acme/payments/git/ref/heads/main')) {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ object: { sha: 'base-sha' } }));
          return;
        }
        if (path === '/repos/acme/payments/git/refs') {
          response.statusCode = 201;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ ref: 'refs/heads/accord/p-1' }));
          return;
        }
        if (path === '/repos/acme/payments/pulls') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ number: 7, html_url: 'https://github.example/acme/payments/pull/7' }));
          return;
        }
        response.statusCode = 404;
        response.end();
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    const adapter = new GitRestAdapter({
      token: 'test-token',
      baseUrl: stubUrl,
      repositories: [{ serviceId: serviceId('merchant-console'), owner: 'acme', repo: 'payments' }]
    });
    const pr = await adapter.createBranch({ repositoryServiceId: serviceId('merchant-console'), branch: 'accord/p-1', base: 'main' });
    assert.equal(pr.branch, 'accord/p-1');

    const created = await adapter.commitAndCreatePullRequest({
      repositoryServiceId: serviceId('merchant-console'),
      branch: 'accord/p-1',
      base: 'main',
      title: 'Implement REVERSED handling',
      body: 'Implements approved change proposal: p-auto',
      patches: []
    });
    assert.equal(created.pullRequestNumber, 7);
    assert.match(created.url, /pull\/7/u);

    const refRequest = requests.find((request) => request.path.includes('/git/refs'));
    assert.ok(refRequest);
    assert.equal(refRequest.method, 'POST');
    const pullRequest = requests.find((request) => request.path.endsWith('/pulls'));
    assert.ok(pullRequest);
    const pullBody = pullRequest?.body as { body: string; head: string; base: string };
    assert.match(pullBody.body, /p-auto/u, 'the PR body states the proposal it implements');
    assert.equal(pullBody.head, 'accord/p-1');
    assert.equal(pullBody.base, 'main');

    await new Promise<void>((resolve, reject) => stub.close((error) => (error === undefined ? resolve() : reject(error))));
  });

  it('throws a clear error when no repository is connected for a service', async () => {
    const adapter = new GitRestAdapter({ token: 't', baseUrl: 'http://localhost:1', repositories: [] });
    let threw = false;
    try {
      await adapter.createBranch({ repositoryServiceId: serviceId('unknown-svc'), branch: 'b', base: 'main' });
    } catch (error) {
      threw = error instanceof Error && /no repository is connected/u.test(error.message);
    }
    assert.ok(threw, 'unconnected service is rejected with a clear error');
  });
});
