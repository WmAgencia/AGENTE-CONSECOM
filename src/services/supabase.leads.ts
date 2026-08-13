/**
 * Supabase access for the prospection webhook.
 *
 * Uses the service role key (server-side only) to:
 *   - find a lead by WhatsApp JID / phone number
 *   - update a lead's status (api: flagging "respondendo")
 *   - persist conversation turns for a lead (consecom_conversations)
 *   - load agent directives / name used in the agent system prompt
 */
import { getSupabaseProspeccaoConfig } from '../config/env.js';
import { normalizeBrazilianPhone } from '../lib/phone.js';

export interface LeadRow {
  id: string;
  name: string | null;
  phone: string | null;
  status: string | null;
  niche: string | null;
  category: string | null;
  ai_control?: 'ai' | 'human' | null;
  owner_user_id?: string | null;
}
// CAMPAIGN ≠ CONVERSAÇÃO. O lead pode responder em QUALQUER status do funil
// (novo/na_fila durante a campanha, enviado após concluir, conversando,
// remarketing, reuniao_marcada/cancelada). Só ficam de fora estados terminais
// que não devem mais receber atendimento automático:
// - "sem_interesse": recusou (no_interest_until bloqueado) -> NÃO responder.
// - "nao_fechado" / "perdido": desfecho negativo registrado.
const BLOCKED_REPLY_STATUSES = new Set(['sem_interesse', 'nao_fechado', 'perdido']);

/** true quando o lead ainda pode receber resposta automática da IA. */
export function canAutoReply(status: string | null | undefined): boolean {
  return !!status && !BLOCKED_REPLY_STATUSES.has(status);
}

/** Alias mantido para compatibilidade (legado). */
export function isProspectingStatus(status: string | null | undefined): boolean {
  return canAutoReply(status);
}

// Estado de conversa que devem virar "conversando" no primeiro retorno do
// lead. Reuniões agendadas/canceladas e fechados NÃO são rebaixados.
const ACTIVATE_ON_REPLY = new Set([
  'novo',
  'na_fila',
  'enviado',
  'conversando',
  'remarketing',
  'aguardando',
  'mensagem_enviada',
  'respondendo',
  'para_ligacao',
]);

/** Status de funil que passam a "conversando" quando o lead responde. */
export function shouldActivateConversation(status: string | null | undefined): boolean {
  return !!status && ACTIVATE_ON_REPLY.has(status);
}

// ---------------------------------------------------------------------------
// Completude da sequência de campanha (MODIFICAÇÃO 1).
//
// O lead só deve ser movido para "Conversando" quando TODAS as mensagens da
// campanha já foram enviadas. Se ele responder no MEIO da sequência (ainda há
// mensagem pendente), ou se alguma mensagem falhou (run 'failed'), o lead é
// mantido na coluna atual (Enviados) e a sequência continua normalmente.
// ---------------------------------------------------------------------------

export interface LeadSequenceCompleteness {
  hasRun: boolean;
  runStatus: string | null;
  currentPosition: number | null;
  queueMessageCount: number | null;
}

/**
 * Decisão pura de movimento do kanban com base na sequência da campanha.
 *
 * - Sem run (lead sem campanha): comportamento antigo preservado (move).
 * - Run 'pending'/'running'/'failed': mensagens ainda não enviadas/enviadas
 *   por completo => NÃO move (mensagem falha não conta como enviada).
 * - Run 'done': move apenas quando `current_position` alcançou o total de
 *   mensagens da fila. Se a contagem não for conhecida (falha de leitura),
 *   assume done = completo para não travar o fluxo.
 */
export function isSequenceComplete(info: LeadSequenceCompleteness): boolean {
  const { hasRun, runStatus, currentPosition, queueMessageCount } = info;
  if (!hasRun) return true;
  if (runStatus !== 'done') return false;
  if (typeof currentPosition === 'number' && typeof queueMessageCount === 'number') {
    return currentPosition >= queueMessageCount;
  }
  return true;
}

/**
 * Carrega o estado da sequência de campanha do lead (run mais recente +
 * quantidade de mensagens da fila). Best-effort: nunca lança erro.
 */
