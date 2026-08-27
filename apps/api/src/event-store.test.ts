import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { contextItemId } from '@api-accord/domain';
import type { DomainEvent } from '@api-accord/domain';

import { buildAppendStatement, rowToEnvelope } from './event-store.js';

const sampleEvent: DomainEvent = {
  type: 'ContextProposed',
  contextItemId: contextItemId('ctx1'),
  scope: 'operation',
  statement: 'status is enum',
  contextType: 'assumption',
  author: { kind: 'human', id: 'a' },
  source: 'doc',
  confidence: 'unverified'
};

describe('buildAppendStatement', () => {
  it('produces a 10-parameter insert binding the payload as jsonb', () => {
    const { text, values } = buildAppendStatement({
      eventId: 'e1',
      aggregateType: 'contextItem',
      aggregateId: 'ctx1',
      eventType: 'ContextProposed',
      occurredAt: new Date('2026-01-01T00:00:00Z'),
      actorKind: 'human',
      actorId: 'a',
      correlationId: 'c1',
      version: 1,
      payload: sampleEvent
    });
    assert.match(text, /\$10::jsonb/u);
    assert.equal(values.length, 10);
    assert.equal(values[0], 'e1');
    assert.equal(values[1], 'contextItem');
    assert.equal(values[8], 1);
    assert.equal(values[9], JSON.stringify(sampleEvent));
  });
});

describe('rowToEnvelope', () => {
  it('maps a domain_event row back to an envelope, preserving the payload object', () => {
    const envelope = rowToEnvelope({
      event_id: 'e1',
      aggregate_type: 'contextItem',
      aggregate_id: 'ctx1',
      event_type: 'ContextProposed',
      occurred_at: new Date('2026-01-01T00:00:00Z'),
      actor_kind: 'human',
      actor_id: 'a',
      correlation_id: 'c1',
      version: 1,
      payload: sampleEvent
    });
    assert.equal(envelope.eventId, 'e1');
    assert.equal(envelope.aggregateType, 'contextItem');
    assert.equal(envelope.aggregateId, 'ctx1');
    assert.equal(envelope.version, 1);
    assert.equal(envelope.actor.kind, 'human');
    assert.equal(envelope.actor.id, 'a');
    assert.ok(envelope.event === sampleEvent, 'payload object is preserved by reference');
  });
});
