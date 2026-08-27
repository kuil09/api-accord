import { createLogger, errorMetadata, loadAppConfig, loadDotEnvFile } from '@api-accord/config';

import { createWebApplication } from './app.js';

loadDotEnvFile();

const config = loadAppConfig('web');
const logger = createLogger({
  service: 'web',
  minimumLevel: config.logLevel
});
const application = createWebApplication({ logger });

application.server.listen(config.port, () => {
  logger.info('web.started', { port: config.port, nodeEnv: config.nodeEnv });
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
