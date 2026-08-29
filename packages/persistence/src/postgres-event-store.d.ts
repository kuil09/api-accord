import type { Pool } from 'pg';
import type { AggregateType, AppendInput, AppendResult, EventEnvelope, EventStore } from '@api-accord/domain';
interface AppendParams {
    readonly eventId: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly eventType: string;
    readonly occurredAt: Date;
    readonly actorKind: string;
    readonly actorId: string;
    readonly correlationId: string;
    readonly version: number;
    readonly payload: unknown;
}
export declare function buildAppendStatement(params: AppendParams): {
    text: string;
    values: readonly unknown[];
};
interface DomainEventRow {
    event_id: string;
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    occurred_at: Date;
    actor_kind: string;
    actor_id: string;
    correlation_id: string;
    version: number;
    payload: unknown;
}
export declare function rowToEnvelope(row: DomainEventRow): EventEnvelope;
export interface PostgresEventStoreOptions {
    readonly pool: Pool;
}
export declare class PostgresEventStore implements EventStore {
    #private;
    constructor(options: PostgresEventStoreOptions);
    append(input: AppendInput): Promise<AppendResult>;
    getStream(aggregateType: AggregateType, aggregateId: string): Promise<ReadonlyArray<EventEnvelope>>;
    getAll(): Promise<ReadonlyArray<EventEnvelope>>;
    currentVersion(aggregateType: string, aggregateId: string): Promise<number>;
}
export declare function createPostgresEventStore(pool: Pool): PostgresEventStore;
export {};
//# sourceMappingURL=postgres-event-store.d.ts.map