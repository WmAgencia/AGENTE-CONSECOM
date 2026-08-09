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

export interface LeadRow {
  id: string;
  name: string | null;
  phone: string | null;
  status: string | null;
  niche: string | null;
  category: string | null;
}

// Apenas responde leads que já passaram da campanha (todas as mensagens
// programadas enviadas -> status "enviado") ou que já estão em conversa real.
// - "na_fila": campanha ainda disparando -> NÃO responder (evita conversar
//   com uma mensagem programada que acabou de chegar).
// - "sem_interesse": já recusou -> NÃO responder.
// - "reuniao_marcada"/"reuniao_cancelada": segue respondendo para o lead
//   poder ajustar/cancelar a reunião.
const PROSPECTING_STATUSES = ['enviado', 'conversando', 'remarketing', 'reuniao_marcada', 'reuniao_cancelada'];

// Normaliza um JID/número para uma forma comparável:
//  strip @s.whatsapp.net, remove tudo que não for dígito.
function toDigits(jid: string): string {
  return jid.replace(/@.*$/, '').replace(/\D+/g, '');
}

/** Procura um lead pelo número (variando a forma de dígitos). */
export async function findLeadByPhone(jid: string): Promise<LeadRow | null> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey) return null;

  const digits = toDigits(jid);
  if (!digits) return null;

  // The stored phone may have DDD/55 or not. We query all candidates we build.
  const candidates = buildPhoneCandidates(digits);

  for (const cand of candidates) {
    const res = await fetch(
      `${cfg.url}/rest/v1/leads?select=id,name,phone,status,niche,category&phone=eq.${encodeURIComponent(cand)}`,
      { headers: { apikey: cfg.serviceRoleKey, Authorization: `Bearer ${cfg.serviceRoleKey}` } },
    );
    if (res.ok) {
      const rows = (await res.json()) as LeadRow[];
      if (rows.length > 0) return rows[0];
    }
  }
  return null;
}

function buildPhoneCandidates(digits: string): string[] {
  const out = new Set<string>();
  out.add(digits);
  if (digits.length === 13 && digits.startsWith('55')) out.add(digits.slice(2));
  if (digits.length === 12 && digits.startsWith('55')) out.add(digits.slice(2));
  if (digits.length === 11) out.add(digits.slice(2)); // remove DDD -> 9 digits
  return Array.from(out);
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

/** True when this lead is in a prospecting state we should auto-reply to. */
export function isProspectingStatus(status: string | null | undefined): boolean {
  return !!status && PROSPECTING_STATUSES.includes(status);
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
    const agentName = typeof map.agent_name === 'string' ? map.agent_name : '';
    const company = typeof map.company === 'string' ? map.company : '';

    if (agentName) parts.push(`SEU NOME é ${agentName}. Você se apresenta e assina as mensagens como ${agentName}.`);
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

/** Carrega o nome configurado do agente (para assinar as mensagens). */
export async function loadAgentName(): Promise<string | null> {
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
    const name = typeof map.agent_name === 'string' ? map.agent_name : null;
    return name;
  } catch {
    return null;
  }
}

/** Prefixa o nome do agente em *nome* acima da mensagem. Sem nome, devolve o texto puro. */
const TRAILING_SIGNATURE_RE = /\s*[\u2013\u2014-]\s*[A-Za-zÀ-ÿ]{2,20}\s*$/;

export function formatAgentSignature(text: string, name: string | null): string {
  let body = (text ?? '').trim();
  body = body.replace(TRAILING_SIGNATURE_RE, '').trim();
  if (!name || !name.trim()) return body;
  return `*${name.trim()}*\n${body}`;
}
