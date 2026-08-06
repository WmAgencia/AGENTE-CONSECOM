/**
 * Supabase access for the prospection webhook.
 *
 * Uses the service role key (server-side only) to:
 *   - find a lead by WhatsApp JID / phone number
 *   - update a lead's status (api: flagging "respondendo")
 *   - persist conversation turns for a lead (consecom_conversations)
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

const PROSPECTING_STATUSES = ['na_fila', 'mensagem_enviada', 'respondendo'];

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