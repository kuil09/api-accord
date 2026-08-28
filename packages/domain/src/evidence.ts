// Evidence pipeline (issue #16): required-evidence policy, the contract
// verification gate, waivers, and per-consumer readiness computed from
// evidence. Pure and deterministic. INV-021/022/023 are enforced here and in
// rules.ts; a waiver is an explicit, expiring, auditable exception -- never a
// disguised success (INV-023).

import type { Evidence, EvidenceKind, EvidenceProvenance } from './model.js';
import type { EventEnvelope, DomainEvent } from './events.js';
import type { ServiceId } from './primitives.js';

// --- Staleness (INV-022 + expiry) ---

export function isEvidenceStale(input: {
  readonly evidence: Evidence;
  readonly currentSourceRevision: string;
  readonly now: Date;
}): { readonly stale: boolean; readonly reason: string } {
  if (input.evidence.sourceRevision !== input.currentSourceRevision) {
    return { stale: true, reason: `evidence is bound to revision '${input.evidence.sourceRevision}', not the current '${input.currentSourceRevision}'` };
  }
  if (input.evidence.expiresAt !== undefined && input.evidence.expiresAt.getTime() < input.now.getTime()) {
    return { stale: true, reason: `evidence expired at ${input.evidence.expiresAt.toISOString()}` };
  }
  return { stale: false, reason: 'evidence is current' };
}

// --- Required-evidence policy ---

export interface EvidenceRequirement {
  readonly kind: EvidenceKind;
  // 'contract' for proposal-wide requirements, or a consumer service id for
  // consumer-scoped requirements.
  readonly scope: string;
  readonly reason: string;
}

export function computeEvidenceRequirements(input: {
  readonly changeKinds: ReadonlyArray<string>;
  readonly affectedConsumerCriticalities: ReadonlyArray<'low' | 'medium' | 'high' | 'critical'>;
  readonly affectedConsumerIds?: ReadonlyArray<ServiceId>;
}): ReadonlyArray<EvidenceRequirement> {
  const requirements: EvidenceRequirement[] = [];
  const push = (requirement: EvidenceRequirement): void => {
    if (!requirements.some((existing) => existing.kind === requirement.kind && existing.scope === requirement.scope)) {
      requirements.push(requirement);
    }
  };

  const hasContractChange = input.changeKinds.length > 0;
  if (hasContractChange) {
    push({ kind: 'provider-contract-test', scope: 'contract', reason: 'every contract change requires provider contract tests' });
    push({ kind: 'schema-validation', scope: 'contract', reason: 'the generated contract must pass schema validation' });
    push({ kind: 'pull-request', scope: 'contract', reason: 'the change must be traceable to a pull request' });
  }
  const touchesValues = input.changeKinds.some((kind) => kind.includes('enum') || kind.includes('field') || kind.includes('required'));
  if (touchesValues) {
    for (const consumerId of input.affectedConsumerIds ?? []) {
      push({ kind: 'consumer-contract-test', scope: consumerId, reason: 'consumers of changed fields/values must run their contract tests' });
    }
  }
  const critical = input.affectedConsumerCriticalities.some((criticality) => criticality === 'critical');
  if (critical) {
    push({ kind: 'deployment-revision', scope: 'contract', reason: 'critical consumers require a deployment revision bound to the change' });
    push({ kind: 'canary-result', scope: 'contract', reason: 'critical consumers require a canary result before completion' });
  }
  return requirements;
}

// --- Verification gate ---

export interface GateMiss {
  readonly requirement: EvidenceRequirement;
  readonly reason: string;
}

export interface VerificationGate {
  readonly satisfied: boolean;
  readonly missing: ReadonlyArray<GateMiss>;
  readonly failed: ReadonlyArray<GateMiss>;
  readonly stale: ReadonlyArray<GateMiss>;
  readonly waived: ReadonlyArray<GateMiss>;
}

function evidenceMatchesRequirement(evidence: Evidence, requirement: EvidenceRequirement): boolean {
  if (evidence.kind !== requirement.kind) {
    return false;
  }
  if (requirement.scope === 'contract') {
    return true;
  }
  return evidence.consumerServiceId !== undefined && evidence.consumerServiceId === requirement.scope;
}

function waiverCovers(waiver: Evidence, requirement: EvidenceRequirement): boolean {
  return waiver.kind === 'waiver' && waiver.waivedKind === requirement.kind;
}

