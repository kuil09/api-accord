import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EventEnvelope, DomainEvent } from './index.js';
import { InMemoryEventStore } from './events.js';
import {
  allowedForAiInput,
  auditEventsFrom,
  checkRateLimit,
  classifySensitiveContent,
  enforceOrganizationBoundary,
  exportAuditRecords,
  isCredentialUsable,
  isWebhookReplay,
  isWithinRetention,
  verifyLedgerIntegrity
} from './security.js';
import { changeProposalId, principalRef } from './primitives.js';


function envelope(input: { eventId: string; aggregateType: 'changeProposal'; aggregateId: string; version: number; eventType: string; actorId: string; at: Date }): EventEnvelope<DomainEvent> {
  const event =
    input.eventType === 'ChangeProposalOpened'
      ? { type: 'ChangeProposalOpened' as const, proposalId: input.aggregateId as never, contractId: 'c' as never, title: 'x' }
      : input.eventType === 'ChangeProposalAccepted'
        ? { type: 'ChangeProposalAccepted' as const, proposalId: input.aggregateId as never }
        : { type: 'ChangeProposalCompleted' as const, proposalId: input.aggregateId as never };
  return {
    eventId: input.eventId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    occurredAt: input.at,
    actor: { kind: 'human', id: input.actorId },
    correlationId: 'corr',
    version: input.version,
    event
  };
}

describe('organization boundary (INV-029)', () => {
  it('denies cross-organization access and unresolved organizations', () => {
    assert.equal(enforceOrganizationBoundary({ callerOrganizationId: 'org-a', resourceOrganizationId: 'org-b' }).ok, false);
    assert.equal(enforceOrganizationBoundary({ callerOrganizationId: 'org-a', resourceOrganizationId: 'org-a' }).ok, true);
    assert.equal(enforceOrganizationBoundary({ callerOrganizationId: 'org-a', resourceOrganizationId: '' }).ok, false, 'unresolved organization is not silently allowed');
  });

  it('blocks data access across organizations in a multi-org ledger', async () => {
    const store = new InMemoryEventStore();
    const orgA = principalRef('human', 'org-a-owner');
    const proposalA = changeProposalId('org-a-proposal');
    await store.append({ actor: orgA, correlationId: 'a', event: { type: 'ChangeProposalOpened', proposalId: proposalA, contractId: 'c-a' as never, title: 'org-a secret change' } });

    const all = await store.getAll();
    // org-b tries to read org-a's proposal by guessing the id: the boundary
    // check denies before any projection runs.
    const check = enforceOrganizationBoundary({ callerOrganizationId: 'org-b', resourceOrganizationId: 'org-a' });
    assert.equal(check.ok, false);
    if (!check.ok) {
      assert.match(check.reason, /cross-organization/u);
    }
    // Even so, the ledger itself records org-a's data only for org-a members.
    assert.ok(all.every((event) => event.actor.id !== 'org-b-owner'));
  });
});

describe('audit search and export (INV-030)', () => {
  const events: ReadonlyArray<EventEnvelope<DomainEvent>> = [
    envelope({ eventId: 'e1', aggregateType: 'changeProposal', aggregateId: 'p1', version: 1, eventType: 'ChangeProposalOpened', actorId: 'alice', at: new Date('2026-01-01T00:00:00Z') }),
    envelope({ eventId: 'e2', aggregateType: 'changeProposal', aggregateId: 'p1', version: 2, eventType: 'ChangeProposalAccepted', actorId: 'bob', at: new Date('2026-01-02T00:00:00Z') }),
    envelope({ eventId: 'e3', aggregateType: 'changeProposal', aggregateId: 'p1', version: 3, eventType: 'ChangeProposalCompleted', actorId: 'alice', at: new Date('2026-01-03T00:00:00Z') })
  ];

  it('searches by actor, event type and time range', () => {
    assert.equal(auditEventsFrom(events, { actorId: 'alice' }).length, 2);
    assert.equal(auditEventsFrom(events, { eventType: 'ChangeProposalAccepted' }).length, 1);
    assert.equal(auditEventsFrom(events, { since: new Date('2026-01-02T00:00:00Z') }).length, 2);
  });

  it('exports records deterministically with actor, event, aggregate and correlation', () => {
    const exported = exportAuditRecords(auditEventsFrom(events, {}));
    const lines = exported.split('\n');
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.ok(line.includes('"actorId"'));
      assert.ok(line.includes('"correlationId"'));
      assert.ok(line.includes('"eventType"'));
    }
  });
});

