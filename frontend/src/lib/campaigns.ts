import { supabase } from './supabase'
import { ApiRequestError } from './api'

export interface CampaignScheduleConfig {
  interval_min: number
  avg_seconds_per_msg: number
  min_duration_min: number
}

export interface ScheduleConflict {
  campaignId: string
  name: string
  status: string
  startIso: string
  endIso: string
}

export interface ValidateScheduleResult {
  ok: boolean
  reason?: string
  message?: string
  conflicts?: ScheduleConflict[]
  nextAvailableStart?: string
  durationMin?: number
  startMs?: number
}

export interface ScheduledCampaign {
  id: string
  name: string
  status: string
  scheduled_at: string | null
  lead_count: number | null
}

export interface CampaignCalendarItem {
  campaignId: string
  name: string
  status: string
  startIso: string
  endIso: string
  durationMin: number
  scheduledAt: string | null | undefined
  leadCount: number
}

/**
 * Implementação que injeta x-user-id em todas as chamadas (mesmo padrão do
 * lib/agenda.ts: o `api` helper exportado não aceita headers custom).
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

export const campaignSchedule = {
  getConfig(): Promise<{ config: CampaignScheduleConfig }> {
    return requestWithUser('/api/campaigns/schedule/config', { method: 'GET', cache: 'no-store' })
  },
  saveConfig(patch: Partial<CampaignScheduleConfig>): Promise<{ ok: boolean; config: CampaignScheduleConfig }> {
    return requestWithUser('/api/campaigns/schedule/config', { method: 'PUT', body: JSON.stringify(patch) })
  },
  list(): Promise<{ items: ScheduledCampaign[] }> {
    return requestWithUser('/api/campaigns/schedule', { method: 'GET', cache: 'no-store' })
  },
  next(opts: { campaignId: string; afterMs?: number }): Promise<{
    config: CampaignScheduleConfig
    durationMin: number
    nextAvailableStart: string
  }> {
    const sp = new URLSearchParams({ campaignId: opts.campaignId })
    if (opts.afterMs) sp.set('afterMs', String(opts.afterMs))
    return requestWithUser(`/api/campaigns/schedule/next?${sp.toString()}`, { method: 'GET', cache: 'no-store' })
  },
  validate(campaignId: string, startIso: string): Promise<ValidateScheduleResult> {
    return requestWithUser('/api/campaigns/schedule/validate', {
      method: 'POST',
      body: JSON.stringify({ campaignId, startIso }),
    })
  },
  schedule(campaignId: string, startIso: string): Promise<ValidateScheduleResult> {
    return requestWithUser('/api/campaigns/schedule', {
      method: 'POST',
      body: JSON.stringify({ campaignId, startIso }),
    })
  },
  cancel(campaignId: string): Promise<{ ok: boolean; message?: string }> {
    return requestWithUser(`/api/campaigns/schedule/${encodeURIComponent(campaignId)}`, { method: 'DELETE' })
  },
  calendar(start: string, end: string): Promise<{ items: CampaignCalendarItem[] }> {
    return requestWithUser(
      `/api/campaigns/schedule/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      { method: 'GET', cache: 'no-store' },
    )
  },
}