export async function loadLeadSequenceCompleteness(
  leadId: string,
): Promise<LeadSequenceCompleteness> {
  const cfg = getSupabaseProspeccaoConfig();
  const empty: LeadSequenceCompleteness = {
    hasRun: false,
    runStatus: null,
    currentPosition: null,
    queueMessageCount: null,
  };
  if (!cfg.url || !cfg.serviceRoleKey || !leadId) return empty;
  try {
    const r = await fetch(
      `${cfg.url}/rest/v1/send_runs?select=id,campaign_id,status,current_position` +
        `&lead_id=eq.${encodeURIComponent(leadId)}&order=created_at.desc&limit=1`,
      { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
    );
    if (!r.ok) return empty;
    const rows = (await r.json()) as Array<{
      campaign_id: string | null;
      status: string | null;
      current_position: number | null;
    }>;
    const run = rows[0];
    if (!run) return empty;

    let queueMessageCount: number | null = null;
    if (run.campaign_id) {
      const q = await fetch(
        `${cfg.url}/rest/v1/queue_messages?select=id` +
          `&campaign_id=eq.${encodeURIComponent(run.campaign_id)}&limit=2000`,
        { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
      );
      if (q.ok) {
        const msgs = (await q.json()) as Array<{ id: string }>;
        queueMessageCount = msgs.length;
      }
    }

    return {
      hasRun: true,
      runStatus: run.status,
      currentPosition: run.current_position,
      queueMessageCount,
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Índice de leads em memória (TTL) para a busca por telefone.
//
// O lead.phone é gravado FORMATADO (ex.: "(34) 99203-8968"), então a busca
// `phone=eq.<dígitos>` nunca casa com o JID do WhatsApp. A busca normaliza
// AMBOS os lados (JID de entrada e lead.phone) e compara o E.164 canônico.
// O índice é pequeno (tabela interna, dezenas/centenas de leads) e fica em
// cache por TTL curto para não fazer <table scan> no REST a cada mensagem.
// ---------------------------------------------------------------------------
const LEAD_INDEX_TTL_MS = 60_000;

let leadIndexCache: LeadRow[] | null = null;
let leadIndexCachedAt = 0;

async function fetchLeadIndex(): Promise<LeadRow[]> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey) return [];

  const now = Date.now();
  if (leadIndexCache && now - leadIndexCachedAt < LEAD_INDEX_TTL_MS) {
    return leadIndexCache;
  }

  const rows: LeadRow[] = [];
  try {
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      let res = await fetch(
        `${cfg.url}/rest/v1/leads?select=id,name,phone,status,niche,category,ai_control,owner_user_id&order=id&offset=${offset}&limit=1000`,
        { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
      );
      if (!res.ok) {
        res = await fetch(
          `${cfg.url}/rest/v1/leads?select=id,name,phone,status,niche,category&order=id&offset=${offset}&limit=1000`,
          { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
        );
      }
      if (!res.ok) break;
      const batch = (await res.json()) as LeadRow[];
      rows.push(...batch);
      if (batch.length < 1000) break;
      offset += batch.length;
    }
  } catch {
    // índice vazio: findLeadByPhone retornará null e o fluxo loga "lead não encontrado"
  }
  leadIndexCache = rows;
  leadIndexCachedAt = now;
  return rows;
}

/**
 * Procura um lead pelo JID/número do WhatsApp. Compara a forma E.164 canônica
 * (55 + DDD + número) do JID com a de cada lead cadastrado, ignorando máscara
 * de formatação, espaços, hífens e parênteses da coluna phone.
 */
export async function findLeadByPhone(jid: string): Promise<LeadRow | null> {
  const inbound = normalizeBrazilianPhone(jid);
  if (!inbound) return null;

  const rows = await fetchLeadIndex();
  for (const row of rows) {
    const stored = normalizeBrazilianPhone(row.phone ?? '');
    if (stored && stored === inbound) return row;
  }
  return null;
}

export async function updateLeadStatus(
  leadId: string,
  status: string,
  notes?: string,
): Promise<void> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey) return;
  const now = new Date().toISOString();

  await fetch(`${cfg.url}/rest/v1/leads?id=eq.${leadId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
    },
    body: JSON.stringify({ status, updated_at: now }),
  });

  await fetch(`${cfg.url}/rest/v1/lead_status_history`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
    },
    body: JSON.stringify({ lead_id: leadId, status, notes: notes ?? null }),
  });
}

/**
 * Busca o lead DIRETO no Supabase pelo id (SEM cache do índice de telefone).
 * Usado quando precisamos do status MAIS RECENTE (ex.: logo após o agente
 * executar tools que mudam o estado do lead, para não sobrescrever com um
 * status obsoleto lido no início do processamento).
 */
export async function getLeadById(leadId: string): Promise<LeadRow | null> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey || !leadId) return null;
  try {
    let res = await fetch(
      `${cfg.url}/rest/v1/leads?select=id,name,phone,status,niche,category,ai_control,owner_user_id&id=eq.${encodeURIComponent(leadId)}&limit=1`,
      { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
    );
    if (!res.ok) {
      res = await fetch(
        `${cfg.url}/rest/v1/leads?select=id,name,phone,status,niche,category&id=eq.${encodeURIComponent(leadId)}&limit=1`,
        { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
      );
    }
    if (!res.ok) return null;
    const rows = (await res.json()) as LeadRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Interrompe a campanha PARA ESTE LEAD: marca como `failed` qualquer run
 * pendente/em andamento, impedindo que o worker envie a próxima mensagem
 * programada. Quando todos os runs da campanha terminarem (done/failed), o
 * worker finaliza a campanha. Sem efeito quando o lead não tem runs ativos.
 */
export async function cancelLeadSendRuns(
  leadId: string,
  reason = 'sem_interesse',
): Promise<void> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey || !leadId) return;
  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/send_runs?select=id,campaign_id&lead_id=eq.${encodeURIComponent(leadId)}&status=in.("pending","running")`,
      { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
    );
    if (!res.ok) return;
    const runs = (await res.json()) as Array<{ id: string; campaign_id: string | null }>;
    const campaignIds = new Set<string>();
    for (const run of runs) {
      await fetch(`${cfg.url}/rest/v1/send_runs?id=eq.${run.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: cfg.serviceRoleKey,
          Authorization: `Bearer ${cfg.serviceRoleKey}`,
        },
        body: JSON.stringify({ status: 'failed', fail_reason: reason }),
      });
      if (run.campaign_id) campaignIds.add(run.campaign_id);
    }
    // Reflete na contagem agregada da campanha (best-effort).
    for (const campaignId of campaignIds) {
      const r = await fetch(
        `${cfg.url}/rest/v1/campaigns?id=eq.${campaignId}&select=fail_count,success_count`,
        { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
      );
      if (!r.ok) continue;
      const rows = (await r.json()) as Array<{ fail_count: number; success_count: number }>;
      const row = rows[0];
      if (!row) continue;
      await fetch(`${cfg.url}/rest/v1/campaigns?id=eq.${campaignId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: cfg.serviceRoleKey,
          Authorization: `Bearer ${cfg.serviceRoleKey}`,
        },
        body: JSON.stringify({ fail_count: row.fail_count + 1, success_count: row.success_count }),
      });
    }
  } catch {
    // best-effort
  }
}

/**
 * Registra um desfecho comercial (sem_interesse / reunião cancelada) via RPC
 * `consecom_agent_outcome`: atualiza o Kanban (status), aplica o bloqueio de
 * `no_interest_until` e grava em lead_status_history. O mesmo RPC usado pela
 * ferramenta do agente — assim o fluxo não depende do registry estar ativo.
 */
export async function recordAgentOutcome(args: {
  leadId?: string;
  phone?: string;
  outcome: 'sem_interesse' | 'reuniao_cancelada';
  motive?: string;
  noInterestMonths?: number;
}): Promise<boolean> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey) return false;
  try {
    const res = await fetch(`${cfg.url}/rest/v1/rpc/consecom_agent_outcome`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
      },
      body: JSON.stringify({
        p_lead_id: args.leadId ?? null,
        p_phone: args.phone ?? null,
        p_outcome: args.outcome,
        p_motive: args.motive ?? null,
        p_no_interest_months: args.noInterestMonths ?? 6,
      }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { ok?: boolean };
    return data?.ok === true;
  } catch {
    return false;
  }
}

