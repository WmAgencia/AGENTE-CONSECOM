import type { FastifyInstance } from 'fastify';
import { getEnv, hasNvidiaApiKey, hasEvolutionConfig, hasDatabase } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { getConversationStore } from '../services/conversation.store.js';
import type { StatusResponse } from '../types.js';

export function registerStatusRoutes(app: FastifyInstance): void {
  const startedAt = Date.now();

  app.get('/api/status', async (_req, _reply) => {
    const log = getLogger();
    let env;
    try {
      env = getEnv();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'env error';
      log.error({ errMessage: message }, 'status: env misconfigured');
      throw err;
    }

    let toolsRegistered = 0;
    let toolsEnabled = false;
    try {
      // Lazy import to avoid forcing tool registry init at boot when env
      // is not yet validated.
      const { getDefaultRegistry } = await import('../tools/registry.js');
      try {
        const r = getDefaultRegistry();
        toolsEnabled = r.isEnabled();
        toolsRegistered = r.list().length;
      } catch {
        // registry not yet built; report zeros
      }
    } catch {
      // module not loadable for some reason; remain zeros
    }

    const store = getConversationStore();

    const body: StatusResponse = {
      service: env.SERVICE_NAME,
      version: env.SERVICE_VERSION,
      status: 'operational',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      nvidiaApiKeyConfigured: hasNvidiaApiKey(),
      model: env.AGENT_MODEL,
      evolutionConfigured: hasEvolutionConfig(),
      toolsEnabled,
      toolsRegistered,
      conversationsInMemory: store.size(),
      dbConnected: hasDatabase(),
      timestamp: new Date().toISOString(),
    };
    return body;
  });
}