// Computes the contract verification gate (INV-021): every requirement must be
// satisfied by current, passed evidence; failed evidence is reported as failed,
// stale evidence as stale, and open waivers as waived -- each category separate,
// none folded into success (INV-023).
export function evaluateVerificationGate(input: {
  readonly requirements: ReadonlyArray<EvidenceRequirement>;
  readonly evidence: ReadonlyArray<Evidence>;
  readonly currentSourceRevision: string;
  readonly now: Date;
}): VerificationGate {
  const missing: GateMiss[] = [];
  const failed: GateMiss[] = [];
  const stale: GateMiss[] = [];
  const waived: GateMiss[] = [];

  for (const requirement of input.requirements) {
    // A waiver matches by its waivedKind, regular evidence by kind + scope.
    const matching = input.evidence.filter((evidence) => evidenceMatchesRequirement(evidence, requirement) || waiverCovers(evidence, requirement));
    const waivers = matching.filter((evidence) => waiverCovers(evidence, requirement) && (isEvidenceStale({ evidence, currentSourceRevision: input.currentSourceRevision, now: input.now }).stale === false));

    const evaluations = matching
      .filter((evidence) => !waiverCovers(evidence, requirement))
      .map((evidence) => ({ evidence, staleness: isEvidenceStale({ evidence, currentSourceRevision: input.currentSourceRevision, now: input.now }) }));

    const passed = evaluations.find((entry) => entry.evidence.status === 'passed' && entry.staleness.stale === false);
    if (passed !== undefined) {
      continue;
    }
    const failedEvidence = evaluations.find((entry) => entry.evidence.status === 'failed' && entry.staleness.stale === false);
    if (failedEvidence !== undefined) {
      failed.push({ requirement, reason: failedEvidence.evidence.source ?? 'contract test failed' });
      continue;
    }
    const staleEvidence = evaluations.find((entry) => entry.staleness.stale === true);
    if (staleEvidence !== undefined) {
      stale.push({ requirement, reason: staleEvidence.staleness.reason });
      continue;
    }
    if (waivers.length > 0) {
      waived.push({ requirement, reason: 'waived by an authorized principal with an expiry' });
      continue;
    }
    missing.push({ requirement, reason: 'no matching evidence was submitted' });
  }

  return {
    satisfied: missing.length === 0 && failed.length === 0 && stale.length === 0,
    missing,
    failed,
    stale,
    waived
  };
}

// --- Waiver ---

// A waiver is an explicit, expiring, authorized exception to one requirement.
export function canGrantWaiver(input: {
  readonly reason: string;
  readonly waivedRequirementKind: EvidenceKind;
  readonly expiresAt: Date;
  readonly grantor: { readonly kind: 'human' | 'agent' | 'service' | 'ci' | 'integration'; readonly id: string };
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (input.reason.trim().length === 0) {
    return { ok: false, reason: 'issue #16: a waiver requires an explicit reason' };
  }
  if (input.grantor.kind !== 'human') {
    return { ok: false, reason: 'issue #16: only a human principal can grant a waiver' };
  }
  if (Number.isNaN(input.expiresAt.getTime())) {
    return { ok: false, reason: 'issue #16: a waiver requires a valid expiry date' };
  }
  if (input.waivedRequirementKind === 'waiver') {
    return { ok: false, reason: 'issue #16: a waiver cannot waive another waiver' };
  }
  return { ok: true };
}

// --- Per-consumer readiness computed from evidence ---

export interface ConsumerReadinessFromEvidence {
  readonly consumerServiceId: ServiceId;
  readonly ready: boolean;
  readonly reason: string;
  readonly evidenceId?: string | undefined;
}

// Baseline scenario completion condition: provider readiness plus per-consumer
// readiness are computed from evidence, not declared. A consumer is ready when
// a current, passed consumer contract test exists for it.
export function computeConsumerReadinessFromEvidence(input: {
  readonly consumerServiceIds: ReadonlyArray<ServiceId>;
  readonly evidence: ReadonlyArray<Evidence>;
  readonly currentSourceRevision: string;
  readonly now: Date;
}): ReadonlyArray<ConsumerReadinessFromEvidence> {
  return input.consumerServiceIds.map((consumerServiceId) => {
    const matching = input.evidence.filter((evidence) => evidence.kind === 'consumer-contract-test' && evidence.consumerServiceId === consumerServiceId);
    const current = matching.filter((evidence) => isEvidenceStale({ evidence, currentSourceRevision: input.currentSourceRevision, now: input.now }).stale === false);
    const passed = current.find((evidence) => evidence.status === 'passed');
    if (passed !== undefined) {
      return { consumerServiceId, ready: true, reason: 'current consumer contract test passed', evidenceId: passed.id };
    }
    const failed = current.find((evidence) => evidence.status === 'failed');
    if (failed !== undefined) {
      return { consumerServiceId, ready: false, reason: 'current consumer contract test failed', evidenceId: failed.id };
    }
    if (matching.length > 0) {
      return { consumerServiceId, ready: false, reason: 'consumer contract test evidence is stale for the current revision', evidenceId: matching[0]?.id };
    }
    return { consumerServiceId, ready: false, reason: 'no consumer contract test evidence submitted' };
  });
}

// --- Provenance (GitHub check vs direct submission) ---

export function provenanceOf(evidence: Evidence): EvidenceProvenance | undefined {
  return evidence.provenance;
}

// Reconstructs evidence records from the ledger (issue #16). Metadata submitted
// at attach time round-trips through the event payload.
export function evidenceFromEvents(events: ReadonlyArray<EventEnvelope<DomainEvent>>): ReadonlyArray<Evidence> {
  const output: Evidence[] = [];
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type !== 'EvidenceAttached' || envelope.aggregateType !== 'evidence') {
      continue;
    }
    output.push({
      id: event.evidenceId,
      contractVersionId: event.contractVersionId,
      sourceRevision: event.sourceRevision,
      status: event.status,
      attachedAt: envelope.occurredAt,
      kind: event.kind,
      producer: event.producer,
      environment: event.environment,
      source: event.source,
      checksum: event.checksum,
      observedAt: event.observedAt,
      expiresAt: event.expiresAt,
      consumerServiceId: event.consumerServiceId,
      provenance: event.provenance,
      waivedKind: event.waivedKind
    });
  }
  return output;
}
