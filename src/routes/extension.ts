/**
 * Extensão Vyntra Prospector — download e importação direta.
 *
 * Arquitetura: SEM login/token na extensão. O painel baixa um .zip
 * PERSONALIZADO por conta: o backend injeta `auto-config.json` com
 * `{ extensionKey, ownerUserId }`. A extensão chama os endpoints abaixo com o
 * header `x-extension-key` e o backend grava/consulta com service role,
 * associando tudo ao `ownerUserId` embutido. A lista de Importados (`/importados`)
 * é `import_state = 'imported'`; ao distribuir para uma campanha o estado vira
 * `'distributed'` e a lista é zerada — a extensão pode capturar de novo.
 *
 * GET  /api/extension/version          -> metadados do build
 * POST /api/extension/download         -> zip personalizado (auth Supabase)
 * POST /api/extension/import-leads     -> grava leads (x-extension-key)
 * POST /api/extension/known            -> place_ids já existentes (x-extension-key)
 * POST /api/extension/delete           -> remove leads por place_id (x-extension-key)
 */
import AdmZip from 'adm-zip';
import type { FastifyInstance } from 'fastify';
import { getEnv, getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { extractBearerToken } from '../utils/auth.js';
import { getTenantForUserId } from '../services/saas.auth.js';
import { getImportQuota } from '../services/saas.js';
import { z } from 'zod';

/** Versão do manifesto da extensão publicada (mantenha em sincronia com manifest.ts). */
const VERSION = '1.12.0';

const DEFAULT_BASE_ZIP_URL =
  'https://frontend-seven-sooty-78.vercel.app/downloads/consecom-extension.zip';

/** Se EXTENSION_API_KEY não estiver setada, usa este valor (dev/autoconfig). */
const DEFAULT_EXTENSION_KEY = 'consecom-extension-v1';

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

function headers(key: string, json = false): Record<string, string> {
  return json
    ? { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    : { apikey: key, Authorization: `Bearer ${key}` };
}

/** Valida o header `x-extension-key` contra EXTENSION_API_KEY (ou default). */
function extensionKeyOk(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const env = getEnv();
  const expected = env.EXTENSION_API_KEY || DEFAULT_EXTENSION_KEY;
  const provided = req.headers['x-extension-key'];
  return typeof provided === 'string' && provided === expected;
}

const leadSchema = z.object({
  name: z.string().max(240).default(''),
  phone: z.string().max(40),
  category: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  rating: z.number().nullable().optional(),
  reviews: z.number().nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  place_id: z.string().nullable().optional(),
  instagram: z.string().nullable().optional(),
  facebook: z.string().nullable().optional(),
});

const importLeadsSchema = z.object({
  ownerUserId: z.string().min(1).max(64),
  leads: z.array(leadSchema).min(1).max(50),
  listName: z.string().min(1).max(120).optional(),
  source: z.string().max(60).optional(),
  sourceDetail: z.string().max(2048).optional(),
  tags: z.array(z.string().max(60)).max(12).optional(),
  prospectFilters: z.record(z.unknown()).optional(),
  score: z.number().min(0).max(100).optional(),
  serviceInterest: z.string().nullable().optional(),
  prospectedAt: z.string().optional(),
});

/** Normaliza telefone BR → dígitos para dedup e `phone_normalized`. */
function normalizePhone(input: string): string | null {
  const raw = (input ?? '').replace(/[^\d+]/g, '');
  if (!raw) return null;
  let digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 0) return null;
  if (/^\+55/.test(raw) && digits.length >= 12) digits = digits.slice(2);
  return digits.length >= 10 && digits.length <= 13 ? digits : null;
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

  // Sites ativos da extensão (público). O painel Master liga/desliga e a
  // extensão esmaece/desativa os sites desligados.
  app.get('/api/extension/sites', async (_req, reply) => {
    const s = sup();
    if (!s) return reply.status(503).send({ error: 'server_misconfigured', statusCode: 503 });
    const defaults = { maps_enabled: true, webmotors_enabled: true, wepsy_enabled: true };
    try {
      const res = await fetch(`${s.url}/rest/v1/extension_settings?id=eq.1&select=*`, {
        headers: headers(s.key),
      });
      if (!res.ok) return reply.send({ ...defaults });
      const rows = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
      const row = rows[0] ?? {};
      return reply.send({
        maps: row.maps_enabled !== false,
        webmotors: row.webmotors_enabled !== false,
        wepsy: row.wepsy_enabled !== false,
      });
    } catch {
      return reply.send({ ...defaults });
    }
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

    const env = getEnv();
    const extensionKey = env.EXTENSION_API_KEY || DEFAULT_EXTENSION_KEY;
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
        Buffer.from(
          JSON.stringify({ extensionKey, ownerUserId: user.id }),
          'utf8',
        ),
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

  app.post('/api/extension/import-leads', async (req, reply) => {
    const s = sup();
    if (!s) return reply.status(503).send({ error: 'server_misconfigured', statusCode: 503 });
    if (!extensionKeyOk(req)) return reply.status(403).send({ error: 'forbidden', statusCode: 403 });

    const parsed = importLeadsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        statusCode: 400,
      });
    }

    const { ownerUserId, leads, listName, source, sourceDetail, tags, prospectFilters, score, serviceInterest, prospectedAt } = parsed.data;
    const logPrefix = `extension:import(${ownerUserId.slice(0, 8)})`;
    const tenantId = await getTenantForUserId(ownerUserId);

    // Plano do usuário: a extensão "entende" o plano e dá baixa nos leads
    // importados. Sem tenant ou sem plano ativo => sem limite (backward compat).
    let quota: { limited: boolean; used: number; limit: number; remaining: number | null } | null = null;
    if (tenantId) {
      quota = await getImportQuota(tenantId);
      if (quota.limited && (quota.remaining ?? 0) <= 0) {
        log.info({ tenantId, used: quota.used, limit: quota.limit }, `${logPrefix}: plano esgotado`);
        return reply.status(402).send({
          error: 'plan_exhausted',
          message: 'Você atingiu o limite de leads do seu plano. Assine um novo plano para continuar.',
          statusCode: 402,
          quota,
        });
      }
    }

    try {
      // Cria (ou reutiliza) a lista = capture_session.
      const listLabel = `importacao:${(listName ?? 'Importação extensão').trim()}`;
      const listRes = await fetch(`${s.url}/rest/v1/capture_sessions`, {
        method: 'POST',
        headers: { ...headers(s.key, true), Prefer: 'return=representation' },
        body: JSON.stringify({ imported_by: listLabel, tenant_id: tenantId }),
      });
      let listId: string | null = null;
      if (listRes.ok) {
        const data = (await listRes.json().catch(() => [])) as Array<{ id: string }>;
        listId = data[0]?.id ?? null;
      } else {
        log.warn({ status: listRes.status }, `${logPrefix}: list create failed`);
      }

      // Dedup dentro da própria leva (place_id como chave primária; sem
      // place_id, usa phone_normalized — modo prospector global).
      const seen = new Set<string>();
      const seenPhones = new Set<string>();
      const candidateRows: Array<Record<string, unknown>> = [];
      for (const lead of leads) {
        const ph = normalizePhone(lead.phone);
        const pid = lead.place_id ?? undefined;
        if (pid) {
          if (seen.has(pid)) continue;
          seen.add(pid);
        } else if (ph) {
          if (seenPhones.has(ph)) continue;
          seenPhones.add(ph);
        }
        candidateRows.push({
          name: lead.name.trim() || 'Sem nome',
          phone: lead.phone ?? '',
          phone_normalized: ph,
          category: lead.category ?? null,
          website: lead.website ?? null,
          address: lead.address ?? null,
          city: lead.city ?? null,
          state: lead.state ?? null,
          rating: lead.rating ?? null,
          reviews: lead.reviews ?? null,
          latitude: lead.latitude ?? null,
          longitude: lead.longitude ?? null,
          place_id: lead.place_id ?? null,
          instagram: lead.instagram ?? null,
          facebook: lead.facebook ?? null,
          niche: 'maps',
          status: 'novo',
          session_id: listId,
          owner_user_id: ownerUserId,
          tenant_id: tenantId,
          import_state: 'imported',
          imported_at: prospectedAt ?? new Date().toISOString(),
          source: source ?? 'google_maps',
          source_detail: sourceDetail ?? 'vyntra_prospector',
          has_website: !!lead.website,
          tags: tags ?? [],
          prospect_filters: prospectFilters ?? null,
          score: score ?? null,
          service_interest: serviceInterest ?? null,
        });
      }

      // Dedup contra o banco: busca place_ids já existentes (qualquer owner)
      // e envia apenas os novos — não sobrescreve leads já distribuídos/processados.
      const existingPlaceIds = new Set<string>();
      const existingPhones = new Set<string>();
      {
        const pids = candidateRows.map((r) => r.place_id).filter((x): x is string => typeof x === 'string');
        if (pids.length > 0) {
          const res = await fetch(
            `${s.url}/rest/v1/leads?select=place_id&place_id=in.(${pids.map(encodeURIComponent).join(',')})`,
            { headers: headers(s.key) },
          );
          if (res.ok) {
            const rows = (await res.json()) as Array<{ place_id: string | null }>;
            for (const r of rows) if (r.place_id) existingPlaceIds.add(r.place_id);
          }
        }
        // Leads sem place_id (prospector global): dedup por phone_normalized
        // apenas entre os da mesma leva (mesmo owner_user_id) para não
        // criar duplicados quando a mesma página é prospectada de novo.
        const phones = candidateRows
          .map((r) => r.phone_normalized)
          .filter((x): x is string => typeof x === 'string' && !candidateRows.find((r) => typeof r.place_id === 'string' && r.phone_normalized === x));
        if (phones.length > 0) {
          const unique = Array.from(new Set(phones));
          const res = await fetch(
            `${s.url}/rest/v1/leads?select=phone_normalized&phone_normalized=in.(${unique.map(encodeURIComponent).join(',')})&owner_user_id=eq.${encodeURIComponent(ownerUserId)}`,
            { headers: headers(s.key) },
          );
          if (res.ok) {
            const rows = (await res.json()) as Array<{ phone_normalized: string | null }>;
            for (const r of rows) if (r.phone_normalized) existingPhones.add(r.phone_normalized);
          }
        }
      }

      const rows = candidateRows.filter((r) => {
        const pid = r.place_id;
        if (typeof pid === 'string') return !existingPlaceIds.has(pid);
        const ph = r.phone_normalized;
        return typeof ph !== 'string' || !existingPhones.has(ph);
      });
      const duplicates = candidateRows.length - rows.length;

      // Respeita o limite do plano: importa apenas até o saldo restante.
      let quotaCut = 0;
      if (quota?.limited && quota.remaining != null && rows.length > quota.remaining) {
        quotaCut = rows.length - quota.remaining;
        rows.length = quota.remaining;
        log.info({ cut: quotaCut, remaining: quota.remaining }, `${logPrefix}: importação cortada pelo limite do plano`);
      }

      let created = 0;
      let failed = 0;
      let firstError: { status: number; body: string } | null = null;
      const BATCH = 50;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const res = await fetch(
          `${s.url}/rest/v1/leads?on_conflict=place_id`,
          {
            method: 'POST',
            headers: { ...headers(s.key, true), Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify(batch),
          },
        );
        if (res.ok) created += batch.length;
        else {
          const body = await res.text();
          if (!firstError) firstError = { status: res.status, body: body.slice(0, 500) };
          failed += batch.length;
        }
      }

      log.info({ total: leads.length, created, duplicates, failed, listId }, logPrefix);
      return reply.send({
        ok: failed === 0,
        summary: { total: leads.length, created, duplicates, errors: failed, quotaCut },
        listId,
        firstError,
        quota,
      });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.error({ errMessage: em }, logPrefix);
      return reply.status(502).send({ error: 'import_failed', message: em, statusCode: 502 });
    }
  });

  app.post('/api/extension/plan', async (req, reply) => {
    const s = sup();
    if (!s) return reply.status(503).send({ error: 'server_misconfigured', statusCode: 503 });
    if (!extensionKeyOk(req)) return reply.status(403).send({ error: 'forbidden', statusCode: 403 });
    const body = req.body as { ownerUserId?: unknown } | null;
    const ownerUserId = typeof body?.ownerUserId === 'string' ? body.ownerUserId : '';
    if (!ownerUserId) return reply.status(400).send({ error: 'owner_user_id_required', statusCode: 400 });
    try {
      const tenantId = await getTenantForUserId(ownerUserId);
      if (!tenantId) {
        return reply.send({ plan: null, limited: false, used: 0, limit: 0, remaining: null });
      }
      const quota = await getImportQuota(tenantId);
      return reply.send({ plan: null, ...quota });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.error({ errMessage: em }, 'extension: plan failed');
      return reply.status(502).send({ error: 'plan_failed', message: em, statusCode: 502 });
    }
  });

  app.post('/api/extension/known', async (req, reply) => {
    const s = sup();
    if (!s) return reply.status(503).send({ error: 'server_misconfigured', statusCode: 503 });
    if (!extensionKeyOk(req)) return reply.status(403).send({ error: 'forbidden', statusCode: 403 });

    const body = req.body as { placeIds?: unknown } | null;
    const placeIds = Array.isArray(body?.placeIds)
      ? body.placeIds.filter((x): x is string => typeof x === 'string').slice(0, 200)
      : [];
    if (placeIds.length === 0) return reply.send({ used: [], noInterest: {} });

    try {
      const res = await fetch(
        `${s.url}/rest/v1/leads?select=place_id,no_interest_until&place_id=in.(${placeIds.map(encodeURIComponent).join(',')})`,
        { headers: headers(s.key) },
      );
      if (!res.ok) return reply.status(502).send({ error: 'fetch_failed', statusCode: 502 });
      const rows = (await res.json()) as Array<{ place_id: string | null; no_interest_until: string | null }>;
      const used: string[] = [];
      const noInterest: Record<string, string> = {};
      for (const r of rows) {
        if (!r.place_id) continue;
        used.push(r.place_id);
        if (r.no_interest_until) noInterest[r.place_id] = r.no_interest_until;
      }
      return reply.send({ used, noInterest });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.error({ errMessage: em }, 'extension: known failed');
      return reply.status(502).send({ error: 'known_failed', message: em, statusCode: 502 });
    }
  });

  app.post('/api/extension/delete', async (req, reply) => {
    const s = sup();
    if (!s) return reply.status(503).send({ error: 'server_misconfigured', statusCode: 503 });
    if (!extensionKeyOk(req)) return reply.status(403).send({ error: 'forbidden', statusCode: 403 });

    const body = req.body as { placeIds?: unknown; ownerUserId?: unknown } | null;
    const placeIds = Array.isArray(body?.placeIds)
      ? body.placeIds.filter((x): x is string => typeof x === 'string').slice(0, 200)
      : [];
    if (placeIds.length === 0) return reply.send({ ok: 0, failed: 0 });

    try {
      let ok = 0;
      let failed = 0;
      for (const id of placeIds) {
        const owner = typeof body?.ownerUserId === 'string' ? body.ownerUserId : undefined;
        const url = owner
          ? `${s.url}/rest/v1/leads?place_id=eq.${encodeURIComponent(id)}&owner_user_id=eq.${encodeURIComponent(owner)}`
          : `${s.url}/rest/v1/leads?place_id=eq.${encodeURIComponent(id)}`;
        const res = await fetch(url, { method: 'DELETE', headers: headers(s.key) });
        if (res.ok) ok++;
        else failed++;
      }
      return reply.send({ ok, failed });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.error({ errMessage: em }, 'extension: delete failed');
      return reply.status(502).send({ error: 'delete_failed', message: em, statusCode: 502 });
    }
  });
}
