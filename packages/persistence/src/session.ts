// Session management for authentication (issue #53).
// Provides in-memory and PostgreSQL-backed session stores.

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PrincipalKind } from '@api-accord/domain';

export interface SessionData {
  readonly sessionId: string;
  readonly principalId: string;
  readonly principalKind: PrincipalKind;
  readonly organizationId: string;
  readonly scopes: ReadonlyArray<string>;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastAccessedAt: Date;
}

export interface SessionStore {
  create(data: Omit<SessionData, 'sessionId' | 'createdAt' | 'expiresAt' | 'lastAccessedAt'>, ttlMs: number): Promise<SessionData>;
  get(sessionId: string): Promise<SessionData | undefined>;
  delete(sessionId: string): Promise<boolean>;
  touch(sessionId: string, ttlMs: number): Promise<boolean>;
  cleanup(): Promise<number>;
}

// In-memory session store for development/testing
export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, SessionData>();
  readonly #defaultTtlMs: number;

  constructor(defaultTtlMs = 24 * 60 * 60 * 1000) { // 24 hours default
    this.#defaultTtlMs = defaultTtlMs;
  }

  async create(data: Omit<SessionData, 'sessionId' | 'createdAt' | 'expiresAt' | 'lastAccessedAt'>, ttlMs?: number): Promise<SessionData> {
    const sessionId = randomUUID();
    const now = new Date();
    const ttl = ttlMs ?? this.#defaultTtlMs;
    const session: SessionData = {
      sessionId,
      ...data,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttl),
      lastAccessedAt: now
    };
    this.#sessions.set(sessionId, session);
    return session;
  }

  async get(sessionId: string): Promise<SessionData | undefined> {
    const session = this.#sessions.get(sessionId);
    if (!session) return undefined;
    if (session.expiresAt < new Date()) {
      this.#sessions.delete(sessionId);
      return undefined;
    }
    return session;
  }

  async delete(sessionId: string): Promise<boolean> {
    return this.#sessions.delete(sessionId);
  }

  async touch(sessionId: string, ttlMs?: number): Promise<boolean> {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    if (session.expiresAt < new Date()) {
      this.#sessions.delete(sessionId);
      return false;
    }
    const ttl = ttlMs ?? this.#defaultTtlMs;
    // Create a new session with updated expiry (since SessionData is readonly)
    const updated: SessionData = {
      ...session,
      expiresAt: new Date(Date.now() + ttl),
      lastAccessedAt: new Date()
    };
    this.#sessions.set(sessionId, updated);
    return true;
  }

  async cleanup(): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const [id, session] of this.#sessions.entries()) {
      if (session.expiresAt < now) {
        this.#sessions.delete(id);
        count++;
      }
    }
    return count;
  }
}

// PostgreSQL-backed session store
interface SessionRow {
  session_id: string;
  principal_id: string;
  principal_kind: string;
  organization_id: string;
  scopes: string;
  created_at: Date;
  expires_at: Date;
  last_accessed_at: Date;
}

export class PostgresSessionStore implements SessionStore {
  readonly #pool: Pool;
  readonly #defaultTtlMs: number;

  constructor(pool: Pool, defaultTtlMs = 24 * 60 * 60 * 1000) {
    this.#pool = pool;
    this.#defaultTtlMs = defaultTtlMs;
  }

  async create(data: Omit<SessionData, 'sessionId' | 'createdAt' | 'expiresAt' | 'lastAccessedAt'>, ttlMs?: number): Promise<SessionData> {
    const sessionId = randomUUID();
    const now = new Date();
    const ttl = ttlMs ?? this.#defaultTtlMs;
    const expiresAt = new Date(now.getTime() + ttl);

    await this.#pool.query(
      `INSERT INTO auth_session (session_id, principal_id, principal_kind, organization_id, scopes, created_at, expires_at, last_accessed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        sessionId,
        data.principalId,
        data.principalKind,
        data.organizationId,
        JSON.stringify(data.scopes),
        now,
        expiresAt,
        now
      ]
    );

    return {
      sessionId,
      ...data,
      createdAt: now,
      expiresAt,
      lastAccessedAt: now
    };
  }

  async get(sessionId: string): Promise<SessionData | undefined> {
    const result = await this.#pool.query<SessionRow>(
      `SELECT session_id, principal_id, principal_kind, organization_id, scopes, created_at, expires_at, last_accessed_at
       FROM auth_session
       WHERE session_id = $1 AND expires_at > NOW()`,
      [sessionId]
    );

    if (result.rows.length === 0) return undefined;

    const row = result.rows[0];
    if (!row) return undefined;

    return {
      sessionId: row.session_id,
      principalId: row.principal_id,
      principalKind: row.principal_kind as 'human' | 'agent' | 'service' | 'ci' | 'integration',
      organizationId: row.organization_id,
      scopes: JSON.parse(row.scopes),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastAccessedAt: row.last_accessed_at
    };
  }

  async delete(sessionId: string): Promise<boolean> {
    const result = await this.#pool.query(
      `DELETE FROM auth_session WHERE session_id = $1`,
      [sessionId]
    );
    return ((result as unknown as { rowCount: number | null }).rowCount ?? 0) > 0;
  }

  async touch(sessionId: string, ttlMs?: number): Promise<boolean> {
    const ttl = ttlMs ?? this.#defaultTtlMs;
    const expiresAt = new Date(Date.now() + ttl);
    const result = await this.#pool.query(
      `UPDATE auth_session
       SET expires_at = $2, last_accessed_at = NOW()
       WHERE session_id = $1 AND expires_at > NOW()`,
      [sessionId, expiresAt]
    );
    return ((result as unknown as { rowCount: number | null }).rowCount ?? 0) > 0;
  }

  async cleanup(): Promise<number> {
    const result = await this.#pool.query(
      `DELETE FROM auth_session WHERE expires_at < NOW()`
    );
    return (result as unknown as { rowCount: number | null }).rowCount ?? 0;
  }
}

// Factory function
export function createSessionStore(options: {
  type: 'memory' | 'postgres';
  pool?: Pool;
  defaultTtlMs?: number;
}): SessionStore {
  if (options.type === 'memory') {
    return new InMemorySessionStore(options.defaultTtlMs);
  }
  if (options.type === 'postgres') {
    if (!options.pool) throw new Error('PostgreSQL pool required for postgres session store');
    return new PostgresSessionStore(options.pool, options.defaultTtlMs);
  }
  throw new Error(`Unknown session store type: ${options.type}`);
}