/**
 * GET /api/evolution/health
 *
 * Probes the configured Evolution API instance and reports reachability
 * without leaking secrets. Useful for:
 *  - Railway healthcheck probes (in addition to /health)
 *  - Operator dashboard status
 *  - Pre-flight verification after deploy
 */
import type { FastifyInstance } from 'fastify';
import {
  isEvolutionMockMode,
  checkEvolutionHealth,
} from '../services/evolution.service.js';

export function registerEvolutionRoutes(app: FastifyInstance): void {
  app.get(
    '/api/evolution/health',
    { config: { rateLimit: false } },
    async (_req, reply) => {
      const result = await checkEvolutionHealth();
      const statusCode = result.ok ? 200 : 502;
      return reply.status(statusCode).send(result);
    },
  );

  // mark mock mode is reachable for diagnostics; safe export.
  void isEvolutionMockMode;
}
