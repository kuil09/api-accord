import pg, { type Pool } from 'pg';

const { Pool: PoolConstructor } = pg;

import type { ReadinessProbe } from './app.js';

export interface PostgresResources {
  readonly pool: Pool;
  readonly readinessProbe: ReadinessProbe;
}

export function createPostgresResources(databaseUrl: string): PostgresResources {
  const pool = new PoolConstructor({
    connectionString: databaseUrl,
    max: 5,
    application_name: 'api-accord-api'
  });

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
