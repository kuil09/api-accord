import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Evidence, EvidenceKind } from './index.js';
import {
  canGrantWaiver,
  computeConsumerReadinessFromEvidence,
  computeEvidenceRequirements,
  evaluateVerificationGate,
  isEvidenceStale
} from './evidence.js';
import { contractVersionId, evidenceId, principalRef, serviceId } from './primitives.js';

const now = new Date('2026-06-15T00:00:00Z');
const revision = 'rev-2';
const provider = principalRef('human', 'payments-owner');

function makeEvidence(input: { id: string; kind: EvidenceKind; status: Evidence['status']; scope?: string; revision?: string; expiresAt?: Date; provenance?: 'github-check' | 'direct-submission'; waivedKind?: EvidenceKind }): Evidence {
  return {
    id: evidenceId(input.id),
    contractVersionId: contractVersionId('contract-payments@rev-2'),
    sourceRevision: input.revision ?? revision,
    status: input.status,
    attachedAt: now,
    kind: input.kind,
    producer: provider,
    environment: 'staging',
    source: input.provenance === 'github-check' ? 'check-run-99' : 'submitted via API',
    checksum: undefined,
    observedAt: now,
    expiresAt: input.expiresAt,
    consumerServiceId: input.scope === undefined ? undefined : serviceId(input.scope),
    provenance: input.provenance ?? 'direct-submission',
    waivedKind: input.waivedKind
  };
}

describe('evidence staleness (INV-022 + expiry)', () => {
  it('is stale when bound to an older revision', () => {
    const old = makeEvidence({ id: 'e1', kind: 'provider-contract-test', status: 'passed', revision: 'rev-1' });
    assert.equal(isEvidenceStale({ evidence: old, currentSourceRevision: revision, now }).stale, true);
  });

  it('is stale after its expiry', () => {
    const expired = makeEvidence({ id: 'e2', kind: 'canary-result', status: 'passed', expiresAt: new Date('2026-06-01T00:00:00Z') });
    assert.equal(isEvidenceStale({ evidence: expired, currentSourceRevision: revision, now }).stale, true);
  });

  it('is current when bound to the revision and not expired', () => {
    const current = makeEvidence({ id: 'e3', kind: 'provider-contract-test', status: 'passed' });
    assert.equal(isEvidenceStale({ evidence: current, currentSourceRevision: revision, now }).stale, false);
  });
});

describe('required-evidence policy (issue #16)', () => {
  it('enum changes require consumer tests per affected consumer', () => {
    const requirements = computeEvidenceRequirements({
      changeKinds: ['enum-value-added'],
      affectedConsumerCriticalities: ['high', 'critical'],
      affectedConsumerIds: [serviceId('merchant-console'), serviceId('settlement-worker'), serviceId('mobile-app')]
    });
    const kinds = requirements.map((requirement) => requirement.kind);
    assert.ok(kinds.includes('provider-contract-test'));
    assert.ok(kinds.includes('schema-validation'));
    assert.ok(kinds.includes('pull-request'));
    assert.ok(kinds.includes('consumer-contract-test'));
    const consumerScopes = requirements.filter((requirement) => requirement.kind === 'consumer-contract-test').map((requirement) => requirement.scope);
    assert.equal(consumerScopes.length, 3, 'one consumer test requirement per affected consumer');
  });

  it('critical consumers require deployment and canary evidence', () => {
    const requirements = computeEvidenceRequirements({
      changeKinds: ['enum-value-added'],
      affectedConsumerCriticalities: ['critical'],
      affectedConsumerIds: [serviceId('settlement-worker')]
    });
    const kinds = requirements.map((requirement) => requirement.kind);
    assert.ok(kinds.includes('deployment-revision'));
    assert.ok(kinds.includes('canary-result'));
  });

  it('no requirements when nothing changed', () => {
    assert.equal(computeEvidenceRequirements({ changeKinds: [], affectedConsumerCriticalities: [] }).length, 0);
  });
});

