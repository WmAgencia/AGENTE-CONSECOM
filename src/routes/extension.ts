/**
 * Extensão Vyntra Prospector — download PERSONALIZADO por conta.
 *
 * GET  /api/extension/version
 *   Metadados mínimos: versão do manifesto + caminho do build publicado.
 *
 * POST /api/extension/download
 *   Autenticado (`Authorization: Bearer <SUPABASE_ACCESS_TOKEN>` + `refreshToken`
 *   no corpo). Gera um .zip PERSONALIZADO para o usuário logado: baixa o build
 *   público base e injeta `_auto-config.json` com o refresh token da sessão.
 *   Assim a extensão já chega conectada à conta — sem interface de token.
 */
import AdmZip from 'adm-zip';
import type { FastifyInstance } from 'fastify';
import { getEnv, getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { extractBearerToken } from '../utils/auth.js';
import { z } from 'zod';

/** Versão do manifesto da extensão publicada (mantenha em sincronia com manifest.ts). */
const VERSION = '1.4.4';

const downloadBodySchema = z.object({
  refreshToken: z.string().min(20).max(10000),
});

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

    const parsed = downloadBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const raw = req.body as unknown;
      const bodyType = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
      const keys =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? Object.keys(raw as Record<string, unknown>)
          : [];
      const rt =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>).refreshToken
          : undefined;
      log.warn(
        {
          bodyType,
          keys,
          refreshTokenType: typeof rt,
          refreshTokenLength: typeof rt === 'string' ? rt.length : -1,
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
        },
        'extension: download body validation failed',
      );
      return reply.status(400).send({
        error: 'validation_error',
        message: 'refreshToken inválido ou ausente',
        statusCode: 400,
      });
    }
    const refreshToken = parsed.data.refreshToken;

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
        '_auto-config.json',
        Buffer.from(JSON.stringify({ refreshToken }), 'utf8'),
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
