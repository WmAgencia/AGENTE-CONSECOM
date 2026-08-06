/**
 * Fastify application factory.
 *
 * Builds the configured HTTP app without listening, so both the runtime
 * entrypoint (server.ts) and the integration tests can share it:
 *   - server.ts -> buildApp() -> app.listen()
 *   - tests     -> buildApp() -> app.inject()
 *
 * The app wires environment validation, the tool registry, the Postgres
 * schema bootstrap, rate limiting, CORS, request logging/redaction, the
 * shared error handler, and every route group.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { getEnv, getAllowedOrigins } from './config/env.js';
import { getLogger } from './utils/logger.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerAgentRoutes } from './routes/agent.js';
import { registerWebhookRoutes } from './routes/webhook.js';
import { registerEvolutionRoutes } from './routes/evolution.js';
import { registerUiRoutes } from './routes/ui.js';
import { buildDefaultRegistry } from './tools/index.js';
import { ensureSchema, isDbEnabled } from './services/db.js';

export interface BuiltApp {
  app: FastifyInstance;
}

/**
 * Builds and returns the configured Fastify app. Throws on env validation
 * failure so callers can decide how to fail.
 */
export function buildApp(): BuiltApp {
  const log = getLogger();
  const env = getEnv(); // throws if env is invalid

  // Initialize the tool registry once at boot (frozen thereafter).
  try {
    const reg = buildDefaultRegistry();
    log.info(
      {
        enabled: reg.isEnabled(),
        registered: reg.list().length,
        allowedPerms: env.AGENT_ALLOWED_PERMS,
      },
      'server: tool registry initialized',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'registry init error';
    log.warn({ errMessage: message }, 'server: tool registry init failed; tools disabled');
  }

  // Initialize Postgres schema (fire-and-forget; non-blocking).
  // If DATABASE_URL is unset or the db is unreachable, the conversation store
  // falls back to in-RAM and a degraded log warning is emitted.
  if (isDbEnabled()) {
    void ensureSchema()
      .then((ok) => {
        log.info({ ok }, 'server: db schema init');
      })
      .catch((err) => {
        log.warn(
          { errMessage: err instanceof Error ? err.message : 'unknown' },
          'server: db schema init failed; in-RAM fallback active',
        );
      });
  }

  const app = Fastify({
    logger: false, // we use our own pino instance to ensure redaction
    trustProxy: true,
    disableRequestLogging: false,
    bodyLimit: 100 * 1024, // 100KB hard cap on request body
  });

  // === Rate limiting (Etapa 2C) ===
  // Default: 60 requests / 60s per IP. /health is exempt.
  void app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: `${env.RATE_LIMIT_WINDOW}s`,
    // Skip health-check so Railway probes don't trip the limit.
    hook: 'onRequest',
    keyGenerator: (req) => {
      // Use X-Forwarded-For first IP (Railway sets it) when trustProxy is on.
      const xff = req.headers['x-forwarded-for'];
      const ip =
        (typeof xff === 'string' ? xff.split(',')[0]?.trim() : undefined) ||
        req.ip ||
        'unknown';
      return ip;
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
  });

  // === CORS (site-facing API) ===
  // Emits Access-Control-Allow-* headers only for origins listed in
  // ALLOWED_ORIGINS (or "*" for local dev). Non-allowed cross-origin requests
  // are refused on OPTIONS preflight and get no CORS headers on real requests.
  // Supports subdomain wildcards: an entry like "*.lovable.app" matches any
  // origin whose host ends with ".lovable.app".
  const allowedOrigins = getAllowedOrigins();
  const allowsAny = allowedOrigins.includes('*');
  const isOriginAllowed = (origin: string): boolean => {
    if (allowsAny) return true;
    if (allowedOrigins.includes(origin)) return true;
    return allowedOrigins.some(
      (entry) =>
        entry.startsWith('*.') &&
        origin.length > entry.length &&
        origin.toLowerCase().endsWith(entry.slice(1).toLowerCase()),
    );
  };
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || typeof origin !== 'string') {
      // Same-origin (test page, curl) or none -> CORS not needed.
      return;
    }
    const allowed = isOriginAllowed(origin);

    if (req.method === 'OPTIONS') {
      // Preflight: short-circuit.
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      reply.header('Access-Control-Max-Age', '86400');
      if (allowed) {
        reply.header('Access-Control-Allow-Origin', allowsAny ? '*' : origin);
        reply.header('Vary', 'Origin');
        return reply.code(204).send();
      }
      return reply.code(403).send({ error: 'cors_origin_denied', statusCode: 403 });
    }

    if (allowed) {
      reply.header('Access-Control-Allow-Origin', allowsAny ? '*' : origin);
      reply.header('Vary', 'Origin');
    }
  });

  app.addHook('onRequest', async (req, _reply) => {
    // Redact ?secret=... from URL so webhook secrets never reach request logs.
    let safeUrl = req.url;
    if (safeUrl && /[?&]secret=/.test(safeUrl)) {
      safeUrl = safeUrl.replace(/([?&]secret=)[^&]*/gi, '$1[REDACTED]');
    }
    log.info(
      { method: req.method, url: safeUrl },
      'request: incoming',
    );
  });

  app.setErrorHandler((err, req, reply) => {
    const statusCode = err.statusCode && err.statusCode >= 400
      ? err.statusCode
      : 500;
    log.error(
      {
        method: req.method,
        url: req.url,
        statusCode,
        errMessage: err.message,
      },
      'request: error',
    );
    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'internal_error' : 'request_error',
      message:
        statusCode >= 500
          ? 'Internal server error'
          : err.message,
      statusCode,
    });
  });

  registerHealthRoutes(app);
  registerStatusRoutes(app);
  registerAgentRoutes(app);
  registerWebhookRoutes(app);
  registerEvolutionRoutes(app);
  registerUiRoutes(app);

  return { app };
}