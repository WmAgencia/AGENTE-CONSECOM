import { getSupabaseProspeccaoConfig } from '../config/env.js';

export type FollowUpStatus = 'agendado' | 'processando' | 'enviado' | 'falhou' | 'cancelado';
export type FollowUpSource = 'ia' | 'operador';

export interface FollowUpRow {
  id: string;
  lead_id: string;
  owner_user_id: string | null;
  scheduled_date: string;
  scheduled_time: string | null;
  message: string;
  status: FollowUpStatus;
  source: FollowUpSource;
  connection_id: string | null;
  connection_instance: string | null;
  conversation_id: string | null;
  origin_context: string | null;
  failure_reason: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  lead?: { id: string; name: string | null; phone: string | null; status: string | null };
}

function cfg() {
  const c = getSupabaseProspeccaoConfig();
  return c.url && c.serviceRoleKey ? c : null;
}

function headers(json = false): Record<string, string> {
  const c = getSupabaseProspeccaoConfig();
  return json
    ? { apikey: c.serviceRoleKey, Authorization: `Bearer ${c.serviceRoleKey}`, 'Content-Type': 'application/json' }
    : { apikey: c.serviceRoleKey, Authorization: `Bearer ${c.serviceRoleKey}` };
}

export interface CreateFollowUpInput {
  lead_id: string;
  owner_user_id?: string | null;
  scheduled_date: string;
  scheduled_time?: string | null;
  message: string;
  source: FollowUpSource;
  connection_id?: string | null;
  connection_instance?: string | null;
  conversation_id?: string | null;
  origin_context?: string | null;
  idempotency_key: string;
}

export async function createFollowUp(input: CreateFollowUpInput): Promise<FollowUpRow | null> {
  const c = cfg();
  if (!c) return null;
  const r = await fetch(`${c.url}/rest/v1/follow_ups`, {
    method: 'POST',
    headers: { ...headers(true), Prefer: 'return=representation' },
    body: JSON.stringify(input),
  });
  if (!r.ok) return null;
  const rows = (await r.json()) as FollowUpRow[];
  return rows[0] ?? null;
}

export async function listFollowUps(opts?: { leadId?: string; start?: string; end?: string; ownerId?: string }): Promise<FollowUpRow[]> {
  const c = cfg();
  if (!c) return [];
  const params = new URLSearchParams({ select: '*,lead:leads(id,name,phone,status)', order: 'scheduled_date.asc,scheduled_time.asc,created_at.asc' });
  if (opts?.leadId) params.set('lead_id', `eq.${opts.leadId}`);
  if (opts?.start) params.set('scheduled_date', `gte.${opts.start}`);
  if (opts?.end) params.set('scheduled_date', `lte.${opts.end}`);
  if (opts?.ownerId) params.set('owner_user_id', `eq.${opts.ownerId}`);
  const r = await fetch(`${c.url}/rest/v1/follow_ups?${params}`, { headers: headers() });
  return r.ok ? (await r.json()) as FollowUpRow[] : [];
}

export async function updateFollowUp(id: string, patch: Partial<Pick<FollowUpRow, 'scheduled_date' | 'scheduled_time' | 'message' | 'status' | 'connection_id' | 'connection_instance' | 'failure_reason' | 'sent_at'>>): Promise<boolean> {
  const c = cfg();
  if (!c) return false;
  const r = await fetch(`${c.url}/rest/v1/follow_ups?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: headers(true), body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  return r.ok;
}

export async function claimDueFollowUp(id: string): Promise<boolean> {
  const c = cfg();
  if (!c) return false;
  const r = await fetch(`${c.url}/rest/v1/follow_ups?id=eq.${encodeURIComponent(id)}&status=in.("agendado","processando")`, {
    method: 'PATCH',
    headers: { ...headers(true), Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'processando', updated_at: new Date().toISOString() }),
  });
  if (!r.ok) return false;
  const rows = (await r.json().catch(() => [])) as FollowUpRow[];
  return rows.length > 0;
}

export async function getDueFollowUps(now = new Date()): Promise<FollowUpRow[]> {
  const date = now.toISOString().slice(0, 10);
  const rows = await listFollowUps({ end: date });
  const nowMs = now.getTime();
  return rows.filter((row) => {
    if (!['agendado', 'processando'].includes(row.status) || !row.scheduled_time) return false;
    if (row.status === 'processando' && Date.now() - Date.parse(row.updated_at) < 10 * 60_000) return false;
    const due = new Date(`${row.scheduled_date}T${row.scheduled_time}-03:00`).getTime();
    return Number.isFinite(due) && due <= nowMs;
  });
}
