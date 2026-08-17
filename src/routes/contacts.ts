/**
 * Contacts routes — importação de planilhas de contatos no painel VYNTRA.
 *
 * Arquitetura: REUSA a estrutura existente. Contatos importados viram linhas
 * em `leads` (mesma tabela usada pelas campanhas/send_runs), e a lista é um
 * `capture_sessions` (mesmo agrupamento da Guia Leads). Assim, contatos
 * importados aparecem automaticamente como público disponível nas campanhas.
 *
 * - GET  /api/contacts/lists             -> listas de contatos (+ contagens)
 * - GET  /api/contacts/:listId/leads     -> leads de uma lista
 * - POST /api/contacts/import            -> importa contatos (normaliza +
 *                                          dedup por telefone + lista)
 *
 * Auth: `Authorization: Bearer <SUPABASE_ACCESS_TOKEN>` resolvido em
 * `{SUPABASE_URL}/auth/v1/user`. Isolamento: RLS do Supabase (rodcas/dados por
 * workspace) continua no lugar — o service role aqui só realiza escritas que o
 * front validou; leitura de listas respeita o mesmo acesso de leads.
 */
import type { FastifyInstance } from 'fastify';
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { extractBearerToken } from '../utils/auth.js';
import { z } from 'zod';
import { shortenLeadName } from '../services/lead-name.service.js';

/** Normaliza telefone (BR) → dígitos E.164-ish para deduplicação. */
export function normalizePhone(input: string): string | null {
  const raw = (input ?? '').replace(/[^\d+]/g, '');
  if (!raw) return null;
  let digits = raw.replace(/[^\d]/g, '');
  if (digits.length === 0) return null;
  // +55 nacional remove o prefixo para comparar com DDD local.
  if (/^\+55/.test(raw) && digits.length >= 12) digits = digits.slice(2);
  // Mantém o nono dígito de celulares: 11 dígitos é o formato nacional válido.
  return digits.length >= 10 && digits.length <= 13 ? digits : null;
}

const contactRowSchema = z.object({
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
  maps_url: z.string().nullable().optional(),
  instagram: z.string().nullable().optional(),
  facebook: z.string().nullable().optional(),
  whatsapp: z.string().nullable().optional(),
});

const importBodySchema = z.object({
  listName: z.string().min(1).max(120).default('Contatos importados'),
  contacts: z.array(contactRowSchema).min(1).max(5000),
});

interface SupabaseMeta {
  url: string;
  key: string;
}

function sup(): SupabaseMeta | null {
  const cfg = getSupabaseProspeccaoConfig();
  return cfg.url && cfg.serviceRoleKey ? { url: cfg.url.replace(/\/+$/, ''), key: cfg.serviceRoleKey } : null;
}

