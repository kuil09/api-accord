import { createLogger, errorMetadata, loadAppConfig, loadDotEnvFile, requireDatabaseUrl } from '@api-accord/config';

import { createWebApplication } from './app.js';
import { createPostgresEventStore, createPostgresResources } from '@api-accord/persistence';
import { DomainService } from '@api-accord/domain';

loadDotEnvFile();

const config = loadAppConfig('web');
const logger = createLogger({
  service: 'web',
  minimumLevel: config.logLevel
});
const databaseUrl = requireDatabaseUrl(config);
const postgres = createPostgresResources(databaseUrl, { applicationName: 'api-accord-web' });
const eventStore = createPostgresEventStore(postgres.pool);
const domainService = new DomainService(eventStore);

const application = createWebApplication({ logger, domain: { store: eventStore } });

application.server.listen(config.port, () => {
  logger.info('web.started', { port: config.port, nodeEnv: config.nodeEnv, domainBacked: true });
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info('web.stopping', { signal });

  try {
    await application.close();
    await postgres.pool.end();
  } catch (error) {
    logger.error('web.stop.failed', errorMetadata(error));
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
  logger.error('web.uncaught_exception', errorMetadata(error));
  process.exitCode = 1;
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (error) => {
  logger.error('web.unhandled_rejection', errorMetadata(error));
  process.exitCode = 1;
  void shutdown('unhandledRejection');
});