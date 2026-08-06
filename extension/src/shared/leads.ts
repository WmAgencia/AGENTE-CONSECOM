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

export async function importLeads(
  cfg: StoredConfig,
  leads: ScrapedLead[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ ok: number; failed: number; firstError?: string }> {
  const client = getClient(cfg)
  if (!client) return { ok: 0, failed: leads.length, firstError: 'Configure a URL e a chave anon do Supabase.' }

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
      status: 'novo',
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