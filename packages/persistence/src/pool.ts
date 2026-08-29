import pg, { type Pool } from 'pg';

import type { PostgresResources } from './types.js';

const { Pool: PoolConstructor } = pg;

export function createPostgresPool(databaseUrl: string, options?: { readonly max?: number; readonly applicationName?: string }): Pool {
  return new PoolConstructor({
    connectionString: databaseUrl,
    max: options?.max ?? 5,
    application_name: options?.applicationName ?? 'api-accord'
  });
}

export function createPostgresResources(databaseUrl: string, options?: { readonly max?: number; readonly applicationName?: string }): PostgresResources {
  const pool = createPostgresPool(databaseUrl, options);
  return {
    pool,
    readinessProbe: {
      name: 'postgres',
      check: async () => {
        await pool.query('SELECT 1');
      }
    }
  };
}