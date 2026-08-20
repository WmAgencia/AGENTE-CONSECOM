/**
 * URL prospecting routes — nova funcionalidade VYNTRA:
 * usuário cola uma URL, o backend baixa a página, extrai (nome, telefone)
 * de forma flexível e retorna uma prévia para edição/importação.
 *
 * - POST /api/leads/prospect-url      -> { url } => prévia de contatos
 * - POST /api/leads/prospect-import   -> { url, leads: [...] } => cria leads
 *
 * Auth: x-user-id / x-workspace-id (mesmo padrão das demais rotas).
 * Leads importados: source='url_prospecting', source_detail=URL, tags opcionais.
 */
import type { FastifyInstance } from 'fastify';
import { getLogger } from '../utils/logger.js';
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { getWorkspaceAndUser } from '../services/evolution.connections.js';
import {
  fetchPageHtml,
  isValidProspectingUrl,
  prospectFromHtml,
  type ProspectedContact,
} from '../lib/urlProspecting.js';
import { classifyBrazilianPhone } from '../lib/phone.js';
import { getTenantForUserId } from '../services/saas.auth.js';

interface SupabaseMeta {
  url: string;
  key: string;
}

function sup(): SupabaseMeta | null {
  const cfg = getSupabaseProspeccaoConfig();
  return cfg.url && cfg.serviceRoleKey ? { url: cfg.url.replace(/\/+$/, ''), key: cfg.serviceRoleKey } : null;
}

