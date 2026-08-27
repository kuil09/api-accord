import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryEventStore } from './events.js';
import { OpenApiImporter, stableOperationId } from './catalog.js';
import { apiContractId, contractVersionId, operationId, principalRef, serviceId, teamId, organizationId } from './primitives.js';

const actor = principalRef('human', 'tester');

describe('OpenApiImporter', () => {
  const doc = {
    info: { title: 'Payments API' },
    paths: {
      '/payments': {
        post: { operationId: 'CreatePayment', requestBody: { content: {} }, responses: { '200': { description: 'ok' }, '400': { description: 'bad' } } },
        get: { responses: { '200': { description: 'list' } } }
      },
      '/payments/{id}': {
        get: { summary: 'Get payment', responses: { '200': { description: 'ok' } } }
      }
    }
  };

  it('extracts operations with request/response/error schemas', () => {
    const result = new OpenApiImporter().import(doc);
    assert.equal(result.contractTitle, 'Payments API');
    assert.equal(result.operations.length, 3);
    const post = result.operations.find((op) => op.method === 'POST' && op.path === '/payments');
    assert.ok(post);
    assert.equal(post?.schemas.length, 3, 'request + 200 + 400');
    assert.equal(result.errors.length, 0);
  });

  it('produces a stable operation id when operationId is missing', () => {
    assert.equal(stableOperationId('get', '/payments/{id}'), 'GET:/payments/:id');
    const result = new OpenApiImporter().import(doc);
    const get = result.operations.find((op) => op.method === 'GET' && op.path === '/payments/{id}');
    assert.equal(get?.title, 'Get payment');
    assert.equal(get?.schemas.length, 1, 'response schema extracted from summary-only operation');
  });

  it('reports partial failures without dropping the whole contract (INV-019)', () => {
    const broken = {
      info: { title: 'Broken' },
      paths: {
        '/a': { get: { responses: { '200': {} } } },
        // A non-object path entry would crash a naive parser; our loop tolerates
        // it as a partial failure.
        '/b': 'not-an-object' as unknown as Record<string, unknown>
      }
    };
    const result = new OpenApiImporter().import(broken);
    assert.equal(result.operations.length, 1, 'valid operation still imported');
    assert.ok(result.errors.length >= 1, 'partial failure recorded, not swallowed');
  });

  it('revisionOf is stable for the same source (idempotency)', () => {
    const importer = new OpenApiImporter();
    assert.equal(importer.revisionOf(doc), importer.revisionOf(JSON.parse(JSON.stringify(doc))));
  });
});

describe('CatalogService', () => {
  it('emits ServiceRegistered and ApiContractImported + ContractVersionImported + OperationImported events', async () => {
    const store = new InMemoryEventStore();
    const service = new (await import('./catalog.js')).CatalogService(store);
    const svc = serviceId('svc-1');
    const contract = apiContractId('contract-1');
    await service.registerService({
      actor,
      serviceId: svc,
      organizationId: organizationId('org-1'),
      owningTeamId: teamId('team-1'),
      name: 'payments',
      kind: 'provider',
      repositoryUrl: 'https://github.com/x/payments'
    });
    await service.importContract({
      actor,
      contractId: contract,
      organizationId: organizationId('org-1'),
      providerServiceId: svc,
      importer: new OpenApiImporter(),
      source: { info: { title: 'Payments' }, paths: { '/payments': { post: { responses: { '200': {} } } } } },
      importSource: 'file:openapi.yaml'
    });

    const all = await store.getAll();
    assert.ok(all.some((e) => e.event.type === 'ServiceRegistered'));
    assert.ok(all.some((e) => e.event.type === 'ApiContractImported'));
    assert.ok(all.some((e) => e.event.type === 'ContractVersionImported'));
    assert.ok(all.some((e) => e.event.type === 'OperationImported'));

    // Identifier derivation is deterministic and traceable.
    const opId = operationIdFromCheck(contract, 'POST', '/payments');
    assert.ok(all.some((e) => e.event.type === 'OperationImported' && (e.event as { operationId: string }).operationId === opId));
  });
});

function operationIdFromCheck(contract: ReturnType<typeof apiContractId>, method: string, path: string): string {
  return `${contract}:${stableOperationId(method, path)}`;
}

void contractVersionId;
void operationId;
