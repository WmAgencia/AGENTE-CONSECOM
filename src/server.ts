import { getLogger } from './utils/logger.js';
import { buildApp } from './app.js';
import { getEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  const log = getLogger();

  let env;
  try {
    env = getEnv();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'env error';
    // Logger may use default level here; still emit fatal then exit
    log.fatal({ errMessage: message }, 'server: environment configuration failed');
    process.exit(1);
  }

  let app;
  try {
    ({ app } = buildApp());
  } catch (err) {
    const message = err instanceof Error ? err.message : 'build error';
    log.fatal({ errMessage: message }, 'server: failed to build app');
    process.exit(1);
  }

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    log.info(
      { port: env.PORT, service: env.SERVICE_NAME, version: env.SERVICE_VERSION },
      'server: listening',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'listen error';
    log.fatal({ errMessage: message }, 'server: failed to listen');
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'server: shutting down');
    try {
      await app.close();
      log.info('server: closed cleanly');
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'close error';
      log.fatal({ errMessage: message }, 'server: error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void bootstrap();