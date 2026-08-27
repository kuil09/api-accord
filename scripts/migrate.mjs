import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import pg from 'pg';

import { validateMigrations } from './validate-migrations.mjs';

const { Pool } = pg;
const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  throw new Error('Usage: node scripts/migrate.mjs <up|down>');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error('DATABASE_URL is required');
}

const migrationsDirectory = resolve('migrations');
const migrations = await validateMigrations(migrationsDirectory);
const pool = new Pool({
  connectionString: databaseUrl,
  max: 1,
  application_name: 'api-accord-migrations'
});
const client = await pool.connect();

try {
  await client.query('SELECT pg_advisory_lock(841220001)');
  await ensureMigrationTable(client);

  if (direction === 'up') {
    const applied = await appliedMigrationIds(client);
    for (const migration of migrations) {
      if (!applied.has(migration.id)) {
        await applyMigration(client, migration, migrationsDirectory);
      }
    }
  } else {
    await rollbackLatest(client, migrations, migrationsDirectory);
  }
} finally {
  await client.query('SELECT pg_advisory_unlock(841220001)').catch(() => undefined);
  client.release();
  await pool.end();
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function appliedMigrationIds(client) {
  const result = await client.query('SELECT id FROM schema_migrations ORDER BY id');
  return new Set(result.rows.map((row) => row.id));
}

async function applyMigration(client, migration, directory) {
  const sql = await readFile(resolve(directory, migration.up), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [migration.id, migration.name]);
    await client.query('COMMIT');
    process.stdout.write(`Applied ${String(migration.id).padStart(4, '0')}_${migration.name}.\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function rollbackLatest(client, migrations, directory) {
  const latest = await client.query('SELECT id, name FROM schema_migrations ORDER BY id DESC LIMIT 1');
  const row = latest.rows[0];
  if (!row) {
    process.stdout.write('No applied migration to roll back.\n');
    return;
  }

  const migration = migrations.find((candidate) => candidate.id === row.id && candidate.name === row.name);
  if (!migration?.down) {
    throw new Error(`Missing down migration for ${String(row.id).padStart(4, '0')}_${row.name}`);
  }

  const sql = await readFile(resolve(directory, migration.down), 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('DELETE FROM schema_migrations WHERE id = $1', [row.id]);
    await client.query('COMMIT');
    process.stdout.write(`Rolled back ${String(row.id).padStart(4, '0')}_${row.name}.\n`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
