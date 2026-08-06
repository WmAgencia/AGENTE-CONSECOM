import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '../types.js';
export function registerHealthRoutes(app: FastifyInstance): void {
  const startedAt = Date.now();

  app.get('/health', { config: { rateLimit: false } }, async (_req, _reply) => {
    const body: HealthResponse = {
      status: 'ok',
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    };
    return body;
  });
}
