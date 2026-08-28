import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DomainService } from './service.js';
import { InMemoryEventStore } from './events.js';
import {
  canPromoteDriftIncident,
  canResolveDriftIncident,
  detailFingerprint,
  driftIncidentsFrom,
  hasSufficientObservationWindow,
  redactDetail
} from './observation.js';
import { observationId, principalRef } from './primitives.js';

const observer = principalRef('integration', 'gateway-observer');
const human = principalRef('human', 'drift-reviewer');

const rawDetail = {
  status: 'CHARGEBACK',
  requestId: 'req-8813',
  user: { email: 'customer@example.com', name: 'Minji' },
  authorization: 'Bearer sk-live-123',
  latencyMs: 1400
};

const policy = { deniedFields: [], literalFields: ['status'] };

function observationInput(overrides: Partial<Parameters<DomainService['recordRuntimeObservation']>[0]> = {}): Parameters<DomainService['recordRuntimeObservation']>[0] {
  return {
    actor: observer,
    correlationId: 'obs',
    observationId: observationId('obs-1'),
    operationId: 'contract-payments:GET:/payments/{paymentId}',
    environment: 'production',
    contractVersionId: 'contract-payments@rev-2',
    deploymentRevision: 'rev-2',
    collectorVersion: 'collector-1.4.2',
    kind: 'enum-violation',
    detail: rawDetail,
    redactionPolicy: policy,
    sampleSize: 12,
    ...overrides
  };
}

describe('payload redaction (INV-031)', () => {
  it('removes denied fields, hashes other leaves, keeps contract-relevant literals', () => {
    const redacted = redactDetail(rawDetail, policy);
    assert.equal(redacted['authorization'], undefined, 'secrets are removed');
    const user = redacted['user'] as { email?: unknown; name?: { hash: string } };
    assert.equal(user['email'], undefined, 'PII is removed');
    assert.ok(typeof user['name'] === 'object' && user['name'] !== null && 'hash' in (user['name'] as object), 'other PII is hashed');
    assert.equal((redacted['status'] as { hash?: string })?.hash, undefined, 'contract-relevant enum value keeps its literal');
    assert.equal(redacted['status'], 'CHARGEBACK');
    assert.ok(JSON.stringify(redacted).includes('customer@example.com') === false, 'raw PII never survives');
  });

  it('the ledger never receives the raw payload', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    await service.recordRuntimeObservation(observationInput());
    const ledgerText = JSON.stringify(await store.getAll());
    assert.ok(ledgerText.includes('customer@example.com') === false, 'no raw PII in the ledger');
    assert.ok(ledgerText.includes('sk-live-123') === false, 'no raw secret in the ledger');
    assert.ok(ledgerText.includes('CHARGEBACK'), 'contract-relevant values survive');
  });
});

describe('drift incident aggregation (issue #17)', () => {
  it('folds repeated violations into one incident with occurrence tracking', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    await service.recordRuntimeObservation(observationInput({ at: new Date('2026-05-01T00:00:00Z') }));
    await service.recordRuntimeObservation(observationInput({ observationId: observationId('obs-2'), at: new Date('2026-05-02T00:00:00Z') }));

    const incidents = driftIncidentsFrom(await store.getAll());
    assert.equal(incidents.length, 1, 'deduplicated into a single incident');
    assert.equal(incidents[0]?.occurrences, 2);
    assert.equal(incidents[0]?.status, 'open');
    assert.equal(incidents[0]?.environment, 'production');
    assert.equal(incidents[0]?.contractVersionId, 'contract-payments@rev-2');
    assert.equal(incidents[0]?.deploymentRevision, 'rev-2');
    assert.equal(incidents[0]?.collectorVersion, 'collector-1.4.2');
    assert.equal(incidents[0]?.firstObservedAt.getTime(), new Date('2026-05-01T00:00:00Z').getTime());
  });

  it('tracks recurrence: a violation after resolution starts a new incident generation', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    await service.recordRuntimeObservation(observationInput());
    const first = driftIncidentsFrom(await store.getAll())[0];
    await service.resolveDriftIncident({ actor: human, incidentId: first?.incidentId ?? '', resolution: 'fixed', reason: 'mapping shipped' });
    await service.recordRuntimeObservation(observationInput({ observationId: observationId('obs-3'), at: new Date('2026-06-01T00:00:00Z') }));

    const incidents = driftIncidentsFrom(await store.getAll());
    assert.equal(incidents.length, 2, 'recurrence starts a new generation');
    assert.ok(incidents.every((incident) => incident.status === 'open' || incident.status === 'fixed'));
    const reopened = incidents.find((incident) => incident.incidentId !== first?.incidentId);
    assert.ok(reopened);
    assert.equal(reopened?.occurrences, 1);
  });

  it('records environment, contract version and deployment revision for traceability', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    await service.recordRuntimeObservation(observationInput());
    const incident = driftIncidentsFrom(await store.getAll())[0];
    assert.ok(incident);
    assert.equal(incident.environment, 'production');
    assert.equal(incident.contractVersionId, 'contract-payments@rev-2');
    assert.equal(incident.deploymentRevision, 'rev-2');
    assert.equal(incident.collectorVersion, 'collector-1.4.2', 'collector version is recorded');
  });
});