describe('contract verification gate (INV-021..023)', () => {
  const requirements = [
    { kind: 'provider-contract-test' as EvidenceKind, scope: 'contract', reason: 'r1' },
    { kind: 'consumer-contract-test' as EvidenceKind, scope: 'merchant-console', reason: 'r2' },
    { kind: 'canary-result' as EvidenceKind, scope: 'contract', reason: 'r3' }
  ];

  it('is satisfied when every requirement has current passed evidence', () => {
    const evidence: ReadonlyArray<Evidence> = [
      makeEvidence({ id: 'e1', kind: 'provider-contract-test', status: 'passed' }),
      makeEvidence({ id: 'e2', kind: 'consumer-contract-test', status: 'passed', scope: 'merchant-console' }),
      makeEvidence({ id: 'e3', kind: 'canary-result', status: 'passed' })
    ];
    assert.equal(evaluateVerificationGate({ requirements, evidence, currentSourceRevision: revision, now }).satisfied, true);
  });

  it('reports missing, failed and stale requirements separately (INV-023)', () => {
    const evidence: ReadonlyArray<Evidence> = [
      makeEvidence({ id: 'e1', kind: 'provider-contract-test', status: 'passed' }),
      makeEvidence({ id: 'e2', kind: 'consumer-contract-test', status: 'failed', scope: 'merchant-console' }),
      makeEvidence({ id: 'e3', kind: 'canary-result', status: 'passed', revision: 'rev-1' })
    ];
    const gate = evaluateVerificationGate({ requirements, evidence, currentSourceRevision: revision, now });
    assert.equal(gate.satisfied, false);
    assert.equal(gate.failed.length, 1, 'failed evidence is reported as failed');
    assert.equal(gate.stale.length, 1, 'stale evidence is reported as stale');
    assert.equal(gate.missing.length, 0);
  });

  it('a current waiver satisfies the gate; an expired waiver does not (INV-023)', () => {
    const waiver = (expiresAt: Date, waivedKind: EvidenceKind): Evidence => makeEvidence({ id: 'w1', kind: 'waiver', status: 'waived', expiresAt, waivedKind });
    const withWaiver: ReadonlyArray<Evidence> = [
      makeEvidence({ id: 'e1', kind: 'provider-contract-test', status: 'passed' }),
      makeEvidence({ id: 'e2', kind: 'consumer-contract-test', status: 'passed', scope: 'merchant-console' }),
      waiver(new Date('2026-12-31T00:00:00Z'), 'canary-result')
    ];
    assert.equal(evaluateVerificationGate({ requirements, evidence: withWaiver, currentSourceRevision: revision, now }).satisfied, true);

    const expiredWaiver: ReadonlyArray<Evidence> = [
      makeEvidence({ id: 'e1', kind: 'provider-contract-test', status: 'passed' }),
      makeEvidence({ id: 'e2', kind: 'consumer-contract-test', status: 'passed', scope: 'merchant-console' }),
      waiver(new Date('2026-01-01T00:00:00Z'), 'canary-result')
    ];
    const gate = evaluateVerificationGate({ requirements, evidence: expiredWaiver, currentSourceRevision: revision, now });
    assert.equal(gate.satisfied, false);
    assert.equal(gate.missing.length, 1, 'expired waiver no longer covers the requirement');
  });

  it('waiver grants require a human grantor, a reason and an expiry', () => {
    assert.equal(canGrantWaiver({ reason: '', waivedRequirementKind: 'canary-result', expiresAt: now, grantor: provider }).ok, false);
    assert.equal(canGrantWaiver({ reason: 'risk accepted', waivedRequirementKind: 'canary-result', expiresAt: now, grantor: principalRef('agent', 'bot') }).ok, false);
    assert.equal(canGrantWaiver({ reason: 'risk accepted', waivedRequirementKind: 'waiver', expiresAt: now, grantor: provider }).ok, false);
    assert.equal(canGrantWaiver({ reason: 'risk accepted', waivedRequirementKind: 'canary-result', expiresAt: new Date('2026-12-31T00:00:00Z'), grantor: provider }).ok, true);
  });

  it('distinguishes GitHub check provenance from direct submission', () => {
    const gh = makeEvidence({ id: 'e1', kind: 'provider-contract-test', status: 'passed', provenance: 'github-check' });
    const direct = makeEvidence({ id: 'e2', kind: 'provider-contract-test', status: 'passed', provenance: 'direct-submission' });
    assert.ok(gh.provenance !== direct.provenance);
    assert.equal(gh.source, 'check-run-99');
    assert.equal(direct.source, 'submitted via API');
  });
});

describe('per-consumer readiness from evidence (baseline scenario)', () => {
  const consumers = [serviceId('merchant-console'), serviceId('settlement-worker'), serviceId('mobile-app')];

  it('computes provider 1 + consumers 3 readiness from evidence, not declarations', () => {
    const evidence: ReadonlyArray<Evidence> = [
      makeEvidence({ id: 'p1', kind: 'provider-contract-test', status: 'passed' }),
      makeEvidence({ id: 'c1', kind: 'consumer-contract-test', status: 'passed', scope: 'merchant-console' }),
      makeEvidence({ id: 'c2', kind: 'consumer-contract-test', status: 'passed', scope: 'settlement-worker' }),
      makeEvidence({ id: 'c3', kind: 'consumer-contract-test', status: 'failed', scope: 'mobile-app' })
    ];
    const readiness = computeConsumerReadinessFromEvidence({ consumerServiceIds: consumers, evidence, currentSourceRevision: revision, now });
    assert.equal(readiness.length, 3);
    const byConsumer = new Map(readiness.map((entry) => [entry.consumerServiceId, entry]));
    assert.equal(byConsumer.get(serviceId('merchant-console'))?.ready, true);
    assert.equal(byConsumer.get(serviceId('settlement-worker'))?.ready, true);
    assert.equal(byConsumer.get(serviceId('mobile-app'))?.ready, false);
    assert.match(byConsumer.get(serviceId('mobile-app'))?.reason ?? '', /failed/u);
  });

  it('evidence for an older revision does not make a consumer ready (INV-022)', () => {
    const evidence: ReadonlyArray<Evidence> = [
      makeEvidence({ id: 'c1', kind: 'consumer-contract-test', status: 'passed', scope: 'merchant-console', revision: 'rev-1' })
    ];
    const readiness = computeConsumerReadinessFromEvidence({ consumerServiceIds: [serviceId('merchant-console')], evidence, currentSourceRevision: revision, now });
    assert.equal(readiness[0]?.ready, false);
    assert.match(readiness[0]?.reason ?? '', /stale/u);
  });

  it('evidence is attributed to its contract version and revision', () => {
    const item = makeEvidence({ id: 'p1', kind: 'provider-contract-test', status: 'passed' });
    assert.equal(item.contractVersionId, contractVersionId('contract-payments@rev-2'));
    assert.equal(item.sourceRevision, revision);
    assert.equal(item.producer?.id, 'payments-owner');
  });
});
