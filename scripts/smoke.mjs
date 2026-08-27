import { spawn } from 'node:child_process';

import pg from 'pg';

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for smoke tests');
}

const ports = { api: 4310, web: 4311, worker: 4312 };
const commonEnv = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  LOG_LEVEL: 'warn',
  API_PORT: String(ports.api),
  WEB_PORT: String(ports.web),
  WORKER_PORT: String(ports.worker),
  WORKER_ID: 'smoke-worker',
  WORKER_POLL_INTERVAL_MS: '100'
};
const processes = [
  start('api', 'apps/api/dist/index.js'),
  start('web', 'apps/web/dist/index.js'),
  start('worker', 'apps/worker/dist/index.js')
];
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  await Promise.all([
    waitForUrl(`http://127.0.0.1:${ports.api}/health`),
    waitForUrl(`http://127.0.0.1:${ports.api}/ready`),
    waitForUrl(`http://127.0.0.1:${ports.web}/health`),
    waitForUrl(`http://127.0.0.1:${ports.web}/ready`),
    waitForUrl(`http://127.0.0.1:${ports.worker}/health`),
    waitForUrl(`http://127.0.0.1:${ports.worker}/ready`)
  ]);

  const inserted = await pool.query(
    `INSERT INTO job_queue (job_type, payload)
     VALUES ('system.smoke', '{"source":"ci"}'::jsonb)
     RETURNING id::text`
  );
  const jobId = inserted.rows[0]?.id;
  if (!jobId) {
    throw new Error('Unable to insert smoke job');
  }

  await waitForJob(jobId);
  process.stdout.write('Smoke checks passed for web, API, worker, PostgreSQL, and the job queue.\n');
} finally {
  await pool.end();
  await stopAll();
}

function start(name, entrypoint) {
  const lines = [];
  const child = spawn(process.execPath, [entrypoint], {
    env: commonEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => lines.push(chunk.toString()));
  child.stderr.on('data', (chunk) => lines.push(chunk.toString()));
  return { name, child, lines };
}

async function waitForUrl(url) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(125);
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function waitForJob(jobId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const result = await pool.query('SELECT status, last_error FROM job_queue WHERE id = $1', [jobId]);
    const row = result.rows[0];
    if (row?.status === 'completed') {
      return;
    }
    if (row?.status === 'failed') {
      throw new Error(`Smoke job failed: ${row.last_error ?? 'unknown error'}`);
    }
    await delay(125);
  }
  throw new Error(`Smoke job ${jobId} did not complete`);
}

async function stopAll() {
  for (const processInfo of processes) {
    processInfo.child.kill('SIGTERM');
  }
  await Promise.all(processes.map(async (processInfo) => {
    const result = await Promise.race([
      new Promise((resolve) => processInfo.child.once('exit', (code, signal) => resolve({ code, signal }))),
      delay(3000).then(() => ({ timeout: true }))
    ]);
    if ('timeout' in result) {
      processInfo.child.kill('SIGKILL');
    }
    if (processInfo.child.exitCode && processInfo.child.exitCode !== 0) {
      process.stderr.write(`[${processInfo.name}] ${processInfo.lines.join('')}\n`);
    }
  }));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