describe('drift resolution and promotion (INV-024, INV-012)', () => {
  it('requires a reason for resolution', () => {
    assert.equal(canResolveDriftIncident({ resolution: 'fixed', reason: '' }).ok, false);
    assert.equal(canResolveDriftIncident({ resolution: 'accepted-deviation', reason: 'documented deviation' }).ok, true);
  });

  it('promotes an open incident into an unverified context candidate', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    await service.recordRuntimeObservation(observationInput());
    const incident = driftIncidentsFrom(await store.getAll())[0];
    await service.promoteDriftIncident({ actor: human, incidentId: incident?.incidentId ?? '' });

    const all = await store.getAll();
    const promotedContext = all.find((event) => event.event.type === 'ContextProposed' && event.aggregateType === 'contextItem');
    assert.ok(promotedContext);
    if (promotedContext && promotedContext.event.type === 'ContextProposed') {
      assert.equal(promotedContext.event.confidence, 'unverified', 'drift becomes an unverified candidate, not a fact');
      assert.match(promotedContext.event.source, /drift incident/u);
    }
    const incidents = driftIncidentsFrom(all);
    assert.ok(incidents[0]?.promotedContextItemId !== undefined, 'the incident links to its promoted context');
    assert.ok(all.some((event) => event.event.type === 'ContractVersionPublished') === false, 'promotion never publishes a contract (INV-024)');
  });

  it('rejects promotion of a resolved incident', async () => {
    const store = new InMemoryEventStore();
    const service = new DomainService(store);
    await service.recordRuntimeObservation(observationInput());
    const incident = driftIncidentsFrom(await store.getAll())[0];
    await service.resolveDriftIncident({ actor: human, incidentId: incident?.incidentId ?? '', resolution: 'false-positive', reason: 'bad fixture' });
    const resolved = driftIncidentsFrom(await store.getAll())[0];
    assert.equal(canPromoteDriftIncident({ incident: resolved as never, statement: 'x' }).ok, false);
  });
});

describe('observation window policy (INV-025)', () => {
  it('requires both the sample minimum and the window minimum', () => {
    const start = new Date('2026-05-01T00:00:00Z');
    const threeDays = new Date('2026-05-04T00:00:00Z');
    const eightDays = new Date('2026-05-09T00:00:00Z');
    assert.equal(hasSufficientObservationWindow({ firstObservedAt: start, now: threeDays, minimumWindowDays: 7, sampleSize: 500, minimumSampleSize: 100 }).satisfied, false);
    assert.equal(hasSufficientObservationWindow({ firstObservedAt: start, now: eightDays, minimumWindowDays: 7, sampleSize: 50, minimumSampleSize: 100 }).satisfied, false);
    assert.equal(hasSufficientObservationWindow({ firstObservedAt: start, now: eightDays, minimumWindowDays: 7, sampleSize: 500, minimumSampleSize: 100 }).satisfied, true);
  });

  it('detail fingerprint is stable for identical details', () => {
    assert.equal(detailFingerprint({ a: 1, b: 'x' }), detailFingerprint({ a: 1, b: 'x' }));
  });
});
