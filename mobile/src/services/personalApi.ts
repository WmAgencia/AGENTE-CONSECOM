import { CapacitorHttp } from '@capacitor/core'
import { supabase } from '../lib/supabase'

// =====================================================================
// API do Assistente Pessoal (backend /api/personal/*).
// Ações reais de reuniões e pesquisa de leads, sempre escopadas por
// owner_user_id no servidor. Auth = token Supabase.
// =====================================================================

const BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ??
  'https://consecom-backend-production.up.railway.app'

export interface OwnMeeting {
  id: string
  name: string | null
  phone: string | null
  status: string | null
  meeting_at: string | null
  meeting_notes: string | null
}

export interface OwnLead {
  id: string
  name: string | null
  phone: string | null
  status: string | null
  meeting_at: string | null
}

export interface ActionResult {
  ok: boolean
  message?: string
  suggestions?: string[]
}

async function sessionToken(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Sessão expirada. Conecte o app pelo painel.')
  return token
}

function errorResult(res: { status: number; data: unknown }, fallback: string): ActionResult {
  const body = res.data as { message?: string; error?: string }
  return { ok: false, message: body?.message ?? body?.error ?? fallback }
}

export async function listMeetings(): Promise<OwnMeeting[]> {
  const token = await sessionToken()
  const res = await CapacitorHttp.get({
    url: `${BACKEND_URL}/api/personal/meetings`,
    headers: { Authorization: `Bearer ${token}` },
    connectTimeout: 30000,
    readTimeout: 60000,
  })
  if (res.status !== 200) throw new Error(errorResult(res, 'Falha ao listar reuniões').message)
  const body = res.data as { meetings?: OwnMeeting[] }
  return body.meetings ?? []
}

export async function searchLeads(q: string): Promise<OwnLead[]> {
  const token = await sessionToken()
  const res = await CapacitorHttp.get({
    url: `${BACKEND_URL}/api/personal/leads?q=${encodeURIComponent(q)}`,
    headers: { Authorization: `Bearer ${token}` },
    connectTimeout: 30000,
    readTimeout: 60000,
  })
  if (res.status !== 200) throw new Error(errorResult(res, 'Falha ao buscar leads').message)
  const body = res.data as { leads?: OwnLead[] }
  return body.leads ?? []
}

export async function reserveMeeting(
  leadId: string,
  startIso: string,
  durationMin?: number,
): Promise<ActionResult> {
  const token = await sessionToken()
  const res = await CapacitorHttp.post({
    url: `${BACKEND_URL}/api/personal/meetings/reserve`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { leadId, startIso, durationMin },
    connectTimeout: 30000,
    readTimeout: 60000,
  })
  const body = res.data as ActionResult
  if (res.status === 200) return body
  if (res.status === 409) return body
  return errorResult(res, 'Falha ao marcar reunião')
}

export async function rescheduleMeeting(
  leadId: string,
  startIso: string,
): Promise<ActionResult> {
  const token = await sessionToken()
  const res = await CapacitorHttp.post({
    url: `${BACKEND_URL}/api/personal/meetings/reschedule`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { leadId, startIso },
    connectTimeout: 30000,
    readTimeout: 60000,
  })
  const body = res.data as ActionResult
  if (res.status === 200) return body
  if (res.status === 409) return body
  return errorResult(res, 'Falha ao reagendar reunião')
}

export async function cancelMeeting(leadId: string, motive?: string): Promise<ActionResult> {
  const token = await sessionToken()
  const res = await CapacitorHttp.post({
    url: `${BACKEND_URL}/api/personal/meetings/cancel`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { leadId, motive },
    connectTimeout: 30000,
    readTimeout: 60000,
  })
  const body = res.data as ActionResult
  if (res.status === 200) return body
  if (res.status === 409) return body
  return errorResult(res, 'Falha ao cancelar reunião')
}

export async function realizeMeeting(leadId: string): Promise<ActionResult> {
  const token = await sessionToken()
  const res = await CapacitorHttp.post({
    url: `${BACKEND_URL}/api/personal/meetings/realize`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { leadId },
    connectTimeout: 30000,
    readTimeout: 60000,
  })
  const body = res.data as ActionResult
  if (res.status === 200) return body
  if (res.status === 409) return body
  return errorResult(res, 'Falha ao concluir reunião')
}
