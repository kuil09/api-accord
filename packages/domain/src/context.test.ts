import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InMemoryEventStore } from './events.js';
import { DomainService, DomainRuleError } from './service.js';
import { contextItemFrom, detectContextConflicts, queryContext } from './projection.js';
import { contextItemId, principalRef } from './primitives.js';
import type { ContextItem } from './model.js';

const human = principalRef('human', 'alice');
const agent = principalRef('agent', 'bot');

function proposed(id: string): ContextItem {
  return {
    id: contextItemId(id),
    scope: 'operation',
    statement: 'status APPROVED implies approvedAt exists',
    contextType: 'assumption',
    author: human,
    source: 'doc',
    confidence: 'unverified',
    validFrom: new Date(0),
    visibility: 'organization',
    disputed: false
  };
}

describe('ContextService commands', () => {
  it('AI item cannot be confirmed by an agent (stays unverified)', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const item = contextItemId('ctx-ai');
    await store.append({
      actor: agent,
      correlationId: 'c',
      event: { type: 'ContextProposed', contextItemId: item, scope: 'operation', statement: 'x', contextType: 'assumption', author: agent, source: 'inference', confidence: 'inferred' }
    });
    let thrown: unknown;
    try {
      await service.confirmContext({ actor: agent, contextItemId: item, validFrom: new Date(), source: 'doc' });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof DomainRuleError, 'expected a DomainRuleError');
    if (thrown instanceof DomainRuleError) {
      assert.match(thrown.reason, /human/u);
    }
  });

  it('human can confirm an item', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const item = contextItemId('ctx-h');
    await store.append({
      actor: human,
      correlationId: 'c',
      event: { type: 'ContextProposed', contextItemId: item, scope: 'operation', statement: 'x', contextType: 'assumption', author: human, source: 'doc', confidence: 'unverified' }
    });
    await service.confirmContext({ actor: human, contextItemId: item, validFrom: new Date(), source: 'doc' });
    const reconstructed = contextItemFrom(await store.getAll(), item);
    assert.equal(reconstructed?.confidence, 'confirmed');
  });

  it('records a challenge as a dispute without mutating the statement', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const item = contextItemId('ctx-ch');
    await store.append({
      actor: human,
      correlationId: 'c',
      event: { type: 'ContextProposed', contextItemId: item, scope: 'operation', statement: 'always present', contextType: 'fact', author: human, source: 'doc', confidence: 'confirmed' }
    });
    await service.challengeContext({ actor: principalRef('human', 'bob'), contextItemId: item, reason: 'not always' });
    const reconstructed = contextItemFrom(await store.getAll(), item);
    assert.equal(reconstructed?.disputed, true);
    assert.equal(reconstructed?.statement, 'always present', 'statement is not silently changed');
    assert.equal(reconstructed?.challengedBy?.id, 'bob');
  });

  it('narrowing scope, adding evidence, expiring and changing visibility are audited', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    const item = contextItemId('ctx-flow');
    await store.append({
      actor: human,
      correlationId: 'c',
      event: { type: 'ContextProposed', contextItemId: item, scope: 'operation', statement: 'x', contextType: 'fact', author: human, source: 'doc', confidence: 'confirmed' }
    });
    await service.narrowContextScope({ actor: human, contextItemId: item, scope: 'apiContract', previousScope: 'operation' });
    await service.addContextEvidence({ actor: human, contextItemId: item, evidenceRef: 'ev-1' });
    await service.expireContext({ actor: human, contextItemId: item, at: new Date('2026-12-31') });
    await service.changeContextVisibility({ actor: human, contextItemId: item, visibility: 'team' });
    const all = await store.getAll();
    assert.ok(all.some((e) => e.event.type === 'ContextNarrowedScope'));
    assert.ok(all.some((e) => e.event.type === 'ContextEvidenceAdded'));
    assert.ok(all.some((e) => e.event.type === 'ContextExpired'));
    assert.ok(all.some((e) => e.event.type === 'ContextVisibilityChanged'));
    const reconstructed = contextItemFrom(all, item);
    assert.equal(reconstructed?.scope, 'apiContract');
    assert.equal(reconstructed?.evidenceRef, 'ev-1');
    assert.equal(reconstructed?.visibility, 'team');
    assert.ok(reconstructed?.validUntil !== undefined);
  });
});

describe('context conflict detection and query (issue #7)', () => {
  it('detects contradictory items in the same scope', () => {
    const items = [proposed('a'), { ...proposed('b'), statement: 'status APPROVED does NOT imply approvedAt' }];
    const conflicts = detectContextConflicts(items);
    assert.equal(conflicts.length, 1);
  });

  it('does not flag identical statements as conflicts', () => {
    const items = [proposed('a'), { ...proposed('b'), id: contextItemId('b') }];
    assert.equal(detectContextConflicts(items).length, 0);
  });

  it('filters by confirmed, disputed, and non-expired', () => {
    const now = new Date('2026-06-01');
    const items: ContextItem[] = [
      { ...proposed('a'), confidence: 'confirmed' },
      { ...proposed('b'), confidence: 'unverified', validUntil: new Date('2026-01-01') },
      { ...proposed('c'), disputed: true }
    ];
    assert.equal(queryContext(items, { includeConfirmedOnly: true }, now).length, 1);
    assert.equal(queryContext(items, { includeDisputedOnly: true }, now).length, 1);
    assert.equal(queryContext(items, {}, now).length, 2, 'expired item excluded by default');
    assert.equal(queryContext(items, { includeExpired: true }, now).length, 3);
  });
});