function supHeaders(key: string, json = false): Record<string, string> {
  return json
    ? { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    : { apikey: key, Authorization: `Bearer ${key}` };
}

export function registerUrlProspectingRoutes(app: FastifyInstance): void {
  const log = getLogger();

  // Prévia de contatos extraídos da URL.
  app.post('/api/leads/prospect-url', async (req, reply) => {
    const { workspaceId, userId } = getWorkspaceAndUser(req);
    const identifier = workspaceId ?? userId;
    if (!identifier) return reply.status(401).send({ error: 'unauthorized' });

    const body = (req.body ?? {}) as { url?: unknown; source?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) {
      return reply.status(400).send({ error: 'url_required', message: 'Informe a URL da página.' });
    }
    if (!isValidProspectingUrl(url)) {
      return reply.status(400).send({ error: 'invalid_url', message: 'URL inválida. Use um endereço como https://exemplo.com.br.' });
    }

    let target = url;
    if (!/^https?:\/\//i.test(target)) target = `https://${target}`;

    const fetched = await fetchPageHtml(target);
    if (!fetched.ok || !fetched.html) {
      log.warn({ url: target, error: fetched.error }, 'url-prospecting: fetch failed');
      return reply.status(422).send({
        error: 'page_inaccessible',
        message: fetched.error ?? 'Não foi possível acessar a página.',
        statusCode: 422,
      });
    }

    const result = prospectFromHtml(fetched.html, target);
    if (result.blocked) {
      const message =
        result.blocked === 'captcha'
          ? 'A página exige verificação (CAPTCHA/anti-bot) e não pode ser prospectada automaticamente.'
          : result.blocked === 'auth'
            ? 'A página exige login/autorização e não pode ser prospectada automaticamente.'
            : 'A página bloqueou o acesso automático. Tente outra fonte.';
      log.warn({ url: target, blocked: result.blocked }, 'url-prospecting: blocked');
      return reply.status(422).send({
        error: `page_${result.blocked}`,
        message,
        statusCode: 422,
      });
    }

    if (result.contacts.length === 0) {
      return reply.status(422).send({
        error: 'no_contacts',
        message: 'Nenhum telefone encontrado na página.',
        statusCode: 422,
      });
    }

    // Resposta enxuta: sem dados sensíveis, com sinal de deduplicação POR
    // TENANT (spec: não `phone=X` global). Marca cada contato que JÁ existe
    // para o usuário/tenant, permitindo o "Selecionar novos" no frontend.
    const s = sup();
    if (!s) return reply.status(503).send({ error: 'server_misconfigured' });
    const tenantId = (await getTenantForUserId(identifier).catch(() => null)) ?? null;
    const existing = new Map<string, string | null>(); // phone_normalized -> name
    try {
      const phones = Array.from(
        new Set(
          result.contacts
            .map((c) => c.phone_normalized)
            .filter((p): p is string => typeof p === 'string' && p.length > 0),
        ),
      );
      if (phones.length > 0) {
        const filter = tenantId
          ? `phone_normalized=in.(${phones.map(encodeURIComponent).join(',')})&or=(tenant_id.eq.${encodeURIComponent(tenantId)},and(tenant_id.is.null,owner_user_id.eq.${encodeURIComponent(identifier)}))`
          : `phone_normalized=in.(${phones.map(encodeURIComponent).join(',')})&owner_user_id=eq.${encodeURIComponent(identifier)}`;
        const dupRes = await fetch(`${s.url}/rest/v1/leads?select=phone_normalized,name&${filter}`, {
          headers: supHeaders(s.key),
        });
        if (dupRes.ok) {
          const rows = (await dupRes.json()) as Array<{ phone_normalized: string | null; name: string | null }>;
          for (const row of rows) {
            if (row.phone_normalized) existing.set(row.phone_normalized, row.name);
          }
        }
      }
    } catch (dupErr) {
      const em = dupErr instanceof Error ? dupErr.message : 'unknown';
      log.warn({ errMessage: em }, 'url-prospecting: exists lookup failed');
    }

    const contacts = result.contacts.map((c, index) => {
      const normalized = c.phone_normalized;
      const dupName = normalized ? existing.get(normalized) ?? null : null;
      return {
        index,
        name: c.name,
        phone: c.phone,
        phone_normalized: c.phone_normalized,
        whatsapp: c.whatsapp,
        context: c.context ?? null,
        // Contatos que JÁ existem: o frontend mostra o aviso e pode desmarcá-los
        // via "Selecionar novos".
        exists: dupName !== null,
        existing_name: dupName,
        selected: dupName === null,
      };
    });

    log.info({ url: target, count: contacts.length }, 'url-prospecting: preview ready');
    return reply.send({
      ok: true,
      url: target,
      title: result.title ?? '',
      total: contacts.length,
      contacts,
    });
  });

  // Importa os contatos confirmados da prévia como leads.
  app.post('/api/leads/prospect-import', async (req, reply) => {
    const { workspaceId, userId } = getWorkspaceAndUser(req);
    const identifier = workspaceId ?? userId;
    if (!identifier) return reply.status(401).send({ error: 'unauthorized' });

    const body = (req.body ?? {}) as { url?: unknown; leads?: unknown; source?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    const leads = Array.isArray(body.leads) ? (body.leads as ProspectedContact[]) : [];

    if (!url) {
      return reply.status(400).send({ error: 'url_required', message: 'Informe a URL da página.' });
    }
    if (!isValidProspectingUrl(url)) {
      return reply.status(400).send({ error: 'invalid_url', message: 'URL inválida.' });
    }
    if (leads.length === 0) {
      return reply.status(400).send({ error: 'no_leads', message: 'Nenhum lead selecionado para importar.' });
    }
    if (leads.length > 200) {
      return reply.status(400).send({ error: 'too_many_leads', message: 'Limite de 200 leads por importação.' });
    }

    const s = sup();
    if (!s) return reply.status(503).send({ error: 'server_misconfigured' });

    interface ImportResult {
      index: number;
      status: 'added' | 'duplicate' | 'invalid' | 'error';
      name: string;
      phone: string;
      id?: string;
      message?: string;
    }

    const results: ImportResult[] = [];
    const seenInBatch = new Map<string, number>();

    for (let i = 0; i < leads.length; i++) {
      const raw = leads[i] ?? {};
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      const phone = typeof raw.phone === 'string' ? raw.phone.trim() : '';

      if (!phone) {
        results.push({ index: i, status: 'invalid', name, phone: '', message: 'Telefone é obrigatório.' });
        continue;
      }

      // Reutiliza a mesma normalização do resto do sistema.
      const pinfo = classifyBrazilianPhone(phone);
      if (pinfo.class !== 'MOBILE') {
        results.push({
          index: i,
          status: 'invalid',
          name,
          phone,
          message:
            pinfo.class === 'LANDLINE'
              ? 'Telefone fixo não é aceito para prospecção.'
              : pinfo.reason || 'Número inválido.',
        });
        continue;
      }
      const e164 = pinfo.e164!;

      const prevInBatch = seenInBatch.get(e164);
      if (prevInBatch !== undefined) {
        const prev = results[prevInBatch];
        results.push({
          index: i,
          status: 'duplicate',
          name,
          phone,
          message: `Já existe nesta importação (${prev.name || 'sem nome'}).`,
        });
        continue;
      }

      // Dedup contra o banco POR TENANT (mesmo telefone + mesmo tenant; leads
      // legados sem tenant_id: mesmo owner).
      const tenantId = (await getTenantForUserId(identifier).catch(() => null)) ?? null;
      const dupQuery = tenantId
        ? `phone_normalized=eq.${encodeURIComponent(e164)}&or=(tenant_id.eq.${encodeURIComponent(tenantId)},and(tenant_id.is.null,owner_user_id.eq.${encodeURIComponent(identifier)}))`
        : `phone_normalized=eq.${encodeURIComponent(e164)}&owner_user_id=eq.${encodeURIComponent(identifier)}`;
      let dupName: string | null = null;
      try {
        const dupUrl = `${s.url}/rest/v1/leads?select=id,name&${dupQuery}&limit=1`;
        const dupRes = await fetch(dupUrl, { headers: supHeaders(s.key) });
        if (dupRes.ok) {
          const rows = (await dupRes.json()) as Array<{ id: string; name: string | null }>;
          dupName = rows[0]?.name ?? null;
        }
      } catch (dupErr) {
        const em = dupErr instanceof Error ? dupErr.message : 'unknown';
        log.warn({ errMessage: em }, 'url-prospecting: duplicate lookup failed');
      }
      if (dupName !== null) {
        seenInBatch.set(e164, i);
        results.push({
          index: i,
          status: 'duplicate',
          name,
          phone,
          message: `Lead "${dupName || 'sem nome'}" já existe com esse telefone.`,
        });
        continue;
      }

      const leadRow: Record<string, unknown> = {
        name: name || 'Sem nome',
        phone,
        phone_normalized: e164,
        source: 'url_prospecting',
        source_detail: url,
        tags: ['url_prospecting'],
        status: 'novo',
        owner_user_id: identifier,
        tenant_id: tenantId,
        is_active_in_prospecting: true,
        // Fluxo igual ao da extensão: import_state='imported' permite distribuir
        // para uma campanha via RPC consecom_distribute_imported_leads.
        import_state: 'imported',
        imported_at: new Date().toISOString(),
      };

      try {
        const createRes = await fetch(`${s.url}/rest/v1/leads?select=id,name,phone,status`, {
          method: 'POST',
          headers: { ...supHeaders(s.key, true), Prefer: 'return=representation' },
          body: JSON.stringify(leadRow),
        });
        if (!createRes.ok) {
          const txt = await createRes.text();
          log.warn({ status: createRes.status, body: txt.slice(0, 300) }, 'url-prospecting: lead creation failed');
          const parsed = (await createRes.json().catch(() => null)) as { message?: string } | null;
          results.push({
            index: i,
            status: 'error',
            name,
            phone,
            message: parsed?.message ?? `Falha ao criar o lead (HTTP ${createRes.status}).`,
          });
          continue;
        }
        const created = (await createRes.json()) as Array<Record<string, unknown>>;
        seenInBatch.set(e164, i);
        results.push({
          index: i,
          status: 'added',
          name: created[0]?.name as string,
          phone: created[0]?.phone as string,
          id: created[0]?.id as string,
        });
      } catch (createErr) {
        const em = createErr instanceof Error ? createErr.message : 'unknown';
        log.warn({ errMessage: em }, 'url-prospecting: lead creation threw');
        results.push({ index: i, status: 'error', name, phone, message: 'Erro interno ao criar o lead.' });
      }
    }

    const summary = {
      total: results.length,
      added: results.filter((r) => r.status === 'added').length,
      duplicate: results.filter((r) => r.status === 'duplicate').length,
      invalid: results.filter((r) => r.status === 'invalid').length,
      error: results.filter((r) => r.status === 'error').length,
    };

    log.info({ identifier, url, summary }, 'url-prospecting: import processed');
    return reply.send({ ok: true, summary, results });
  });
}