/** True when this lead is in a prospecting state we should auto-reply to. */
/**
 * Atualiza campos analíticos do lead (score, interesse, serviço, problema).
 * Best-effort: nunca lança erro (não quebra o fluxo do agente).
 */
export async function updateLeadAnalytics(
  leadId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!leadId || !cfg.url || !cfg.serviceRoleKey) return;
  try {
    await fetch(`${cfg.url}/rest/v1/leads?id=eq.${leadId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${cfg.serviceRoleKey}`,
      },
      body: JSON.stringify(patch),
    });
  } catch {
    // best-effort: ignore
  }
}

// ---- conversation persistence (consecom_conversations table) ----

async function postConversationRow(cfg: ReturnType<typeof getSupabaseProspeccaoConfig>, row: Record<string, unknown>): Promise<void> {
  await fetch(`${cfg.url}/rest/v1/consecom_conversations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.serviceRoleKey,
      Authorization: `Bearer ${cfg.serviceRoleKey}`,
    },
    body: JSON.stringify(row),
  });
}

export async function appendConversationTurn(
  leadId: string,
  role: 'user' | 'assistant',
  content: string,
  agentModel?: string,
): Promise<void> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey) return;
  await postConversationRow(cfg, {
    lead_id: leadId,
    role,
    content,
    agent_model: agentModel ?? null,
  });
}

/**
 * Returns the persisted conversation transcript for a lead (oldest first).
 * Used by the autotreino to build a lesson from a real win/rejection.
 */
export async function fetchLeadTranscript(
  leadId: string,
  limit = 400,
): Promise<Array<{ role: string; content: string }>> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey || !leadId) return [];
  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/consecom_conversations?select=role,content,created_at` +
        `&lead_id=eq.${encodeURIComponent(leadId)}&order=created_at.asc&limit=${limit}`,
      { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
    );
    if (!res.ok) return [];
    return (await res.json()) as Array<{ role: string; content: string }>;
  } catch {
    return [];
  }
}

