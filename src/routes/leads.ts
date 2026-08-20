/**
 * Leads routes — manual WhatsApp reply from the dashboard (human takeover).
 *
 * POST /api/leads/:id/reply
 *   Body: { text: string }
 *   Auth: x-user-id / x-workspace-id (same pattern as connections routes)
 *
 * Flow: resolves the caller's WhatsApp connection (instance) → sends the text
 * via Evolution → records the turn in consecom_conversations marked as a human
 * reply (agent_model = 'HUMAN_REPLY') so the chat UI can distinguish it from
 * AI messages, and touches last_message_sent on the lead.
 */
import type { FastifyInstance } from 'fastify';
import { getLogger } from '../utils/logger.js';
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { sendText } from '../services/evolution.service.js';
import {
  getUserConnection,
  getWorkspaceAndUser,
} from '../services/evolution.connections.js';
import { classifyBrazilianPhone } from '../lib/phone.js';
import { updateLeadStatus } from '../services/supabase.leads.js';
import { getTenantForUserId } from '../services/saas.auth.js';

interface LeadRow {
  id: string;
  name: string | null;
  phone: string | null;
}

function sup() {
  const cfg = getSupabaseProspeccaoConfig();
  return cfg.url && cfg.serviceRoleKey ? cfg : null;
}

/** Status aceitos na movimentação MANUAL do Kanban (drag-and-drop). */
const VALID_MANUAL_STATUSES = new Set([
  'enviado',
  'ia',
  'necessita_humano',
  'conversando',
  'remarketing',
  'responder_depois',
  'sem_interesse',
  'reuniao_marcada',
  'reuniao_cancelada',
  'para_ligacao',
  'fechado',
  'nao_fechado',
]);

