import { createLogger, errorMetadata, loadAppConfig, loadDotEnvFile, requireDatabaseUrl } from '@api-accord/config';

import { createWorkerHealthApplication } from './app.js';
import { PostgresJobQueue } from './queue.js';
import { WorkerRuntime } from './runtime.js';

loadDotEnvFile();

const config = loadAppConfig('worker');
const logger = createLogger({
  service: 'worker',
  minimumLevel: config.logLevel
});
const databaseUrl = requireDatabaseUrl(config);
const queue = new PostgresJobQueue(databaseUrl, config.workerId);
const runtime = new WorkerRuntime({
  queue,
  logger,
  pollIntervalMs: config.workerPollIntervalMs,
  handlers: {
    'system.smoke': async (job) => {
      logger.debug('worker.smoke.received', { jobId: job.id, payload: job.payload });
      await Promise.resolve();
    }
  }
});
const healthApplication = createWorkerHealthApplication({
  logger,
  readinessProbe: () => runtime.checkReady()
});

runtime.start();
healthApplication.server.listen(config.port, () => {
  logger.info('worker.started', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    workerId: config.workerId,
    pollIntervalMs: config.workerPollIntervalMs
  });
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info('worker.stopping', { signal });

  try {
    await healthApplication.close();
    await runtime.stop();
  } catch (error) {
    logger.error('worker.stop.failed', errorMetadata(error));
    process.exitCode = 1;
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('uncaughtException', (error) => {
  logger.error('worker.uncaught_exception', errorMetadata(error));
  process.exitCode = 1;
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (error) => {
  logger.error('worker.unhandled_rejection', errorMetadata(error));
  process.exitCode = 1;
  void shutdown('unhandledRejection');
});
