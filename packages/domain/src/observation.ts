// Runtime observation, drift incidents, and promotion (issue #17).
//
// Framework-independent. The observer is non-intrusive by construction: it
// consumes already-captured traffic samples and appends facts to the ledger; it
// never sits in the request path and never modifies a contract or decision by
// itself (INV-024). Sensitive payloads are redacted centrally before anything
// reaches the ledger (INV-031): denied fields are removed, other leaf values are
// replaced by hashes, and only explicitly whitelisted contract-relevant fields
// keep their literal value. Samples below the policy minimum are "insufficient
// evidence", never healthy (INV-025).

import type { DriftSeverity, ObservationId, PrincipalRef, ContextItemId } from './primitives.js';
import type { EventEnvelope, DomainEvent } from './events.js';

// --- Observation ingestion ---

export type ObservationKind =
  | 'schema-violation'
  | 'undocumented-status'
  | 'enum-violation'
  | 'nullability-violation'
  | 'missing-field'
  | 'undocumented-field'
  | 'slo-violation'
  | 'idempotency-anomaly'
  | 'undocumented-operation'
  | 'revision-mismatch';

export type RedactionPolicy = {
  // Removed anywhere in the tree, case-insensitively (PII/secrets).
  readonly deniedFields: ReadonlyArray<string>;
  // Leaf values on these fields keep their literal value (contract-relevant
  // values such as the observed enum member); everything else is hashed.
  readonly literalFields: ReadonlyArray<string>;
};

const DENIED_DEFAULTS: ReadonlyArray<string> = ['authorization', 'password', 'token', 'secret', 'email', 'ssn', 'creditcard'];

export function redactDetail(detail: Readonly<Record<string, unknown>>, policy: RedactionPolicy): Record<string, unknown> {
  const denied = new Set([...policy.deniedFields, ...DENIED_DEFAULTS].map((field) => field.toLowerCase()));
  const literal = new Set(policy.literalFields.map((field) => field.toLowerCase()));
  return redactNode(detail, denied, literal) as Record<string, unknown>;
}

function redactNode(node: unknown, denied: Set<string>, literal: Set<string>): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => redactNode(entry, denied, literal));
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (denied.has(key.toLowerCase())) {
      continue;
    }
    if (isLeaf(value) && !literal.has(key.toLowerCase())) {
      output[key] = { hash: hashValue(value) };
      continue;
    }
    output[key] = redactNode(value, denied, literal);
  }
  return output;
}

