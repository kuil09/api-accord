import { createLogger, errorMetadata, loadAppConfig, loadDotEnvFile, requireDatabaseUrl } from '@api-accord/config';

import { createApiApplication } from './app.js';
import { createPostgresResources } from './postgres.js';

loadDotEnvFile();

const config = loadAppConfig('api');
const logger = createLogger({
  service: 'api',
  minimumLevel: config.logLevel
});
const databaseUrl = requireDatabaseUrl(config);
const postgres = createPostgresResources(databaseUrl);
const application = createApiApplication({
  logger,
  readinessProbe: postgres.readinessProbe
});

application.server.listen(config.port, () => {
  logger.info('api.started', { port: config.port, nodeEnv: config.nodeEnv });
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info('api.stopping', { signal });

  try {
    await application.close();
    await postgres.pool.end();
  } catch (error) {
    logger.error('api.stop.failed', errorMetadata(error));
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
  logger.error('api.uncaught_exception', errorMetadata(error));
  process.exitCode = 1;
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (error) => {
  logger.error('api.unhandled_rejection', errorMetadata(error));
  process.exitCode = 1;
  void shutdown('unhandledRejection');
});
