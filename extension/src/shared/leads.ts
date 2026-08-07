import { getClient, mediaPublicUrl, type StoredConfig } from './config'

export interface ScrapedLead {
  name: string
  phone: string | null
  category: string | null
  website: string | null
  address: string | null
  city: string | null
  state: string | null
  rating: number | null
  reviews: number | null
  latitude: number | null
  longitude: number | null
  place_id: string | null
  maps_url: string | null
}

/** Exclui do banco os leads cujo place_id consta em `placeIds`. */
export async function deleteLeads(cfg: StoredConfig, placeIds: string[]): Promise<{ ok: number; failed: number }> {
  const client = getClient(cfg)
  if (!client) return { ok: 0, failed: placeIds.length }

  let ok = 0
  let failed = 0
  for (const id of placeIds) {
    const { error } = await client.from('leads').delete().eq('place_id', id)
    if (error) failed++
    else ok++
  }
  return { ok, failed }
}

export async function importLeads(
  cfg: StoredConfig,
  leads: ScrapedLead[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ ok: number; failed: number; firstError?: string }> {
  const client = getClient(cfg)
  if (!client) return { ok: 0, failed: leads.length, firstError: 'Configure a URL e a chave anon do Supabase.' }

  // Cada importação vira uma "sessão de captura" (para agrupar na Guia Leads).
  let sessionId: string | null = null
  if (leads.length > 0) {
    const { data, error } = await client.from('capture_sessions').insert({ imported_by: 'extension' }).select('id').single()
    if (!error && data) sessionId = data.id
  }

  let ok = 0
  let failed = 0
  let firstError: string | undefined

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i]
    const row: Record<string, unknown> = {
      name: lead.name || null,
      phone: lead.phone || null,
      category: lead.category || null,
      website: lead.website || null,
      address: lead.address || null,
      city: lead.city || null,
      state: lead.state || null,
      rating: lead.rating,
      reviews: lead.reviews,
      latitude: lead.latitude,
      longitude: lead.longitude,
      place_id: lead.place_id || null,
      niche: 'maps',
      session_id: sessionId,
    }

    const { error } = await client.from('leads').upsert(row, {
      onConflict: 'place_id',
      ignoreDuplicates: false,
    })

    if (error) {
      failed++
      if (!firstError) firstError = error.message
    } else {
      ok++
    }
    onProgress?.(i + 1, leads.length)
  }

  return { ok, failed, firstError }
}