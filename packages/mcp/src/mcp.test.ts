import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DomainService, InMemoryEventStore, allDependencyEdges, baselineContractV1, changeProposalId, decisionRecordId, discussionEntryId, contextItemId, pinImpactAnalysis, principalRef, seedBaselineCatalog } from '@api-accord/domain';
import type { Scope } from '@api-accord/domain';
import { ApiAccordMcpServer, McpError, formatResourceUri, listResourceDescriptors, parseResourceUri } from './index.js';
import { readResource } from './resources.js';

const human = principalRef('human', 'mcp-owner');
const agent = principalRef('agent', 'mcp-agent');

const READ_SCOPES: ReadonlyArray<Scope> = ['context:read'];
const PROPOSAL_SCOPES: ReadonlyArray<Scope> = ['proposal:create', 'proposal:comment'];
const CONTEXT_SCOPES: ReadonlyArray<Scope> = ['context:read', 'context:propose', 'context:correct'];
const COMPILE_SCOPES: ReadonlyArray<Scope> = ['spec:compile'];

describe('capability discovery (issue #14)', () => {
  const store = new InMemoryEventStore();
  const server = new ApiAccordMcpServer({ store, domain: new DomainService(store) });

  it('exposes the eleven MVP tools with schemas and required scopes', () => {
    const tools = server.listTools();
    assert.equal(tools.length, 11);
    const names = tools.map((tool) => tool.name);
    for (const expected of ['get_api_context', 'get_operation_context', 'get_consumer_assumptions', 'trace_dependency_impact', 'create_change_proposal', 'comment_on_proposal', 'confirm_context', 'challenge_context', 'correct_context', 'compile_spec', 'list_pending_actions']) {
      assert.ok(names.includes(expected), `${expected} is in the catalog`);
    }
    for (const tool of tools) {
      assert.ok(tool.inputSchema['type'] === 'object');
      assert.ok(tool.requiredScope.length > 0);
    }
  });

  it('lists the resource uri templates with availability status', () => {
    const descriptors = listResourceDescriptors();
    assert.ok(descriptors.some((descriptor) => descriptor.uri === 'api://proposals/{proposalId}' && descriptor.status === 'available'));
    assert.ok(descriptors.some((descriptor) => descriptor.uri === 'api://organizations/{id}' && descriptor.status === 'reserved'));
  });

  it('parses and validates resource uris', () => {
    const parsed = parseResourceUri(formatResourceUri('proposals', 'p-1'));
    assert.equal(parsed.type, 'proposals');
    assert.equal(parsed.id, 'p-1');
    let bad: unknown;
    try {
      parseResourceUri('https://proposals/p-1');
    } catch (error) {
      bad = error;
    }
    assert.ok(bad instanceof McpError);
  });
});