function headers(key: string, json = false): Record<string, string> {
  return json
    ? { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    : { apikey: key, Authorization: `Bearer ${key}` };
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

export function registerContactsRoutes(app: FastifyInstance): void {
  const log = getLogger();

  async function auth(req: { headers: Record<string, string | string[] | undefined> }) {
    const h = req.headers['authorization'];
    const bearer = extractBearerToken(typeof h === 'string' ? h : undefined);
    return resolveSupabaseUser(bearer);
  }

  app.post('/api/contacts/refresh-session', async (req, reply) => {
    const s = sup();
    const refreshToken = (req.body as { refreshToken?: unknown } | null)?.refreshToken;
    if (!s || typeof refreshToken !== 'string' || refreshToken.length < 6) {
      return reply.status(400).send({ error: 'refresh_token_required' });
    }
    const r = await fetch(`${s.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { ...headers(s.key, true) },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const body = await r.text();
    if (!r.ok) {
      log.warn({ status: r.status, body: body.slice(0, 300) }, 'contacts: refresh session failed');
      return reply.status(401).send({ error: 'refresh_failed', message: 'Sessão expirada. Sincronize novamente a sessão do Vyntra.' });
    }
    try {
      const data = JSON.parse(body) as { access_token?: string; refresh_token?: string; expires_in?: number };
      if (!data.access_token || !data.refresh_token) return reply.status(502).send({ error: 'refresh_invalid_response' });
      return reply.send({ accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in });
    } catch {
      return reply.status(502).send({ error: 'refresh_invalid_response' });
    }
  });

  app.get('/api/contacts/lists', async (req, reply) => {
    const s = sup();
    if (!s) return reply.status(503).send({ error: 'server_misconfigured', statusCode: 503 });
    const user = await auth(req);
    if (!user) return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });

    try {
      // Listas = capture_sessions que vieram de importação de contatos.
      const res = await fetch(
        `${s.url}/rest/v1/capture_sessions?select=id,imported_by,created_at&order=created_at.desc&limit=100`,
        { headers: headers(s.key) },
      );
      if (!res.ok) {
        return reply.status(502).send({ error: 'fetch_failed', statusCode: 502 });
      }
      const sessions = (await res.json()) as Array<{
        id: string;
        imported_by: string | null;
        created_at: string;
      }>;

      // Conta leads por lista.
      const lists = await Promise.all(
        sessions.map(async (sess) => {
          const count = await fetch(
            `${s.url}/rest/v1/leads?select=id&session_id=eq.${encodeURIComponent(sess.id)}`,
            {
              headers: { ...headers(s.key), Prefer: 'count=exact', Range: '0-0' },
            },
          )
            .then(async (r) => {
              const range = r.headers.get('content-range');
              const m = range?.match(/\/(\d+)$/);
              return m ? Number(m[1]) : 0;
            })
            .catch(() => 0);
          const importedBy = sess.imported_by ?? '';
          return {
            id: sess.id,
            name: importedBy.startsWith('importacao:')
              ? importedBy.slice('importacao:'.length)
              : 'Contatos importados',
            createdAt: sess.created_at,
            count,
          };
        }),
      );

      return reply.send({ lists });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.error({ errMessage: em }, 'contacts: lists failed');
      return reply.status(502).send({ error: 'lists_failed', message: em, statusCode: 502 });
    }
  });

  app.get('/api/contacts/:listId/leads', async (req, reply) => {
    const s = sup();
    if (!s) return reply.status(503).send({ error: 'server_misconfigured', statusCode: 503 });
    const user = await auth(req);
    if (!user) return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });

    const params = req.params as { listId?: string };
    const listId = params.listId;
    if (!listId) return reply.status(400).send({ error: 'list_id_required', statusCode: 400 });

    try {
      const res = await fetch(
        `${s.url}/rest/v1/leads?select=id,name,phone,category,status,created_at&session_id=eq.${encodeURIComponent(listId)}&order=created_at.asc`,
        { headers: headers(s.key) },
      );
      if (!res.ok) return reply.status(502).send({ error: 'fetch_failed', statusCode: 502 });
      return reply.send({ leads: await res.json() });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      return reply.status(502).send({ error: 'leads_failed', message: em, statusCode: 502 });
    }
  });

  app.post('/api/contacts/import', async (req, reply) => {
    const s = sup();
    if (!s) return reply.status(503).send({ error: 'server_misconfigured', statusCode: 503 });
    const user = await auth(req);
    if (!user) return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });

    const parsed = importBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => `contacts${i.path.join('.')}: ${i.message}`).join('; '),
        statusCode: 400,
      });
    }

    const { listName, contacts } = parsed.data;
    const logPrefix = `contacts:import(${user.id.slice(0, 8)})`;

    type Row = {
      name: string;
      phone: string;
      category?: string | null;
      website?: string | null;
      address?: string | null;
      city?: string | null;
      state?: string | null;
      rating?: number | null;
      reviews?: number | null;
      latitude?: number | null;
      longitude?: number | null;
      place_id?: string | null;
    };
    const normalized = new Map<string, Row>();
    const invalid: Row[] = [];

    // Normalizar + dedup DENTRO da própria planilha (telefone normalizado como chave).
    for (const c of contacts) {
      const ph = normalizePhone(c.phone);
      if (!ph) {
        invalid.push(c);
        continue;
      }
      if (!normalized.has(ph)) normalized.set(ph, { ...c, name: shortenLeadName(c.name, 80) || 'Sem nome', phone: ph });
    }

    try {
      // Dedup contra leads existentes (o identificador principal é o telefone).
      // Busca todos os phone únicos já cadastrados.
      const existingPhones = new Set<string>();
      let range = 0;
      const pageSize = 1000;
      for (;;) {
        const res = await fetch(
          `${s.url}/rest/v1/leads?select=phone&not.phone=is.null&limit=${pageSize}&offset=${range}`,
          { headers: headers(s.key) },
        );
        if (!res.ok) break;
        const rows = (await res.json()) as Array<{ phone: string | null }>;
        for (const r of rows) {
          if (!r.phone) continue;
          if (/(?:\+55)?\d{9,13}/.test(r.phone)) {
            const norm = normalizePhone(r.phone);
            if (norm) existingPhones.add(norm);
          }
        }
        if (rows.length < pageSize) break;
        range += pageSize;
      }

      const toCreate: Row[] = [];
      const duplicates: Row[] = [];
      for (const row of normalized.values()) {
        if (existingPhones.has(row.phone)) duplicates.push(row);
        else toCreate.push(row);
      }

      // Cria (ou reutiliza) a lista = capture_session.
      const listLabel = `importacao:${listName.trim()}`;
      const listRes = await fetch(`${s.url}/rest/v1/capture_sessions`, {
        method: 'POST',
        headers: { ...headers(s.key, true), Prefer: 'return=representation' },
        body: JSON.stringify({ imported_by: listLabel }),
      });
      let listData: Array<{ id: string }> = [];
      if (!listRes.ok) {
        const txt = await listRes.text();
        log.warn({ status: listRes.status, body: txt.slice(0, 500) }, `${logPrefix}: list create best-effort failed`);
      } else {
        listData = (await listRes.json().catch(() => [])) as Array<{ id: string }>;
      }
      const listId = listData[0]?.id ?? (await createListFallback(s, listLabel, log, logPrefix));

      // Upsert em lote dentro de leads com session_id da lista.
      let created = 0;
      let createdFails = 0;
      let firstWriteError: { status: number; body: string } | null = null;
      const BATCH = 200;
      for (let i = 0; i < toCreate.length; i += BATCH) {
        const batch = toCreate.slice(i, i + BATCH).map((r) => ({
          name: r.name,
          phone: r.phone,
          category: r.category ?? null,
          website: r.website ?? null,
          address: r.address ?? null,
          city: r.city ?? null,
          state: r.state ?? null,
          rating: r.rating ?? null,
          reviews: r.reviews ?? null,
          latitude: r.latitude ?? null,
          longitude: r.longitude ?? null,
          place_id: r.place_id ?? null,
          niche: 'contato',
          status: 'novo',
          session_id: listId ?? null,
          owner_user_id: user.id,
          import_state: 'imported',
          imported_at: new Date().toISOString(),
          phone_normalized: normalizePhone(r.phone),
        }));
        const res = await fetch(`${s.url}/rest/v1/leads`, {
          method: 'POST',
          headers: { ...headers(s.key, true), Prefer: 'return=minimal' },
          body: JSON.stringify(batch),
        });
        if (res.ok) created += batch.length;
        else {
          const body = await res.text();
          if (!firstWriteError) firstWriteError = { status: res.status, body: body.slice(0, 500) };
          // Falha única de constraint de duplicado → tenta por linha ignorando duplicados via upsert.
          const upsert = await fetch(`${s.url}/rest/v1/leads`, {
            method: 'POST',
            headers: {
              ...headers(s.key, true),
              Prefer: 'resolution=ignore-duplicates',
            },
            body: JSON.stringify(batch),
          });
          if (upsert.ok) created += batch.length;
          else {
            const upsertBody = await upsert.text();
            if (!firstWriteError) firstWriteError = { status: upsert.status, body: upsertBody.slice(0, 500) };
            createdFails += batch.length;
          }
        }
      }

      log.info({ total: contacts.length, unique: normalized.size, created, existing: duplicates.length, invalid: invalid.length, listId }, logPrefix);

      const response = {
        ok: createdFails === 0,
        summary: {
          total: contacts.length,
          valid: normalized.size,
          created,
          duplicates: duplicates.length,
          invalid: invalid.length,
          errors: createdFails,
        },
        listId,
        listName: listName.trim(),
        firstError: firstWriteError,
      };
      if (createdFails > 0) {
        log.error({ ...firstWriteError, created, createdFails }, `${logPrefix}: lead batch failed`);
      }
      return reply.send(response);
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.error({ errMessage: em }, logPrefix);
      return reply.status(502).send({ error: 'import_failed', message: em, statusCode: 502 });
    }
  });

  log.info('contacts: routes registered');
}

async function createListFallback(
  s: { url: string; key: string },
  label: string,
  log: ReturnType<typeof getLogger>,
  prefix: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${s.url}/rest/v1/capture_sessions`, {
      method: 'POST',
      headers: { ...headers(s.key, true), Prefer: 'return=representation' },
      body: JSON.stringify({ imported_by: label }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ id: string }>;
    return data[0]?.id ?? null;
  } catch (err) {
    log.warn({ errMessage: err instanceof Error ? err.message : 'unknown' }, `${prefix}: createListFallback failed`);
    return null;
  }
}
