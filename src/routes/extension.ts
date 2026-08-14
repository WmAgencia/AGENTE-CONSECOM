/**
 * Extensão Vyntra Prospector — download PERSONALIZADO por conta.
 *
 * GET  /api/extension/version
 *   Metadados mínimos: versão do manifesto + caminho do build publicado.
 *
 * POST /api/extension/download
 *   Autenticado (`Authorization: Bearer <SUPABASE_ACCESS_TOKEN>` + `refreshToken`
 *   no corpo). NÃO confia cegamente no token enviado: troca o refresh token no
 *   Supabase (`grant_type=refresh_token`) e injeta no `auto-config.json` o
 *   refresh token RENOVADO. Assim a extensão já chega conectada à conta — sem
 *   interface de token — e tokens antigos/corrompidos no navegador não quebram
 *   a geração (falham com 401 claro pedindo novo login, em vez de gerar zip
 *   inutilizável).
 */
import AdmZip from 'adm-zip';
import type { FastifyInstance } from 'fastify';
import { getEnv, getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { extractBearerToken } from '../utils/auth.js';

/** Versão do manifesto da extensão publicada (mantenha em sincronia com manifest.ts). */
const VERSION = '1.4.4';

const DEFAULT_BASE_ZIP_URL =
  'https://frontend-seven-sooty-78.vercel.app/downloads/consecom-extension.zip';

interface SupabaseMeta {
  url: string;
  key: string;
}

function sup(): SupabaseMeta | null {
  const cfg = getSupabaseProspeccaoConfig();
  return cfg.url && cfg.serviceRoleKey
    ? { url: cfg.url.replace(/\/+$/, ''), key: cfg.serviceRoleKey }
    : null;
}

async function resolveSupabaseUser(
  token: string | undefined,
): Promise<{ id: string } | null> {
  const s = sup();
  if (!s || !token) return null;
  try {
    const res = await fetch(`${s.url}/auth/v1/user`, {
      headers: { apikey: s.key, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === 'string' && body.id.length > 0 ? { id: body.id } : null;
  } catch {
    return null;
  }
}

export function registerExtensionRoutes(app: FastifyInstance): void {
  const log = getLogger();

  app.get('/api/extension/version', async (_req, reply) => {
    const env = getEnv();
    return reply.status(200).send({
      version: VERSION,
      bucket: env.EXTENSION_BUCKET,
      path: env.EXTENSION_OBJECT_PATH,
    });
  });

  app.post('/api/extension/download', async (req, reply) => {
    const s = sup();
    if (!s) {
      log.warn('extension: SUPABASE_URL/SERVICE_ROLE não configuradas');
      return reply.status(503).send({
        error: 'server_misconfigured',
        message: 'Supabase não configurado no backend',
        statusCode: 503,
      });
    }

    const authHeader = req.headers['authorization'];
    const bearer = extractBearerToken(typeof authHeader === 'string' ? authHeader : undefined);
    const user = await resolveSupabaseUser(bearer);
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }

    // Renova a sessão no Supabase. O token enviado pelo painel NÃO vai direto
    // para o zip: trocamos `grant_type=refresh_token` e embutimos o refresh
    // token NOVO. Tokens antigos/corrompidos falham aqui com 401 claro, em vez
    // de gerar um zip que a extensão não conseguiria renovar.
    const raw = (req.body as { refreshToken?: unknown } | null)?.refreshToken;
    if (typeof raw !== 'string' || raw.length === 0) {
      return reply.status(400).send({
        error: 'validation_error',
        message: 'refreshToken inválido ou ausente',
        statusCode: 400,
      });
    }
    let renewedRefreshToken = raw;
    try {
      const tok = await fetch(`${s.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: {
          apikey: s.key,
          Authorization: `Bearer ${s.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refresh_token: raw }),
      });
      const tokBody = await tok.text();
      if (!tok.ok) {
        log.warn(
          { status: tok.status, body: tokBody.slice(0, 300) },
          'extension: download refresh token inválido',
        );
        return reply.status(401).send({
          error: 'session_expired',
          message: 'Sessão expirada. Entre novamente no Vyntra e tente baixar de novo.',
          statusCode: 401,
        });
      }
      const data = JSON.parse(tokBody) as { refresh_token?: string };
      if (typeof data.refresh_token === 'string' && data.refresh_token.length > 0) {
        renewedRefreshToken = data.refresh_token;
      }
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.warn({ errMessage: em }, 'extension: download refresh exchange failed');
      return reply.status(502).send({
        error: 'session_exchange_failed',
        message: 'Não foi possível renovar a sessão. Tente novamente.',
        statusCode: 502,
      });
    }

    const env = getEnv();
    const baseUrl = env.EXTENSION_BASE_ZIP_URL || DEFAULT_BASE_ZIP_URL;
    try {
      const baseRes = await fetch(baseUrl);
      if (!baseRes.ok) {
        log.error({ status: baseRes.status, baseUrl }, 'extension: falha ao buscar zip base');
        return reply.status(502).send({ error: 'base_zip_fetch_failed', statusCode: 502 });
      }
      const baseBuf = Buffer.from(await baseRes.arrayBuffer());
      const zip = new AdmZip(baseBuf);
      zip.addFile(
        'auto-config.json',
        Buffer.from(JSON.stringify({ refreshToken: renewedRefreshToken }), 'utf8'),
      );
      const out = zip.toBuffer();
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', 'attachment; filename="consecom-extension.zip"');
      return reply.send(out);
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.error({ errMessage: em }, 'extension: falha ao gerar zip personalizado');
      return reply.status(502).send({ error: 'zip_generation_failed', message: em, statusCode: 502 });
    }
  });
}
