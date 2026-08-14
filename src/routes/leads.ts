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

interface LeadRow {
  id: string;
  name: string | null;
  phone: string | null;
}

function sup() {
  const cfg = getSupabaseProspeccaoConfig();
  return cfg.url && cfg.serviceRoleKey ? cfg : null;
}

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

  app.post('/api/leads/manual', async (req, reply) => {
    const { workspaceId, userId } = getWorkspaceAndUser(req);
    const identifier = workspaceId ?? userId;
    if (!identifier) return reply.status(401).send({ error: 'unauthorized' });

    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const phone = typeof b.phone === 'string' ? b.phone.trim() : '';
    if (!name) return reply.status(400).send({ error: 'name_required' });
    if (!phone) return reply.status(400).send({ error: 'phone_required' });

    const pinfo = classifyBrazilianPhone(phone);
    if (pinfo.class !== 'MOBILE') {
      return reply.status(400).send({
        error: 'invalid_phone',
        message:
          pinfo.class === 'LANDLINE'
            ? 'Telefone fixo não é aceito para prospecção manual.'
            : 'Número inválido. Use o formato (DD) 99999-9999.',
      });
    }

    const s = sup();
    if (!s) return reply.status(503).send({ error: 'server_misconfigured' });

    // Deduplicação: mesmo telefone normalizado + mesmo dono = duplicado.
    const dupUrl = `${s.url}/rest/v1/leads?select=id,name&phone_normalized=eq.${encodeURIComponent(pinfo.e164!)}&owner_user_id=eq.${encodeURIComponent(identifier)}&limit=1`;
    const dupRes = await fetch(dupUrl, { headers: supHeaders(s.serviceRoleKey) });
    if (dupRes.ok) {
      const dupRows = (await dupRes.json()) as Array<{ id: string; name: string | null }>;
      if (dupRows.length > 0) {
        return reply.status(409).send({
          error: 'duplicate_lead',
          message: `Lead "${dupRows[0].name ?? 'sem nome'}" já existe com este telefone.`,
        });
      }
    }

    const lead: Record<string, unknown> = {
      name,
      phone,
      phone_normalized: pinfo.e164,
      city: typeof b.city === 'string' && b.city.trim() ? b.city.trim() : null,
      state: typeof b.state === 'string' && b.state.trim() ? b.state.trim() : null,
      instagram: typeof b.instagram === 'string' && b.instagram.trim() ? b.instagram.trim() : null,
      website: typeof b.website === 'string' && b.website.trim() ? b.website.trim() : null,
      niche: typeof b.specialty === 'string' && b.specialty.trim() ? b.specialty.trim() : null,
      notes: typeof b.notes === 'string' && b.notes.trim() ? b.notes.trim() : null,
      source: typeof b.source === 'string' && b.source.trim() ? b.source.trim() : 'manual',
      tags: Array.isArray(b.tags)
        ? b.tags.filter((t: unknown) => typeof t === 'string' && t.trim())
        : [],
      status: 'novo',
      owner_user_id: identifier,
      is_active_in_prospecting: true,
    };

    const createRes = await fetch(`${s.url}/rest/v1/leads`, {
      method: 'POST',
      headers: supHeaders(s.serviceRoleKey, true),
      body: JSON.stringify(lead),
    });
    if (!createRes.ok) {
      const txt = await createRes.text();
      log.warn({ status: createRes.status, body: txt.slice(0, 200) }, 'leads: manual creation failed');
      return reply.status(502).send({ error: 'lead_creation_failed' });
    }

    const created = (await createRes.json()) as Array<Record<string, unknown>>;
    // Resposta mínima (sem dados sensíveis).
    const out = {
      id: created[0]?.id,
      name: created[0]?.name,
      phone: created[0]?.phone,
      status: created[0]?.status,
    };
    return reply.send({ ok: true, lead: out });
  });

  log.info('leads: routes registered');
}
