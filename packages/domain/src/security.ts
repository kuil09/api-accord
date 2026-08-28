// Security hardening (issue #21): organization boundary enforcement, audit
// search/export, ledger integrity verification, sensitive-content
// classification, credential revocation semantics, rate limiting, webhook
// replay defense, and retention policy. Pure and deterministic.
//
// INV-029: every interface enforces the same organization boundary. INV-030:
// audit records come from the append-only ledger. INV-031: secrets/PII never
// reach logs, AI input or storage.

import type { DomainEvent, EventEnvelope } from './events.js';

// --- Organization boundary (INV-029) ---

export function enforceOrganizationBoundary(input: {
  readonly callerOrganizationId: string;
  readonly resourceOrganizationId: string;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (input.callerOrganizationId.trim().length === 0 || input.resourceOrganizationId.trim().length === 0) {
    return { ok: false, reason: 'INV-029: both caller and resource organization must be resolved before access' };
  }
  if (input.callerOrganizationId !== input.resourceOrganizationId) {
    return { ok: false, reason: 'INV-029: cross-organization access is denied; guessing object ids across organizations exposes no data' };
  }
  return { ok: true };
}

// --- Audit search and export (INV-030) ---

export interface AuditFilter {
  readonly actorId?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly eventType?: string | undefined;
  readonly since?: Date | undefined;
  readonly until?: Date | undefined;
}

export interface AuditRecord {
  readonly at: Date;
  readonly actorKind: string;
  readonly actorId: string;
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly version: number;
}

// Deterministic, sorted audit search over the append-only ledger. Every
// mutation is attributable (INV-026); before/after values are recoverable by
// replaying the returned records through the projections.
export function auditEventsFrom(events: ReadonlyArray<EventEnvelope<DomainEvent>>, filter: AuditFilter = {}): ReadonlyArray<AuditRecord> {
  const records = events
    .filter((envelope) => {
      const event = envelope.event;
      if (filter.actorId !== undefined && envelope.actor.id !== filter.actorId) return false;
      if (filter.correlationId !== undefined && envelope.correlationId !== filter.correlationId) return false;
      if (filter.eventType !== undefined && event.type !== filter.eventType) return false;
      if (filter.since !== undefined && envelope.occurredAt.getTime() < filter.since.getTime()) return false;
      if (filter.until !== undefined && envelope.occurredAt.getTime() > filter.until.getTime()) return false;
      void event;
      return true;
    })
    .map((envelope) => ({
      at: envelope.occurredAt,
      actorKind: envelope.actor.kind,
      actorId: envelope.actor.id,
      eventType: envelope.event.type,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      correlationId: envelope.correlationId,
      version: envelope.version
    }))
    .sort((left, right) => left.at.getTime() - right.at.getTime() || left.version - right.version);
  return records;
}

// Deterministic export (one JSON object per line) for audit delivery.
export function exportAuditRecords(records: ReadonlyArray<AuditRecord>): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

// --- Ledger integrity (backup/restore verification) ---

export interface IntegrityCheck {
  readonly intact: boolean;
  readonly violations: ReadonlyArray<string>;
}

// A restored ledger is intact when every aggregate stream has contiguous
// versions starting at 1 and no duplicate event ids. A missing or reordered
// event in a backup shows up as a version gap (issue #21 backup verification).
export function verifyLedgerIntegrity(events: ReadonlyArray<EventEnvelope<DomainEvent>>): IntegrityCheck {
  const violations: string[] = [];
  const versions = new Map<string, number[]>();
  const eventIds = new Set<string>();

  for (const envelope of events) {
    if (eventIds.has(envelope.eventId)) {
      violations.push(`duplicate event id '${envelope.eventId}'`);
    }
    eventIds.add(envelope.eventId);
    const key = `${envelope.aggregateType}:${envelope.aggregateId}`;
    const list = versions.get(key) ?? [];
    list.push(envelope.version);
    versions.set(key, list);
  }

  for (const [key, list] of versions) {
    const sorted = [...list].sort((left, right) => left - right);
    for (let index = 0; index < sorted.length; index += 1) {
      const expected = index + 1;
      if (sorted[index] !== expected) {
        violations.push(`${key}: expected version ${String(expected)} but found ${String(sorted[index])}`);
        break;
      }
    }
  }

  return { intact: violations.length === 0, violations };
}

// --- Sensitive content classification (INV-031) ---

export type SensitivityClassification = 'public' | 'internal' | 'confidential' | 'secret';

export interface SensitiveScan {
  readonly classification: SensitivityClassification;
  readonly matches: ReadonlyArray<{ readonly kind: string; readonly preview: string }>;
}

const SENSITIVE_PATTERNS: ReadonlyArray<{ readonly kind: string; readonly pattern: RegExp; readonly classification: SensitivityClassification }> = [
  { kind: 'bearer-token', pattern: /Bearer\s+[A-Za-z0-9._-]+/u, classification: 'secret' },
  { kind: 'api-key', pattern: /sk-[A-Za-z0-9]{8,}/u, classification: 'secret' },
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u, classification: 'confidential' },
  { kind: 'password-field', pattern: /"password"\s*:/u, classification: 'secret' },
  { kind: 'credit-card', pattern: /\b\d{13,16}\b/u, classification: 'secret' }
];