function supHeaders(key: string, json = false): Record<string, string> {
  return json
    ? { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
    : { apikey: key, Authorization: `Bearer ${key}` };
}

type PasswordVerdict = 'ok' | 'invalid' | 'unavailable';

/**
 * Valida a senha contra o Supabase Auth — a MESMA senha usada no login da
 * plataforma. Usa o endpoint de token do GoTrue: 200 = credenciais corretas,
 * 400 = senha inválida, erro de rede = indisponível (502). A senha nunca é
 * armazenada; só é encaminhada ao Supabase em HTTPS.
 */
async function verifyLoginPassword(
  s: { url: string; serviceRoleKey: string },
  email: string,
  password: string,
): Promise<PasswordVerdict> {
  try {
    const res = await fetch(`${s.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: supHeaders(s.serviceRoleKey, true),
      body: JSON.stringify({ email, password }),
    });
    return res.ok ? 'ok' : 'invalid';
  } catch {
    return 'unavailable';
  }
}

interface SupabaseCfg {
  url: string;
  serviceRoleKey: string;
  rpc: string;
}

/** Registra a ação no log de auditoria (best-effort, service role). */
async function writeAudit(
  s: SupabaseCfg,
  actor: string,
  action: string,
  targetType: string,
  targetIds: string[],
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(`${s.url}/rest/v1/consecom_audit_log`, {
      method: 'POST',
      headers: supHeaders(s.serviceRoleKey, true),
      body: JSON.stringify({
        user_id: actor,
        action,
        target_type: targetType,
        target_ids: targetIds,
        details,
      }),
    });
  } catch {
    // auditoria é best-effort: falha aqui não deve bloquear a ação
  }
}

/** Extrai e valida o array de ids do corpo da requisição. */
function parseLeadIds(body: unknown): string[] | null {
  const b = body as { lead_ids?: unknown } | null;
  if (!Array.isArray(b?.lead_ids)) return null;
  const ids = b.lead_ids.filter(
    (x): x is string => typeof x === 'string' && x.trim().length > 0,
  );
  return ids.length > 0 ? ids : null;
}

export function registerLeadsRoutes(app: FastifyInstance): void {
  const log = getLogger();

  app.get('/api/leads/:id/ai-control', async (req, reply) => {
    const { workspaceId, userId } = getWorkspaceAndUser(req);
    if (!(workspaceId ?? userId)) return reply.status(401).send({ error: 'unauthorized' });
    const leadId = (req.params as { id?: string }).id;
    const s = sup();
    if (!leadId) return reply.status(400).send({ error: 'lead_id_required' });
    if (!s) return reply.status(503).send({ error: 'server_misconfigured' });
    const r = await fetch(`${s.url}/rest/v1/leads?select=ai_control&id=eq.${encodeURIComponent(leadId)}&limit=1`, {
      headers: supHeaders(s.serviceRoleKey),
    });
    if (!r.ok) return reply.status(502).send({ error: 'lead_lookup_failed' });
    const rows = (await r.json()) as Array<{ ai_control?: 'ai' | 'human' }>;
    if (rows.length === 0) return reply.status(404).send({ error: 'lead_not_found' });
    return reply.send({ ai_control: rows[0].ai_control === 'human' ? 'human' : 'ai' });
  });

  app.patch('/api/leads/:id/ai-control', async (req, reply) => {
    const { workspaceId, userId } = getWorkspaceAndUser(req);
    if (!(workspaceId ?? userId)) return reply.status(401).send({ error: 'unauthorized' });
    const leadId = (req.params as { id?: string }).id;
    const mode = (req.body as { mode?: unknown } | null)?.mode;
    const s = sup();
    if (!leadId) return reply.status(400).send({ error: 'lead_id_required' });
    if (mode !== 'ai' && mode !== 'human') return reply.status(400).send({ error: 'invalid_mode' });
    if (!s) return reply.status(503).send({ error: 'server_misconfigured' });
    const r = await fetch(`${s.url}/rest/v1/leads?id=eq.${encodeURIComponent(leadId)}`, {
      method: 'PATCH',
      headers: supHeaders(s.serviceRoleKey, true),
body: JSON.stringify({ ai_control: mode }),
    });
    if (!r.ok) return reply.status(502).send({ error: 'lead_update_failed' });
    return reply.send({ ok: true, ai_control: mode });
  });

  app.post('/api/leads/:id/status', async (req, reply) => {
    const { workspaceId, userId } = getWorkspaceAndUser(req);
    if (!(workspaceId ?? userId)) return reply.status(401).send({ error: 'unauthorized' });
    const leadId = (req.params as { id?: string }).id;
    const body = req.body as { status?: unknown; note?: unknown } | null;
    const status = typeof body?.status === 'string' ? body.status.trim() : '';
    const note = typeof body?.note === 'string' ? body.note.trim() : undefined;
    if (!leadId) return reply.status(400).send({ error: 'lead_id_required' });
    if (!status) return reply.status(400).send({ error: 'status_required' });
    if (!VALID_MANUAL_STATUSES.has(status)) {
      return reply.status(400).send({ error: 'invalid_status' });
    }
    try {
      // updateLeadStatus persiste o novo status + lead_status_history
      // (estado novo, motivo/nota e timestamp). A movimentação manual vem do
      // Kanban e não deve ser revertida por processos assíncronos.
      await updateLeadStatus(leadId, status, note);
      return reply.send({ ok: true, status });
    } catch {
      return reply.status(502).send({ error: 'lead_update_failed' });
    }
  });

  app.post('/api/leads/:id/reply', async (req, reply) => {
    const { workspaceId, userId } = getWorkspaceAndUser(req);
    const identifier = workspaceId ?? userId;
    if (!identifier) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const params = req.params as { id?: string };
    const leadId = params.id;
    const body = req.body as { text?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!leadId) return reply.status(400).send({ error: 'lead_id_required' });
    if (!text) return reply.status(400).send({ error: 'text_required' });

    const s = sup();
    if (!s) {
      return reply.status(503).send({ error: 'server_misconfigured' });
    }

    try {
      // 1) Load the lead (phone) server-side via service role.
      const leadRes = await fetch(
        `${s.url}/rest/v1/leads?select=id,name,phone&id=eq.${encodeURIComponent(leadId)}&limit=1`,
        { headers: supHeaders(s.serviceRoleKey) },
      );
      if (!leadRes.ok) return reply.status(502).send({ error: 'lead_lookup_failed' });
      const leads = (await leadRes.json()) as LeadRow[];
      const lead = leads[0];
      if (!lead) return reply.status(404).send({ error: 'lead_not_found' });
      if (!lead.phone) return reply.status(400).send({ error: 'lead_no_phone' });

      // 2) Resolve the caller's connected WhatsApp instance.
      const conn = await getUserConnection(identifier);
      if (!conn || conn.status !== 'connected') {
        return reply.status(400).send({
          error: 'no_connection',
          message: 'WhatsApp não está conectado para esta conta.',
        });
      }

      // 3) Send the message through the user's instance.
      const result = await sendText({ to: lead.phone, text, instance: conn.instance_name });
      if (!result.ok) {
        log.warn(
          { leadId, status: result.status, err: result.error },
          'leads: manual reply send failed',
        );
        return reply.status(502).send({
          error: 'send_failed',
          message: result.error ?? 'Falha ao enviar a mensagem.',
        });
      }

      // 4) Record the turn as a human reply so the chat UI can tag it.
      await fetch(`${s.url}/rest/v1/consecom_conversations`, {
        method: 'POST',
        headers: supHeaders(s.serviceRoleKey, true),
        body: JSON.stringify({
          lead_id: leadId,
          role: 'assistant',
          content: text,
          agent_model: 'HUMAN_REPLY',
        }),
      });

      // 5) Touch last_message_sent (best-effort).
      await fetch(`${s.url}/rest/v1/leads?id=eq.${encodeURIComponent(leadId)}`, {
        method: 'PATCH',
        headers: supHeaders(s.serviceRoleKey, true),
        body: JSON.stringify({ last_message_sent: new Date().toISOString() }),
      });

      log.info({ leadId, mock: result.mock === true }, 'leads: manual reply sent');
      return reply.send({ ok: true, mock: result.mock === true });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.error({ errMessage: em, leadId }, 'leads: reply handler failed');
      return reply.status(502).send({ error: 'reply_failed', message: 'Erro interno ao enviar.' });
    }
  });

  /**
   * Limpar lista ativa de prospecção (soft clear).
   *
   * POST /api/leads/clear-list
   *   Body: { lead_ids: string[] }
   *   Auth: x-user-id / x-workspace-id
   *
   * Apenas marca is_active_in_prospecting = false. NÃO apaga o lead nem o
   * histórico/campanhas/Kanban — tudo permanece preservado.
   */
  app.post('/api/leads/clear-list', async (req, reply) => {
    const { workspaceId, userId } = getWorkspaceAndUser(req);
    const identifier = workspaceId ?? userId;
    if (!identifier) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const leadIds = parseLeadIds(req.body);
    if (!leadIds) {
      return reply.status(400).send({ error: 'lead_ids_required' });
    }

    const s = sup();
    if (!s) {
      return reply.status(503).send({ error: 'server_misconfigured' });
    }

    try {
      const inList = leadIds.map((x) => encodeURIComponent(x)).join(',');
      const url = `${s.url}/rest/v1/leads?id=in.(${inList})`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: supHeaders(s.serviceRoleKey, true),
        body: JSON.stringify({ is_active_in_prospecting: false }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        log.error(
          { supabaseStatus: res.status, supabaseBody: body, count: leadIds.length },
          'leads: clear-list PATCH rejeitado pelo Supabase (migration v17 pendente?)',
        );
        return reply.status(502).send({ error: 'clear_failed' });
      }

      await writeAudit(s, identifier, 'leads.clear_list', 'lead', leadIds, {
        count: leadIds.length,
      });
      log.info({ count: leadIds.length }, 'leads: lista ativa limpa');
      return reply.send({ ok: true, cleared: leadIds.length });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.error({ errMessage: em }, 'leads: clear-list handler failed');
      return reply.status(502).send({ error: 'clear_failed' });
    }
  });

  /**
   * Exclusão DEFINITIVA de leads + todo o histórico (conversas, reuniões,
   * lead_status_history e participações em TODAS as campanhas).
   *
   * POST /api/leads/permanent-delete
   *   Body: { lead_ids: string[], password: string, email: string }
   *   Auth: x-user-id / x-workspace-id + senha de login do Supabase
   *
   * A senha é validada SOMENTE aqui (backend), contra o Supabase Auth (a mesma
   * do login da plataforma), e nunca é armazenada/validada no frontend. Toda
   * tentativa (sucesso ou falha) é registrada em consecom_audit_log.
   */
  app.post('/api/leads/permanent-delete', async (req, reply) => {
    const { workspaceId, userId } = getWorkspaceAndUser(req);
    const identifier = workspaceId ?? userId;
    if (!identifier) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const leadIds = parseLeadIds(req.body);
    if (!leadIds) {
      return reply.status(400).send({ error: 'lead_ids_required' });
    }

    const body = req.body as { password?: unknown; email?: unknown } | null;
    const password = typeof body?.password === 'string' ? body.password : '';
    if (!password) {
      return reply.status(400).send({ error: 'password_required' });
    }
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email) {
      return reply.status(400).send({ error: 'email_required' });
    }

    const s = sup();
    if (!s) {
      return reply.status(503).send({ error: 'server_misconfigured' });
    }

    const verdict = await verifyLoginPassword(s, email, password);
    if (verdict === 'unavailable') {
      log.warn({ identifier, email }, 'leads: exclusão definitiva rejeitada (verificação de senha indisponível)');
      return reply.status(502).send({ error: 'password_check_failed' });
    }
    if (verdict === 'invalid') {
      log.warn({ identifier, email }, 'leads: exclusão definitiva rejeitada (senha de login inválida)');
      await writeAudit(s, identifier, 'leads.permanent_delete_denied', 'lead', leadIds, {
        reason: 'invalid_password',
      });
      return reply.status(403).send({ error: 'invalid_password' });
    }

    try {
      const inList = leadIds.map((x) => encodeURIComponent(x)).join(',');
      const url = `${s.url}/rest/v1/leads?id=in.(${inList})`;

      // Conta/nomes do alvo para o log de auditoria (best-effort).
      let names: string[] = [];
      const sel = await fetch(`${url}&select=id,name`, {
        headers: supHeaders(s.serviceRoleKey),
      });
      if (sel.ok) {
        const rows = (await sel.json()) as Array<{ name?: string | null }>;
        names = rows.map((r) => r.name ?? '(sem nome)');
      }

      // DELETE cascateia para send_runs, conversas, histórico, contatos.
      const del = await fetch(url, { method: 'DELETE', headers: supHeaders(s.serviceRoleKey) });
      if (!del.ok) {
        return reply.status(502).send({ error: 'delete_failed' });
      }

      await writeAudit(s, identifier, 'leads.permanent_delete', 'lead', leadIds, {
        count: leadIds.length,
        names,
      });
      log.info({ count: leadIds.length }, 'leads: histórico excluído definitivamente');
      return reply.send({ ok: true, deleted: leadIds.length });
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.error({ errMessage: em }, 'leads: permanent-delete handler failed');
      return reply.status(502).send({ error: 'delete_failed' });
    }
  });

  /**
   * Criação manual de leads — corpo aceita tanto um único lead quanto um lote:
   *   { name, phone }                       -> lead único
   *   { leads: [{ name, phone, ... }] }     -> lote (processa todos)
   *
   * Processamento em lote: um item inválido/duplicado NÃO derruba os demais.
   * Resposta inclui status por item: added | duplicate | invalid | error.
   * source padrão = 'manual'.
   */
  app.post('/api/leads/manual', async (req, reply) => {
    const { workspaceId, userId } = getWorkspaceAndUser(req);
    const identifier = workspaceId ?? userId;
    if (!identifier) return reply.status(401).send({ error: 'unauthorized' });

    const b = (req.body ?? {}) as Record<string, unknown>;

    // Monta a lista de candidatos: lote (array) ou single.
    const rawLeads: Array<Record<string, unknown>> = Array.isArray(b.leads)
      ? (b.leads as Array<Record<string, unknown>>)
      : [b];

    if (rawLeads.length === 0) {
      return reply.status(400).send({ error: 'no_leads', message: 'Nenhum lead informado.' });
    }
    if (rawLeads.length > 200) {
      return reply.status(400).send({ error: 'too_many_leads', message: 'Limite de 200 leads por requisição.' });
    }

    const s = sup();
    if (!s) return reply.status(503).send({ error: 'server_misconfigured' });

    interface ManualResult {
      index: number;
      status: 'added' | 'duplicate' | 'invalid' | 'error';
      name: string;
      phone: string;
      id?: string;
      message?: string;
    }

    const results: ManualResult[] = [];
    const seenInBatch = new Map<string, number>(); // e164 -> index (para duplicados no mesmo lote)

    for (let i = 0; i < rawLeads.length; i++) {
      const raw = rawLeads[i] ?? {};
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      const phone = typeof raw.phone === 'string' ? raw.phone.trim() : '';

      if (!name) {
        results.push({ index: i, status: 'invalid', name: '', phone, message: 'Nome é obrigatório.' });
        continue;
      }
      if (!phone) {
        results.push({ index: i, status: 'invalid', name, phone: '', message: 'Telefone é obrigatório.' });
        continue;
      }

      const pinfo = classifyBrazilianPhone(phone);
      if (pinfo.class !== 'MOBILE') {
        results.push({
          index: i,
          status: 'invalid',
          name,
          phone,
          message:
            pinfo.class === 'LANDLINE'
              ? 'Telefone fixo não é aceito para prospecção manual.'
              : pinfo.reason || 'Número inválido. Use o formato (DD) 99999-9999.',
        });
        continue;
      }

      const e164 = pinfo.e164!;
      // Deduplicação dentro do próprio lote.
      const prevInBatch = seenInBatch.get(e164);
      if (prevInBatch !== undefined) {
        const prev = results[prevInBatch];
        results.push({
          index: i,
          status: 'duplicate',
          name,
          phone,
          message: `Já existe neste lote (${prev.name || 'sem nome'}).`,
        });
        continue;
      }

      // Deduplicação contra o banco POR TENANT: mesmo telefone normalizado +
      // mesmo tenant (leads legados sem tenant_id: mesmo owner). A duplicidade
      // deve impedir que o lead de outro usuário/tenant seja considerado
      // duplicado (spec: "per tenant", não `phone=X` global).
      const tenantId = (await getTenantForUserId(identifier).catch(() => null)) ?? null;
      const dupQuery = tenantId
        ? `phone_normalized=eq.${encodeURIComponent(e164)}&or=(tenant_id.eq.${encodeURIComponent(tenantId)},and(tenant_id.is.null,owner_user_id.eq.${encodeURIComponent(identifier)}))`
        : `phone_normalized=eq.${encodeURIComponent(e164)}&owner_user_id=eq.${encodeURIComponent(identifier)}`;
      let dupName: string | null = null;
      try {
        const dupUrl = `${s.url}/rest/v1/leads?select=id,name&${dupQuery}&limit=1`;
        const dupRes = await fetch(dupUrl, { headers: supHeaders(s.serviceRoleKey) });
        if (dupRes.ok) {
          const dupRows = (await dupRes.json()) as Array<{ id: string; name: string | null }>;
          dupName = dupRows[0]?.name ?? null;
        }
      } catch (dupErr) {
        const em = dupErr instanceof Error ? dupErr.message : 'unknown';
        log.warn({ errMessage: em }, 'leads: duplicate lookup failed (continuing)');
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

      const lead: Record<string, unknown> = {
        name,
        phone,
        phone_normalized: e164,
        city: typeof raw.city === 'string' && raw.city.trim() ? raw.city.trim() : null,
        state: typeof raw.state === 'string' && raw.state.trim() ? raw.state.trim() : null,
        instagram: typeof raw.instagram === 'string' && raw.instagram.trim() ? raw.instagram.trim() : null,
        website: typeof raw.website === 'string' && raw.website.trim() ? raw.website.trim() : null,
        niche: typeof raw.specialty === 'string' && raw.specialty.trim() ? raw.specialty.trim() : null,
        source: typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : 'manual',
        source_detail: typeof raw.source_detail === 'string' && raw.source_detail.trim() ? raw.source_detail.trim() : null,
        tags: Array.isArray(raw.tags)
          ? raw.tags.filter((t: unknown) => typeof t === 'string' && t.trim())
          : [],
        status: 'novo',
        owner_user_id: identifier,
        tenant_id: tenantId,
        is_active_in_prospecting: true,
        // Fluxo padrão VYNTRA: import_state='imported' faz o lead aparecer na
        // página /importados e permite distribuir para campanha via RPC
        // consecom_distribute_imported_leads (mesmo comportamento da extensão).
        import_state: 'imported',
        imported_at: new Date().toISOString(),
      };

      try {
        const createRes = await fetch(`${s.url}/rest/v1/leads?select=id,name,phone,status`, {
          method: 'POST',
          headers: { ...supHeaders(s.serviceRoleKey, true), Prefer: 'return=representation' },
          body: JSON.stringify(lead),
        });
        if (!createRes.ok) {
          const txt = await createRes.text();
          log.warn({ status: createRes.status, body: txt.slice(0, 300) }, 'leads: manual creation failed');
          const parsed = (await createRes.json().catch(() => null)) as { message?: string; hint?: string } | null;
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
        log.warn({ errMessage: em }, 'leads: manual creation threw');
        results.push({
          index: i,
          status: 'error',
          name,
          phone,
          message: 'Erro interno ao criar o lead.',
        });
      }
    }

    const summary = {
      total: results.length,
      added: results.filter((r) => r.status === 'added').length,
      duplicate: results.filter((r) => r.status === 'duplicate').length,
      invalid: results.filter((r) => r.status === 'invalid').length,
      error: results.filter((r) => r.status === 'error').length,
    };

    log.info({ identifier, summary }, 'leads: manual batch processed');

    // Lead único -> resposta compativel com o contrato antigo.
    if (!Array.isArray(b.leads)) {
      const single = results[0];
      if (single.status === 'added') {
        return reply.send({ ok: true, lead: { id: single.id, name: single.name, phone: single.phone, status: 'novo' } });
      }
      const statusCode = single.status === 'duplicate' ? 409 : 400;
      return reply.status(statusCode).send({ error: single.status === 'duplicate' ? 'duplicate_lead' : 'invalid_lead', message: single.message, statusCode });
    }

    return reply.send({ ok: true, summary, results });
  });

  log.info('leads: routes registered');
}