/** Dispatches the current turn to appendConversationTurn for the lead. */
export async function recordAssistantTurn(leadId: string, content: string, model?: string): Promise<void> {
  if (!leadId) return;
  await appendConversationTurn(leadId, 'assistant', content, model);
}

/**
 * Carrega as configurações do agente (agent_settings) e monta o texto de
 * DIRECTIVES que o webhook injeta no system prompt da IA.
 */
export async function loadAgentDirectives(): Promise<string | null> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey) return null;
  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/agent_settings?select=key,value&limit=100`,
      { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ key: string; value: unknown }>;
    if (rows.length === 0) return null;

    const map: Record<string, unknown> = {};
    for (const r of rows) map[r.key] = r.value;

    const parts: string[] = [];
    const greeting = typeof map.greeting === 'string' ? map.greeting : '';
    const objective = typeof map.objective === 'string' ? map.objective : '';
    const service = typeof map.service === 'string' ? map.service : '';
    const project = typeof map.project === 'string' ? map.project : '';
    const company = typeof map.company === 'string' ? map.company : '';

    if (company) parts.push(`SOBRE A EMPRESA (contexto que você domina para vender): ${company}`);
    if (greeting) parts.push(`SAUDAÇÃO inicial (use no primeiro contato): ${greeting}`);
    if (objective) parts.push(`OBJETIVO da conversa: ${objective}`);
    if (service) parts.push(`SERVIÇO/PROPOSTA que você apresenta: ${service}`);
    if (project) parts.push(`PROJETO/PROPOSTA específica: ${project}`);

    if (parts.length === 0) return null;
    return parts.join('\n');
  } catch {
    return null;
  }
}

/**
 * Carrega os nomes/aliases do vendedor humano (para classificar papéis nas
 * exportações). Prioriza a config `seller_names` (separados por vírgula);
 * se vazia, não usa nomes da antiga configuração de assinatura.
 */
export async function loadSellerNames(): Promise<string[]> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey) return [];
  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/agent_settings?select=key,value&limit=100`,
      { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
    );
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ key: string; value: unknown }>;
    if (rows.length === 0) return [];
    const map: Record<string, unknown> = {};
    for (const r of rows) map[r.key] = r.value;

    const sellers = typeof map.seller_names === 'string' ? map.seller_names : '';

    const names = sellers
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    if (names.length > 0) return names;
    return [];
  } catch {
    return [];
  }
}

/** Delay configurado para agrupar mensagens recebidas antes da resposta. */
export async function loadAiResponseDelaySeconds(): Promise<number> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey) return 0;
  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/agent_settings?select=value&key=eq.ai_response_delay_seconds&limit=1`,
      { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
    );
    if (!res.ok) return 0;
    const rows = (await res.json()) as Array<{ value: unknown }>;
    const value = Number(rows[0]?.value ?? 0);
    return Number.isFinite(value) ? Math.max(0, Math.min(300, value)) : 0;
  } catch {
    return 0;
  }
}