export function classifySensitiveContent(text: string): SensitiveScan {
  const matches: Array<{ kind: string; preview: string }> = [];
  let classification: SensitivityClassification = 'public';
  for (const rule of SENSITIVE_PATTERNS) {
    const found = text.match(rule.pattern);
    if (found !== null) {
      matches.push({ kind: rule.kind, preview: `${rule.kind} detected` });
      if (rule.classification === 'secret' || (rule.classification === 'confidential' && classification !== 'secret')) {
        classification = rule.classification;
      } else if (classification === 'public') {
        classification = 'internal';
      }
    }
  }
  return { classification, matches };
}

// AI input scope policy: secrets and confidential content never go to a model
// provider; internal items may go only when the policy allows.
export function allowedForAiInput(input: { readonly classification: SensitivityClassification; readonly providerAllowsInternal?: boolean }): boolean {
  if (input.classification === 'secret' || input.classification === 'confidential') {
    return false;
  }
  if (input.classification === 'internal') {
    return input.providerAllowsInternal === true;
  }
  return true;
}

// --- Credential revocation semantics (issue #21: Web API와 MCP에 즉시 반영) ---

export function isCredentialUsable(input: { readonly revokedAt?: Date | undefined; readonly expiresAt?: Date | undefined; readonly now: Date }): { readonly usable: boolean; readonly reason: string } {
  if (input.revokedAt !== undefined && input.revokedAt.getTime() <= input.now.getTime()) {
    return { usable: false, reason: 'credential has been revoked' };
  }
  if (input.expiresAt !== undefined && input.expiresAt.getTime() <= input.now.getTime()) {
    return { usable: false, reason: 'credential has expired' };
  }
  return { usable: true, reason: 'credential is active' };
}

// --- Rate limiting and webhook replay defense ---

export interface RateLimitCheck {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

export function checkRateLimit(input: { readonly requestTimes: ReadonlyArray<Date>; readonly windowMs: number; readonly maxRequests: number; readonly now: Date }): RateLimitCheck {
  const windowStart = input.now.getTime() - input.windowMs;
  const inWindow = input.requestTimes.filter((time) => time.getTime() > windowStart && time.getTime() <= input.now.getTime());
  if (inWindow.length >= input.maxRequests) {
    const oldest = inWindow.reduce((oldest, time) => (time.getTime() < oldest.getTime() ? time : oldest), inWindow[0] ?? input.now);
    const retryAfterMs = Math.max(0, oldest.getTime() + input.windowMs - input.now.getTime());
    return { allowed: false, retryAfterMs };
  }
  return { allowed: true, retryAfterMs: 0 };
}

export function isWebhookReplay(input: { readonly deliveryId: string; readonly seenDeliveryIds: ReadonlyArray<string>; readonly timestamp: Date; readonly now: Date; readonly maxAgeMs: number }): boolean {
  if (input.seenDeliveryIds.includes(input.deliveryId)) {
    return true;
  }
  return input.now.getTime() - input.timestamp.getTime() > input.maxAgeMs;
}

// --- Retention, expiry and legal hold ---

export interface RetentionPolicy {
  readonly retainDays: number;
  readonly legalHold: boolean;
}

export interface RetentionCheck {
  readonly expired: boolean;
  readonly deletable: boolean;
  readonly reason: string;
}

// Data past its retention period may be purged from read models and payloads,
// but the ledger keeps an erasure marker -- see ADR 0003. A legal hold blocks
// deletion regardless of expiry.
export function isWithinRetention(input: { readonly recordedAt: Date; readonly now: Date; readonly policy: RetentionPolicy }): RetentionCheck {
  const ageDays = (input.now.getTime() - input.recordedAt.getTime()) / 86_400_000;
  if (input.policy.legalHold) {
    return { expired: false, deletable: false, reason: 'legal hold: deletion is blocked while the hold is active' };
  }
  if (ageDays >= input.policy.retainDays) {
    return { expired: true, deletable: true, reason: `retention of ${String(input.policy.retainDays)} days reached` };
  }
  return { expired: false, deletable: false, reason: 'within retention period' };
}