describe('scope enforcement (INV-029, issue #14)', () => {
  const store = new InMemoryEventStore();
  const server = new ApiAccordMcpServer({ store, domain: new DomainService(store) });

  it('denies a caller without the required scope', async () => {
    const result = await server.dispatch({
      tool: 'create_change_proposal',
      caller: { actor: agent, grantedScopes: READ_SCOPES },
      args: { proposalId: 'p-1', contractId: 'c-1', title: 'x' }
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.code === 'denied-scope');
  });

  it('allows a caller with the required scope', async () => {
    const result = await server.dispatch({
      tool: 'create_change_proposal',
      caller: { actor: human, grantedScopes: PROPOSAL_SCOPES },
      args: { proposalId: 'p-2', contractId: 'c-2', title: 'x' },
      idempotencyKey: 'idem-1'
    });
    assert.equal(result.ok, true);
  });
});

describe('mutation tools over shared domain services (issue #14)', () => {
  it('idempotency key replays the recorded result without double-appending', async () => {
    const store = new InMemoryEventStore();
    const server = new ApiAccordMcpServer({ store, domain: new DomainService(store) });
    const call = { tool: 'create_change_proposal', caller: { actor: human, grantedScopes: PROPOSAL_SCOPES }, args: { proposalId: 'p-idem', contractId: 'c-idem', title: 'x' }, idempotencyKey: 'same-key' };
    const first = await server.dispatch(call);
    const second = await server.dispatch(call);
    assert.equal(first.ok, true);
    assert.ok(JSON.stringify(second) === JSON.stringify(first));
    const opens = (await store.getAll()).filter((event) => event.event.type === 'ChangeProposalOpened');
    assert.equal(opens.length, 1, 'only one proposal opened despite the replay');
  });

  it('surfaces domain rule violations as typed errors (INV-016)', async () => {
    const store = new InMemoryEventStore();
    const seed = await seedBaselineCatalog(store, human);
    const server = new ApiAccordMcpServer({ store, domain: new DomainService(store) });
    const result = await server.dispatch({
      tool: 'confirm_context',
      caller: { actor: agent, grantedScopes: CONTEXT_SCOPES },
      args: { contextItemId: seed.contexts.merchantAssumption, validFrom: '2026-01-01T00:00:00Z', source: 'agent inference' }
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.code === 'domain-rule-violated');
    assert.match(result.message, /human/u);
  });

  it('confirm, challenge and correct context flow through the same domain rules', async () => {
    const store = new InMemoryEventStore();
    const seed = await seedBaselineCatalog(store, human);
    const server = new ApiAccordMcpServer({ store, domain: new DomainService(store) });
    const item = seed.contexts.notFoundMeaning;

    const confirmed = await server.dispatch({
      tool: 'confirm_context',
      caller: { actor: human, grantedScopes: CONTEXT_SCOPES },
      args: { contextItemId: item, validFrom: '2026-01-01T00:00:00Z', source: 'docs' }
    });
    assert.equal(confirmed.ok, true);

    const challenged = await server.dispatch({
      tool: 'challenge_context',
      caller: { actor: agent, grantedScopes: CONTEXT_SCOPES },
      args: { contextItemId: item, reason: 'runtime disagreed' }
    });
    assert.equal(challenged.ok, true);

    const correction = `${String(item)}-c2`;
    const corrected = await server.dispatch({
      tool: 'correct_context',
      caller: { actor: human, grantedScopes: CONTEXT_SCOPES },
      args: { originalContextItemId: item, correctionContextItemId: contextItemId(correction) }
    });
    assert.equal(corrected.ok, true);
  });
});

describe('read and analysis tools (issue #14)', () => {
  it('get_consumer_assumptions preserves conflicting assumptions (INV-008)', async () => {
    const store = new InMemoryEventStore();
    await seedBaselineCatalog(store, human);
    const server = new ApiAccordMcpServer({ store, domain: new DomainService(store) });
    const result = await server.dispatch({
      tool: 'get_consumer_assumptions',
      caller: { actor: agent, grantedScopes: READ_SCOPES },
      args: { operationId: 'GET:/payments/{paymentId}' }
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      const consumers = result.data as ReadonlyArray<{ consumerServiceId: string; assumptions: ReadonlyArray<{ statement: string }> }>;
      assert.equal(consumers.length, 3);
      assert.ok(consumers.some((entry) => entry.assumptions.some((assumption) => /APPROVED always implies/u.test(assumption.statement))));
    }
  });

  it('trace_dependency_impact returns the pinned analysis and staleness', async () => {
    const store = new InMemoryEventStore();
    const seed = await seedBaselineCatalog(store, human);
    const service = new DomainService(store);
    const server = new ApiAccordMcpServer({ store, domain: new DomainService(store) });
    const proposal = changeProposalId('p-mcp');

    const none = await server.dispatch({ tool: 'trace_dependency_impact', caller: { actor: human, grantedScopes: READ_SCOPES }, args: { proposalId: proposal } });
    assert.equal(none.ok, false);
    assert.ok(!none.ok && none.code === 'not-found');

    await service.openChangeProposal({ actor: seed.providerActor, proposalId: proposal, contractId: seed.contract, title: 'x' });
    const snapshot = pinImpactAnalysis({ proposalId: proposal, computedBy: seed.providerActor, computedAt: new Date(), edges: allDependencyEdges(await store.getAll()), impacts: [] });
    await service.recordImpactAnalysis({ actor: seed.providerActor, proposalId: proposal, snapshot });

    const result = await server.dispatch({ tool: 'trace_dependency_impact', caller: { actor: agent, grantedScopes: READ_SCOPES }, args: { proposalId: proposal } });
    assert.equal(result.ok, true);
    if (result.ok) {
      const data = result.data as { stale: boolean };
      assert.equal(data.stale, false, 'the pinned analysis is fresh against unchanged edges');
    }
  });

  it('compile_spec compiles an accepted proposal and reports domain refusals', async () => {
    const store = new InMemoryEventStore();
    const seed = await seedBaselineCatalog(store, human);
    const service = new DomainService(store);
    const server = new ApiAccordMcpServer({ store, domain: new DomainService(store) });
    const proposal = changeProposalId('p-compile-mcp');
    await service.openChangeProposal({ actor: seed.providerActor, proposalId: proposal, contractId: seed.contract, title: 'Add REVERSED' });

    const unaccepted = await server.dispatch({
      tool: 'compile_spec',
      caller: { actor: human, grantedScopes: COMPILE_SCOPES },
      args: {
        proposalId: proposal,
        baseContract: baselineContractV1,
        approvedChanges: [{ decisionRecordId: decisionRecordId('dec-none'), changes: [{ op: 'add-enum-value', target: { method: 'get', path: '/payments/{paymentId}', response: '200', field: 'status' }, value: 'REVERSED' }] }]
      }
    });
    assert.equal(unaccepted.ok, false);
    assert.ok(!unaccepted.ok && unaccepted.code === 'domain-rule-violated');

    await service.recordDecision({
      actor: seed.providerActor,
      decisionRecordId: decisionRecordId('dec-mcp'),
      proposalId: proposal,
      decision: 'Add REVERSED',
      rationale: 'needed',
      approvers: [seed.providerActor],
      validFrom: new Date('2026-09-01T00:00:00Z')
    });
    await service.acceptChangeProposal({ actor: seed.providerActor, proposalId: proposal, openBlockingObjections: 0, requiredApproversSatisfied: true });

    const compiled = await server.dispatch({
      tool: 'compile_spec',
      caller: { actor: seed.providerActor, grantedScopes: COMPILE_SCOPES },
      args: {
        proposalId: proposal,
        baseContract: baselineContractV1,
        approvedChanges: [{ decisionRecordId: decisionRecordId('dec-mcp'), changes: [{ op: 'add-enum-value', target: { method: 'get', path: '/payments/{paymentId}', response: '200', field: 'status' }, value: 'REVERSED' }] }]
      }
    });
    assert.equal(compiled.ok, true);
    if (compiled.ok) {
      const manifest = (compiled.data as { manifest: { proposalId: string; outputChecksum: string } }).manifest;
      assert.equal(manifest.proposalId, proposal);
      assert.ok(manifest.outputChecksum.length > 0);
    }
  });

  it('list_pending_actions surfaces open blocking objections and unresolved questions (INV-014)', async () => {
    const store = new InMemoryEventStore();
    const seed = await seedBaselineCatalog(store, human);
    const service = new DomainService(store);
    const server = new ApiAccordMcpServer({ store, domain: new DomainService(store) });
    const proposal = changeProposalId('p-pending');
    await service.openChangeProposal({ actor: seed.providerActor, proposalId: proposal, contractId: seed.contract, title: 'x' });
    const objection = discussionEntryId('e-obj');
    await service.createDiscussionEntry({ actor: seed.merchantActor, entryId: objection, proposalId: proposal, kind: 'objection', body: 'blocking concern', isBlockingObjection: true });
    await service.raiseBlockingObjection({ actor: seed.merchantActor, entryId: objection, proposalId: proposal });
    const question = discussionEntryId('e-q');
    await service.createDiscussionEntry({ actor: seed.merchantActor, entryId: question, proposalId: proposal, kind: 'question', body: 'what about old clients?' });

    const result = await server.dispatch({ tool: 'list_pending_actions', caller: { actor: agent, grantedScopes: READ_SCOPES }, args: {} });
    assert.equal(result.ok, true);
    if (result.ok) {
      const pending = result.data as ReadonlyArray<{ proposalId: string; openBlockingObjections: number; unresolvedQuestions: ReadonlyArray<string> }>;
      const entry = pending.find((item) => item.proposalId === proposal);
      assert.ok(entry);
      assert.equal(entry?.openBlockingObjections, 1);
      assert.equal(entry?.unresolvedQuestions.length, 1);
    }
  });

  it('resources read proposals through shared projections (INV-029)', async () => {
    const store = new InMemoryEventStore();
    const seed = await seedBaselineCatalog(store, human);
    const service = new DomainService(store);
    const proposal = changeProposalId('p-res');
    await service.openChangeProposal({ actor: seed.providerActor, proposalId: proposal, contractId: seed.contract, title: 'x' });

    const resource = readResource(formatResourceUri('proposals', proposal), await store.getAll(), (_type, id) => id);
    assert.ok(typeof resource === 'object');
    const state = (resource as { proposal: { title: string } }).proposal;
    assert.equal(state.title, 'x');

    let bad: unknown;
    try {
      readResource(formatResourceUri('organizations', 'org-1'), await store.getAll(), (_type, id) => id);
    } catch (error) {
      bad = error;
    }
    assert.ok(bad instanceof McpError && bad.code === 'not-implemented');
  });
});
