// Identity, RBAC, and MCP credential domain logic (issue #4).
//
// Framework-independent: depends only on the EventStore port, projections, and
// node:crypto (a built-in, not a DB/HTTP/GitHub SDK). Credential secrets are
// hashed with a per-credential salt and the plaintext is returned exactly once
// at issuance; it is never stored or logged (INV-031). An agent can never act
// as a human because every event carries the real PrincipalRef (INV-028), and
// approval vs implementation scopes are independently grantable (INV-027).

// Uses the Web Crypto API (available globally in Node 22 via lib.dom typings) to
// avoid node:crypto ambient typing friction. Salted SHA-256; the plaintext secret
// is never stored (INV-031). Swap the digest for scrypt/argon2 via this seam later.
const subtle = globalThis.crypto.subtle;
function randomSalt(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}

import type {
  AggregateType,
  AppendResult,
  EventStore
} from './events.js';
import type {
  CredentialId,
  OrganizationId,
  PrincipalId,
  PrincipalKind,
  PrincipalRef,
  Scope
} from './primitives.js';

// --- Secret hashing (never persists plaintext) ---

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomSalt();
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${secret}`));
  return `${salt}:${toHex(new Uint8Array(digest))}`;
}

export async function verifySecret(stored: string, secret: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (salt === undefined || hash === undefined) {
    return false;
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${secret}`));
  return toHex(new Uint8Array(digest)) === hash;
}

// --- RBAC ---

// Minimum-privilege check: does a principal holding `granted` scopes have `required`?
export function hasScope(granted: ReadonlyArray<Scope>, required: Scope): boolean {
  return granted.includes(required);
}

// --- Identity service: orchestrates guards + events through the EventStore ---

export class IdentityService {
  readonly #store: EventStore;
  readonly #defaultCorrelationId: string;

  constructor(store: EventStore, options: { defaultCorrelationId?: string } = {}) {
    this.#store = store;
    this.#defaultCorrelationId = options.defaultCorrelationId ?? 'identity-service';
  }

  async registerPrincipal(input: {
    actor: PrincipalRef;
    correlationId?: string;
    principalId: PrincipalId;
    kind: PrincipalKind;
    organizationId: OrganizationId;
    name: string;
    status?: 'active' | 'inactive';
  }): Promise<AppendResult> {
    return this.#append('principal', input.principalId, input.actor, input.correlationId, {
      type: 'PrincipalRegistered',
      principalId: input.principalId,
      kind: input.kind,
      organizationId: input.organizationId,
      name: input.name,
      createdBy: input.actor,
      status: input.status ?? 'active'
    });
  }

  async deactivatePrincipal(input: {
    actor: PrincipalRef;
    correlationId?: string;
    principalId: PrincipalId;
    reason: string;
  }): Promise<AppendResult> {
    return this.#append('principal', input.principalId, input.actor, input.correlationId, {
      type: 'PrincipalDeactivated',
      principalId: input.principalId,
      reason: input.reason
    });
  }

  // Returns the plaintext secret exactly once. The event stores only the hash.
  async issueCredential(input: {
    actor: PrincipalRef;
    correlationId?: string;
    credentialId: CredentialId;
    principalId: PrincipalId;
    name: string;
    scopes: ReadonlyArray<Scope>;
    secret: string;
    expiresAt?: Date;
  }): Promise<{ result: AppendResult; plaintext: string }> {
    const secretHash = await hashSecret(input.secret);
    const result = await this.#append('credential', input.credentialId, input.actor, input.correlationId, {
      type: 'CredentialIssued',
      credentialId: input.credentialId,
      principalId: input.principalId,
      name: input.name,
      scopes: input.scopes,
      expiresAt: input.expiresAt ?? undefined,
      issuedBy: input.actor,
      secretHash
    });
    return { result, plaintext: input.secret };
  }

  async revokeCredential(input: {
    actor: PrincipalRef;
    correlationId?: string;
    credentialId: CredentialId;
    reason: string;
  }): Promise<AppendResult> {
    return this.#append('credential', input.credentialId, input.actor, input.correlationId, {
      type: 'CredentialRevoked',
      credentialId: input.credentialId,
      revokedBy: input.actor,
      reason: input.reason
    });
  }

  // Returns the new plaintext secret exactly once; the event stores only the new hash.
  async rotateCredential(input: {
    actor: PrincipalRef;
    correlationId?: string;
    credentialId: CredentialId;
    newSecret: string;
    supersededCredentialId?: CredentialId;
  }): Promise<{ result: AppendResult; plaintext: string }> {
    const secretHash = await hashSecret(input.newSecret);
    const result = await this.#append('credential', input.credentialId, input.actor, input.correlationId, {
      type: 'CredentialRotated',
      credentialId: input.credentialId,
      rotatedBy: input.actor,
      secretHash,
      supersededCredentialId: input.supersededCredentialId
    });
    return { result, plaintext: input.newSecret };
  }

  async grantScope(input: {
    actor: PrincipalRef;
    correlationId?: string;
    principalId: PrincipalId;
    scope: Scope;
  }): Promise<AppendResult> {
    return this.#append('principal', input.principalId, input.actor, input.correlationId, {
      type: 'ScopeGranted',
      principalId: input.principalId,
      scope: input.scope,
      grantedBy: input.actor
    });
  }

  async revokeScope(input: {
    actor: PrincipalRef;
    correlationId?: string;
    principalId: PrincipalId;
    scope: Scope;
  }): Promise<AppendResult> {
    return this.#append('principal', input.principalId, input.actor, input.correlationId, {
      type: 'ScopeRevoked',
      principalId: input.principalId,
      scope: input.scope,
      revokedBy: input.actor
    });
  }

  async #append(
    aggregateType: AggregateType,
    aggregateId: string,
    actor: PrincipalRef,
    correlationId: string | undefined,
    event: Parameters<EventStore['append']>[0]['event']
  ): Promise<AppendResult> {
    const expectedVersion = await this.#currentVersion(aggregateType, aggregateId);
    return this.#store.append({
      actor,
      correlationId: correlationId ?? this.#defaultCorrelationId,
      event,
      expectedVersion
    });
  }

  async #currentVersion(aggregateType: AggregateType, aggregateId: string): Promise<number> {
    const stream = await this.#store.getStream(aggregateType, aggregateId);
    const last = stream[stream.length - 1];
    return last?.version ?? 0;
  }

  // Expose store events for authentication purposes
  async getAllEvents(): Promise<readonly unknown[]> {
    return this.#store.getAll();
  }
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}