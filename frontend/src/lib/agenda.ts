import { supabase } from './supabase'
import { ApiRequestError } from './api'

export interface WeeklySlot {
  day: number
  start: number
  end: number
}

export interface AgendaSettings {
  duration_min: number
  gap_min: number
  future_days: number
  timezone: string
}

export interface AgendaBlock {
  id: string
  start_at: string
  end_at: string
  reason?: string | null
}

export interface AgendaMeeting {
  leadId: string
  name: string | null
  phone: string | null
  status: string
  meeting_at: string | null
  meeting_notes: string | null
  meeting_outcome: string | null
  durationMin: number
  start: number
  end: number
}

export interface AgendaData {
  settings: AgendaSettings
  slots: WeeklySlot[]
  blocks: AgendaBlock[]
  meetings: AgendaMeeting[]
  generatedAt: string
}

export interface AvailableSlot {
  start: string
  end: string
  day: string
  time: string
}

export interface ReserveResult {
  ok: boolean
  reason?: string
  message?: string
  suggestions?: string[]
  start?: string
}

/**
 * Implementação que injeta x-user-id em todas as chamadas (o `api` helper
 * exportado em api.ts não aceita headers custom; replicamos o request()).
 */
async function requestWithUser<T>(path: string, init?: RequestInit): Promise<T> {
  const token = (await supabase.auth.getSession()).data.session?.access_token ?? null
  const uid = (await supabase.auth.getUser()).data?.user?.id ?? null
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(uid ? { 'x-user-id': uid } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  }
  const res = await fetch(`${import.meta.env.VITE_BACKEND_URL ?? 'https://consecom-backend-production.up.railway.app'}${path}`, {
    ...init,
    headers,
  })
  const text = await res.text()
  const data = text ? (JSON.parse(text) as T & { error?: string; message?: string; statusCode?: number }) : ({} as T)
  if (!res.ok) {
    throw new ApiRequestError(res.status, data as never)
  }
  return data
}

export const agenda = {
  getData(start: string, end: string): Promise<AgendaData> {
    return requestWithUser<AgendaData>(
      `/api/agenda/data?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      { method: 'GET', cache: 'no-store' },
    )
  },
  getSlots(opts?: { start?: string; end?: string; durationMin?: number }): Promise<{ slots: AvailableSlot[] }> {
    const sp = new URLSearchParams()
    if (opts?.start) sp.set('start', opts.start)
    if (opts?.end) sp.set('end', opts.end)
    if (opts?.durationMin) sp.set('durationMin', String(opts.durationMin))
    const qs = sp.toString()
    return requestWithUser<{ slots: AvailableSlot[] }>(`/api/agenda/slots${qs ? `?${qs}` : ''}`, { method: 'GET', cache: 'no-store' })
  },
  getSettings(): Promise<{ settings: AgendaSettings; slots: WeeklySlot[]; blocks: AgendaBlock[] }> {
    return requestWithUser(`/api/agenda/settings`, { method: 'GET', cache: 'no-store' })
  },
  saveSettings(patch: Partial<AgendaSettings>): Promise<{ ok: boolean; settings: AgendaSettings }> {
    return requestWithUser('/api/agenda/settings', { method: 'PUT', body: JSON.stringify(patch) })
  },
  saveSlots(slots: WeeklySlot[]): Promise<{ ok: boolean; slots: WeeklySlot[] }> {
    return requestWithUser('/api/agenda/slots', { method: 'PUT', body: JSON.stringify({ slots }) })
  },
  addBlock(input: { start_at: string; end_at: string; reason?: string }): Promise<{ ok: boolean; block: AgendaBlock }> {
    return requestWithUser('/api/agenda/blocks', { method: 'POST', body: JSON.stringify(input) })
  },
  removeBlock(id: string): Promise<{ ok: boolean }> {
    return requestWithUser(`/api/agenda/blocks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  reserve(input: {
    leadId: string
    startIso: string
    durationMin?: number
    notes?: string
    notifyAdmin?: boolean
  }): Promise<ReserveResult> {
    return requestWithUser('/api/agenda/reserve', { method: 'POST', body: JSON.stringify(input) })
  },
  edit(input: {
    leadId: string
    startIso?: string
    durationMin?: number
    notes?: string
  }): Promise<ReserveResult> {
    return requestWithUser('/api/agenda/edit', { method: 'POST', body: JSON.stringify(input) })
  },
  cancel(leadId: string, motive?: string): Promise<{ ok: boolean; message?: string }> {
    return requestWithUser('/api/agenda/cancel', { method: 'POST', body: JSON.stringify({ leadId, motive }) })
  },
  realized(leadId: string): Promise<{ ok: boolean; message?: string }> {
    return requestWithUser('/api/agenda/realized', { method: 'POST', body: JSON.stringify({ leadId }) })
  },
}