function isLeaf(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export function detailFingerprint(detail: unknown): string {
  return hashValue(JSON.stringify(detail));
}

function hashValue(value: unknown): string {
  let hash = 0;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return `h${hash.toString(16).padStart(8, '0')}`;
}

// Fingerprint: the dedup key that folds repeated violations of the same rule on
// the same operation/environment into one incident (issue #17).
export function fingerprintOf(kind: ObservationKind, operationId: string, environment: string, detailKey: string): string {
  return [kind, operationId, environment, detailKey].join('|');
}

export interface RuntimeObservation {
  readonly observationId: ObservationId;
  readonly operationId: string;
  readonly environment: string;
  readonly contractVersionId: string;
  readonly deploymentRevision: string;
  readonly collectorVersion: string;
  readonly kind: ObservationKind;
  readonly severity: DriftSeverity;
  readonly fingerprint: string;
  readonly redactedDetail: Readonly<Record<string, unknown>>;
  readonly sampleSize: number;
  readonly at: Date;
}

export const DEFAULT_MINIMUM_SAMPLE_SIZE = 100;
export const DEFAULT_MINIMUM_WINDOW_DAYS = 7;

export function hasSufficientObservationWindow(input: { readonly firstObservedAt: Date; readonly now: Date; readonly minimumWindowDays: number; readonly sampleSize: number; readonly minimumSampleSize: number }): { readonly satisfied: boolean; readonly reason: string } {
  const days = (input.now.getTime() - input.firstObservedAt.getTime()) / 86_400_000;
  if (input.sampleSize < input.minimumSampleSize) {
    return { satisfied: false, reason: `INV-025: insufficient evidence (${String(input.sampleSize)}/${String(input.minimumSampleSize)} samples)` };
  }
  if (days < input.minimumWindowDays) {
    return { satisfied: false, reason: `INV-025: observation window ${Math.floor(days)}d is below the ${String(input.minimumWindowDays)}d minimum` };
  }
  return { satisfied: true, reason: 'observation window and sample size satisfied' };
}

// --- Drift incidents (derived from the observation ledger) ---

export type DriftStatus = 'open' | 'false-positive' | 'accepted-deviation' | 'fixed' | 'expired';

export interface DriftIncident {
  readonly incidentId: string;
  readonly fingerprint: string;
  readonly kind: ObservationKind;
  readonly severity: DriftSeverity;
  readonly environment: string;
  readonly operationId: string;
  readonly contractVersionId: string;
  readonly deploymentRevision: string;
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
  readonly occurrences: number;
  readonly sampleSize: number;
  readonly status: DriftStatus;
  readonly resolutionReason?: string | undefined;
  readonly resolvedBy?: PrincipalRef | undefined;
  readonly promotedContextItemId?: ContextItemId | undefined;
  readonly collectorVersion: string;
}

// Aggregates ingested observations into incidents. The same violation folds
// into one incident (dedup); a violation recurring after the incident was
// resolved starts a NEW generation of the incident so recurrence is tracked
// instead of being buried in a closed report.
export function driftIncidentsFrom(events: ReadonlyArray<EventEnvelope<DomainEvent>>): ReadonlyArray<DriftIncident> {
  interface Working {
    readonly fingerprint: string;
    readonly kind: ObservationKind;
    readonly severity: DriftSeverity;
    readonly environment: string;
    readonly operationId: string;
    readonly contractVersionId: string;
    readonly deploymentRevision: string;
    readonly collectorVersion: string;
    firstObservedAt: Date;
    lastObservedAt: Date;
    occurrences: number;
    sampleSize: number;
    status: DriftStatus;
    resolutionReason?: string | undefined;
    resolvedBy?: PrincipalRef | undefined;
    promotedContextItemId?: ContextItemId | undefined;
  }

  const generations = new Map<string, number>();
  const working = new Map<string, Working>();

  const observationStream = events
    .filter((envelope) => envelope.event.type === 'RuntimeObservationRecorded' || envelope.event.type === 'DriftIncidentResolved' || envelope.event.type === 'DriftPromotedToCandidate')
    .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.version - right.version);

  for (const envelope of observationStream) {
    const event = envelope.event;
    if (event.type === 'RuntimeObservationRecorded') {
      const base = `${event.kind}|${event.operationId}|${event.environment}|${event.fingerprint}`;
      const generation = generations.get(base) ?? 1;
      const incidentId = `${base}#${String(generation)}`;
      const existing = working.get(incidentId);
      if (existing === undefined) {
        working.set(incidentId, {
          fingerprint: event.fingerprint,
          kind: event.kind,
          severity: event.severity,
          environment: event.environment,
          operationId: event.operationId,
          contractVersionId: event.contractVersionId,
          deploymentRevision: event.deploymentRevision,
          collectorVersion: event.collectorVersion,
          firstObservedAt: event.at,
          lastObservedAt: event.at,
          occurrences: 1,
          sampleSize: event.sampleSize,
          status: 'open'
        });
      } else {
        existing.lastObservedAt = event.at;
        existing.occurrences += 1;
        existing.sampleSize += event.sampleSize;
      }
      continue;
    }
    if (event.type === 'DriftIncidentResolved') {
      const incidentId = `${event.incidentId}`;
      const target = working.get(incidentId);
      if (target !== undefined) {
        target.status = event.resolution;
        target.resolutionReason = event.reason;
        target.resolvedBy = event.resolvedBy;
        // Recurrence after a resolution starts a new generation (issue #17).
        const base = incidentId.split('#').slice(0, -1).join('#');
        generations.set(base, (generations.get(base) ?? 1) + 1);
      }
      continue;
    }
    if (event.type === 'DriftPromotedToCandidate') {
      const target = working.get(event.incidentId);
      if (target !== undefined) {
        target.promotedContextItemId = event.contextItemId;
      }
    }
  }

  return [...working.entries()]
    .map(([incidentId, state]) => ({
      incidentId,
      fingerprint: state.fingerprint,
      kind: state.kind,
      severity: state.severity,
      environment: state.environment,
      operationId: state.operationId,
      contractVersionId: state.contractVersionId,
      deploymentRevision: state.deploymentRevision,
      firstObservedAt: state.firstObservedAt,
      lastObservedAt: state.lastObservedAt,
      occurrences: state.occurrences,
      sampleSize: state.sampleSize,
      status: state.status,
      resolutionReason: state.resolutionReason,
      resolvedBy: state.resolvedBy,
      promotedContextItemId: state.promotedContextItemId,
      collectorVersion: state.collectorVersion
    }))
    .sort((left, right) => left.incidentId.localeCompare(right.incidentId));
}

// --- Guards ---

export function canResolveDriftIncident(input: { readonly resolution: Exclude<DriftStatus, 'open'>; readonly reason: string }): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (input.reason.trim().length === 0) {
    return { ok: false, reason: 'issue #17: resolving a drift incident requires an explicit reason' };
  }
  return { ok: true };
}

export function canPromoteDriftIncident(input: { readonly incident: DriftIncident; readonly statement: string }): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (input.incident.status !== 'open') {
    return { ok: false, reason: 'issue #17: only an open drift incident can be promoted for review' };
  }
  if (input.statement.trim().length === 0) {
    return { ok: false, reason: 'issue #17: promotion requires a candidate statement derived from the incident' };
  }
  return { ok: true };
}