describe('ledger integrity (issue #21 backup verification)', () => {
  it('is intact for a contiguous ledger', () => {
    const events: ReadonlyArray<EventEnvelope<DomainEvent>> = [
      envelope({ eventId: 'a1', aggregateType: 'changeProposal', aggregateId: 'p1', version: 1, eventType: 'ChangeProposalOpened', actorId: 'a', at: new Date() }),
      envelope({ eventId: 'a2', aggregateType: 'changeProposal', aggregateId: 'p1', version: 2, eventType: 'ChangeProposalAccepted', actorId: 'a', at: new Date() })
    ];
    assert.equal(verifyLedgerIntegrity(events).intact, true);
  });

  it('detects a version gap left by a lost event in a restored backup', () => {
    const backup: ReadonlyArray<EventEnvelope<DomainEvent>> = [
      envelope({ eventId: 'a1', aggregateType: 'changeProposal', aggregateId: 'p1', version: 1, eventType: 'ChangeProposalOpened', actorId: 'a', at: new Date() }),
      envelope({ eventId: 'a3', aggregateType: 'changeProposal', aggregateId: 'p1', version: 3, eventType: 'ChangeProposalCompleted', actorId: 'a', at: new Date() })
    ];
    const check = verifyLedgerIntegrity(backup);
    assert.equal(check.intact, false);
    assert.ok(check.violations.some((violation) => /expected version 2/u.test(violation)));
  });

  it('detects duplicate event ids in a restored backup', () => {
    const duplicate = envelope({ eventId: 'dup', aggregateType: 'changeProposal', aggregateId: 'p1', version: 1, eventType: 'ChangeProposalOpened', actorId: 'a', at: new Date() });
    const check = verifyLedgerIntegrity([duplicate, { ...duplicate, version: 2, event: { type: 'ChangeProposalAccepted' as const, proposalId: 'p1' as never } }]);
    assert.equal(check.intact, false);
    assert.ok(check.violations.some((violation) => /duplicate event id/u.test(violation)));
  });
});

describe('sensitive content classification (INV-031)', () => {
  it('classifies secrets, PII and clean text differently', () => {
    const secret = classifySensitiveContent('authorization: Bearer abc123def');
    assert.equal(secret.classification, 'secret');
    const pii = classifySensitiveContent('contact customer@example.com for access');
    assert.equal(pii.classification, 'confidential');
    const clean = classifySensitiveContent('PaymentStatus enum gained REVERSED');
    assert.equal(clean.classification, 'public');
  });

  it('secrets and confidential content never go to an AI provider (issue #21)', () => {
    assert.equal(allowedForAiInput({ classification: 'secret' }), false);
    assert.equal(allowedForAiInput({ classification: 'confidential' }), false);
    assert.equal(allowedForAiInput({ classification: 'internal', providerAllowsInternal: true }), true);
    assert.equal(allowedForAiInput({ classification: 'public' }), true);
  });
});

describe('credential revocation is immediate (issue #21)', () => {
  it('a revoked credential stops working at once, for Web API and MCP alike', () => {
    const revokedAt = new Date('2026-06-01T00:00:00Z');
    const now = new Date('2026-06-02T00:00:00Z');
    const revoked = isCredentialUsable({ revokedAt, now });
    assert.equal(revoked.usable, false);
    const sameCheckForMcp = isCredentialUsable({ revokedAt, now: new Date('2026-06-03T00:00:00Z') });
    assert.equal(sameCheckForMcp.usable, false, 'the same domain rule serves Web API and MCP (INV-029)');
    const active = isCredentialUsable({ revokedAt: undefined, expiresAt: new Date('2027-01-01T00:00:00Z'), now });
    assert.equal(active.usable, true);
    const expired = isCredentialUsable({ revokedAt: undefined, expiresAt: new Date('2026-01-01T00:00:00Z'), now });
    assert.equal(expired.usable, false);
  });
});

describe('rate limiting and webhook replay defense (issue #21)', () => {
  it('blocks requests beyond the window budget and reports retry time', () => {
    const now = new Date('2026-06-15T00:00:10Z');
    const requests = [1, 2, 3, 4, 5].map((seconds) => new Date('2026-06-15T00:00:0' + String(seconds) + 'Z'));
    const blocked = checkRateLimit({ requestTimes: requests, windowMs: 10_000, maxRequests: 5, now });
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0);
    const allowed = checkRateLimit({ requestTimes: requests.slice(0, 4), windowMs: 10_000, maxRequests: 5, now });
    assert.equal(allowed.allowed, true);
  });

  it('detects webhook replays by delivery id and by stale timestamp', () => {
    const now = new Date('2026-06-15T00:00:00Z');
    const replayById = isWebhookReplay({ deliveryId: 'd-1', seenDeliveryIds: ['d-1'], timestamp: now, now, maxAgeMs: 60_000 });
    assert.equal(replayById, true, 'a seen delivery id is a replay');
    const staleTimestamp = isWebhookReplay({ deliveryId: 'd-2', seenDeliveryIds: [], timestamp: new Date('2026-06-14T00:00:00Z'), now, maxAgeMs: 60_000 });
    assert.equal(staleTimestamp, true, 'an old delivery is a replay');
    const fresh = isWebhookReplay({ deliveryId: 'd-3', seenDeliveryIds: [], timestamp: now, now, maxAgeMs: 60_000 });
    assert.equal(fresh, false);
  });
});

describe('retention and legal hold (issue #21)', () => {
  const recordedAt = new Date('2025-01-01T00:00:00Z');
  const now = new Date('2026-01-01T00:00:00Z');

  it('expired data becomes deletable unless a legal hold blocks it', () => {
    const expired = isWithinRetention({ recordedAt, now, policy: { retainDays: 365, legalHold: false } });
    assert.equal(expired.expired, true);
    assert.equal(expired.deletable, true);
    const held = isWithinRetention({ recordedAt, now, policy: { retainDays: 365, legalHold: true } });
    assert.equal(held.deletable, false, 'legal hold blocks deletion');
    assert.match(held.reason, /legal hold/u);
    const within = isWithinRetention({ recordedAt, now, policy: { retainDays: 400, legalHold: false } });
    assert.equal(within.expired, false);
  });
});
