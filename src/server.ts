import { getLogger } from './utils/logger.js';
import { buildApp } from './app.js';
import { getEnv, hasSupabaseProspeccao } from './config/env.js';
import { SendWorker } from './services/send.worker.js';
import { resumeStuckImports } from './services/memory.processor.js';

async function bootstrap(): Promise<void> {
  const log = getLogger();

  let env;
  try {
    env = getEnv();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'env error';
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

  let worker: SendWorker | null = null;
  let workerStarted = false;
  if (hasSupabaseProspeccao()) {
    try {
      worker = new SendWorker();
      worker.start();
      // Disponibiliza o worker para o webhook invalidar o cache de
      // estado real das instâncias quando o estado muda (reconciliacao).
      (app as any).sendWorker = worker;
      workerStarted = true;
    } catch (err) {
      log.warn(
        { errMessage: err instanceof Error ? err.message : 'unknown' },
        'server: send worker disabled',
      );
    }
  }

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    log.info(
      { port: env.PORT, service: env.SERVICE_NAME },
      'server: listening',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'listen error';
    log.fatal({ errMessage: message }, 'server: failed to listen');
    process.exit(1);
  }

  if (workerStarted) {
    try {
      void resumeStuckImports();
    } catch (err) {
      log.warn(
        { errMessage: err instanceof Error ? err.message : 'unknown' },
        'server: resume stuck imports failed',
      );
    }
  }

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'server: shutting down');
    try {
      if (worker) worker.stop();
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