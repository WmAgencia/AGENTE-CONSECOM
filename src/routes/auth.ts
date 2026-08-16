/**
 * Vyntra — Autenticação por nome de usuário (ou e-mail).
 *
 * POST /api/auth/login            -> { identifier, password } -> sessão Supabase
 * POST /api/auth/update-username  -> { username } (Bearer) -> atualiza app_users
 *
 * O login aceita um identificador que pode ser:
 *   - um e-mail (contém "@"), ou
 *   - um nome de usuário (resolvido em app_users.username -> e-mail).
 * A senha é sempre validada pelo Supabase Auth (GoTrue), nunca armazenada aqui.
 */
import type { FastifyInstance } from 'fastify';
import { getLogger } from '../utils/logger.js';
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { extractBearerToken } from '../utils/auth.js';
import { authOf, requireAuth } from '../services/saas.auth.js';

interface SupabaseMeta {
  url: string;
  key: string;
}

function supMeta(): SupabaseMeta | null {
  const cfg = getSupabaseProspeccaoConfig();
  return cfg.url && cfg.serviceRoleKey
    ? { url: cfg.url.replace(/\/+$/, ''), key: cfg.serviceRoleKey }
    : null;
}

function jsonHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

/** Resolve um identificador (e-mail ou username) para o e-mail de login. */
async function resolveEmail(s: SupabaseMeta, identifier: string): Promise<string | null> {
  const id = identifier.trim();
  if (!id) return null;
  if (id.includes('@')) return id;
  try {
    const res = await fetch(
      `${s.url}/rest/v1/app_users?select=email&username=eq.${encodeURIComponent(id)}&limit=1`,
      { headers: jsonHeaders(s.key) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ email: string }>;
    return rows[0]?.email ?? null;
  } catch {
    return null;
  }
}

export function registerAuthRoutes(app: FastifyInstance): void {
  const log = getLogger();

  app.post('/api/auth/login', async (req, reply) => {
    const s = supMeta();
    if (!s) return reply.status(503).send({ error: 'server_misconfigured', statusCode: 503 });

    const body = (req.body ?? {}) as { identifier?: unknown; password?: unknown };
    const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!identifier || !password) {
      return reply.status(400).send({ error: 'identifier_and_password_required', statusCode: 400 });
    }

    const email = await resolveEmail(s, identifier);
    if (!email) {
      log.warn({ identifier }, 'auth: login — usuário não encontrado');
      return reply.status(401).send({ error: 'invalid_credentials', statusCode: 401 });
    }

    try {
      const res = await fetch(`${s.url}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: jsonHeaders(s.key),
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        log.warn({ identifier }, 'auth: login — credenciais inválidas');
        return reply.status(401).send({ error: 'invalid_credentials', statusCode: 401 });
      }
      const data = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        token_type?: string;
        expires_in?: number;
        user?: Record<string, unknown>;
      };
      return reply.send({
        ok: true,
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        token_type: data.token_type ?? 'bearer',
        expires_in: data.expires_in ?? null,
        user: data.user ?? null,
      });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.error({ errMessage: em }, 'auth: login failed');
      return reply.status(502).send({ error: 'login_failed', message: em, statusCode: 502 });
    }
  });

  // Define/atualiza o nome de usuário do usuário autenticado (via RPC).
  app.post('/api/auth/update-username', async (req, reply) => {
    const auth = authOf(req);
    const guard = requireAuth(auth);
    if (!guard.ok) return reply.status(guard.statusCode).send({ error: guard.error, statusCode: guard.statusCode });

    const s = supMeta();
    if (!s) return reply.status(503).send({ error: 'server_misconfigured', statusCode: 503 });

    const body = (req.body ?? {}) as { username?: unknown };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    // Encaminha o access_token real do usuário (PostgREST monta auth.uid() dele).
    const authHeader = req.headers.authorization;
    const userToken = extractBearerToken(typeof authHeader === 'string' ? authHeader : undefined);
    if (!userToken) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }
    try {
      const res = await fetch(`${s.url}/rest/v1/rpc/set_username`, {
        method: 'POST',
        headers: {
          ...jsonHeaders(s.key),
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ p_username: username }),
      });
      if (!res.ok) {
        const text = await res.text();
        const msg = /username_taken/.test(text)
          ? 'Este nome de usuário já está em uso.'
          : /username_invalid/.test(text)
            ? 'Nome de usuário inválido (use 3-30 caracteres: letras, números, ponto, traço, sublinhado).'
            : 'Não foi possível atualizar o nome de usuário.';
        return reply.status(400).send({ error: 'username_update_failed', message: msg, statusCode: 400 });
      }
      const row = (await res.json()) as { username?: string | null } | null;
      return reply.send({ ok: true, username: row?.username ?? null });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.error({ errMessage: em }, 'auth: update-username failed');
      return reply.status(502).send({ error: 'username_update_failed', message: em, statusCode: 502 });
    }
  });
}
