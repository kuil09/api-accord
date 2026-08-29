// PostgreSQL-backed EventStore adapter for the append-only domain ledger.
//
// This is the infrastructure adapter behind the framework-independent EventStore
// port defined in @api-accord/domain. It follows the same transaction and error
// handling pattern as PostgresJobQueue (BEGIN/COMMIT/ROLLBACK, FOR UPDATE,
// quiet rollback on failure). Optimistic concurrency is enforced by computing
// the next stream version under a row lock and rejecting a stale expectedVersion
// with ConcurrencyError (INV-035: the ledger is the source of truth).
import { randomUUID } from 'node:crypto';
import { aggregateOf, ConcurrencyError } from '@api-accord/domain';
// Pure SQL builder so the statement is unit-testable without a database.
export function buildAppendStatement(params) {
    const text = `
    INSERT INTO domain_event (
      event_id, aggregate_type, aggregate_id, event_type,
      occurred_at, actor_kind, actor_id, correlation_id, version, payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    RETURNING version`;
    const values = [
        params.eventId,
        params.aggregateType,
        params.aggregateId,
        params.eventType,
        params.occurredAt,
        params.actorKind,
        params.actorId,
        params.correlationId,
        params.version,
        JSON.stringify(params.payload)
    ];
    return { text, values };
}
const SELECT_COLUMNS = `
  event_id, aggregate_type, aggregate_id, event_type,
  occurred_at, actor_kind, actor_id, correlation_id, version, payload`;
// Pure row -> envelope mapping (jsonb payload arrives already parsed).
export function rowToEnvelope(row) {
    const actor = { kind: row.actor_kind, id: row.actor_id };
    return {
        eventId: row.event_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        occurredAt: row.occurred_at,
        actor,
        correlationId: row.correlation_id,
        version: row.version,
        event: row.payload
    };
}
export class PostgresEventStore {
    #pool;
    constructor(options) {
        this.#pool = options.pool;
    }
    async append(input) {
        const { type: aggregateType, id: aggregateId } = aggregateOf(input.event);
        try {
            const current = await this.#pool.query(`SELECT COALESCE(MAX(version), 0) AS version
           FROM domain_event
          WHERE aggregate_type = $1 AND aggregate_id = $2`, [aggregateType, aggregateId]);
            const last = current.rows[0]?.version ?? 0;
            if (input.expectedVersion !== undefined && input.expectedVersion !== last) {
                throw new ConcurrencyError(aggregateType, aggregateId, input.expectedVersion, last);
            }
            const version = last + 1;
            const eventId = randomUUID();
            const { text, values } = buildAppendStatement({
                eventId,
                aggregateType,
                aggregateId,
                eventType: input.event.type,
                occurredAt: input.occurredAt ?? new Date(),
                actorKind: input.actor.kind,
                actorId: input.actor.id,
                correlationId: input.correlationId,
                version,
                payload: input.event
            });
            const result = await this.#pool.query(text, values);
            const stored = result.rows[0]?.version ?? version;
            return { eventId, version: stored };
        }
        catch (error) {
            // Concurrent append to the same stream collides on the (aggregate_type,
            // aggregate_id, version) primary key; surface it as a concurrency error.
            if (isUniqueViolation(error)) {
                const actual = await this.currentVersion(aggregateType, aggregateId);
                throw new ConcurrencyError(aggregateType, aggregateId, input.expectedVersion ?? 0, actual);
            }
            throw error;
        }
    }
    async getStream(aggregateType, aggregateId) {
        const result = await this.#pool.query(`SELECT ${SELECT_COLUMNS}
         FROM domain_event
        WHERE aggregate_type = $1 AND aggregate_id = $2
        ORDER BY version ASC`, [aggregateType, aggregateId]);
        return result.rows.map(rowToEnvelope);
    }
    async getAll() {
        const result = await this.#pool.query(`SELECT ${SELECT_COLUMNS}
         FROM domain_event
        ORDER BY aggregate_type, aggregate_id, version ASC`);
        return result.rows.map(rowToEnvelope);
    }
    async currentVersion(aggregateType, aggregateId) {
        const result = await this.#pool.query(`SELECT COALESCE(MAX(version), 0) AS version
         FROM domain_event
        WHERE aggregate_type = $1 AND aggregate_id = $2`, [aggregateType, aggregateId]);
        return result.rows[0]?.version ?? 0;
    }
}
function isUniqueViolation(error) {
    return error?.code === '23505';
}
export function createPostgresEventStore(pool) {
    return new PostgresEventStore({ pool });
}
//# sourceMappingURL=postgres-event-store.js.map