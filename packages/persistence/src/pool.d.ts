import { type Pool } from 'pg';
import type { PostgresResources } from './types.js';
export declare function createPostgresPool(databaseUrl: string, options?: {
    readonly max?: number;
    readonly applicationName?: string;
}): Pool;
export declare function createPostgresResources(databaseUrl: string, options?: {
    readonly max?: number;
    readonly applicationName?: string;
}): PostgresResources;
//# sourceMappingURL=pool.d.ts.map