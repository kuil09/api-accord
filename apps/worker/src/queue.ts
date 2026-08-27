import pg, { type Pool, type PoolClient } from 'pg';

const { Pool: PoolConstructor } = pg;

export interface QueuedJob {
  readonly id: string;
  readonly jobType: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface JobQueue {
  ping(): Promise<void>;
  claim(): Promise<QueuedJob | undefined>;
  complete(jobId: string): Promise<void>;
  fail(jobId: string, reason: string): Promise<void>;
  close(): Promise<void>;
}

interface JobRow {
  readonly id: string;
  readonly job_type: string;
  readonly payload: unknown;
  readonly attempts: number;
  readonly max_attempts: number;
}

export class PostgresJobQueue implements JobQueue {
  readonly #pool: Pool;
  readonly #workerId: string;

  constructor(databaseUrl: string, workerId: string) {
    this.#pool = new PoolConstructor({
      connectionString: databaseUrl,
      max: 4,
      application_name: 'api-accord-worker'
    });
    this.#workerId = workerId;
  }

  async ping(): Promise<void> {
    await this.#pool.query('SELECT 1');
  }

  async claim(): Promise<QueuedJob | undefined> {
    const client = await this.#pool.connect();

    try {
      await client.query('BEGIN');
      const result = await client.query<JobRow>(
        `SELECT id::text, job_type, payload, attempts, max_attempts
           FROM job_queue
          WHERE status = 'pending'
            AND available_at <= NOW()
            AND attempts < max_attempts
          ORDER BY priority DESC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1`
      );
      const row = result.rows[0];

      if (row === undefined) {
        await client.query('COMMIT');
        return undefined;
      }

      await client.query(
        `UPDATE job_queue
            SET status = 'processing',
                locked_at = NOW(),
                locked_by = $2,
                attempts = attempts + 1,
                updated_at = NOW()
          WHERE id = $1`,
        [row.id, this.#workerId]
      );
      await client.query('COMMIT');

      return {
        id: row.id,
        jobType: row.job_type,
        payload: row.payload,
        attempts: row.attempts + 1,
        maxAttempts: row.max_attempts
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async complete(jobId: string): Promise<void> {
    await this.#pool.query(
      `UPDATE job_queue
          SET status = 'completed',
              completed_at = NOW(),
              locked_at = NULL,
              locked_by = NULL,
              last_error = NULL,
              updated_at = NOW()
        WHERE id = $1
          AND locked_by = $2`,
      [jobId, this.#workerId]
    );
  }

  async fail(jobId: string, reason: string): Promise<void> {
    await this.#pool.query(
      `UPDATE job_queue
          SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
              available_at = CASE
                WHEN attempts >= max_attempts THEN available_at
                ELSE NOW() + INTERVAL '5 seconds'
              END,
              locked_at = NULL,
              locked_by = NULL,
              last_error = LEFT($3, 2000),
              updated_at = NOW()
        WHERE id = $1
          AND locked_by = $2`,
      [jobId, this.#workerId, reason]
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original error.
  }
}
