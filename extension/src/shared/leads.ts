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
  /** URL do Instagram encontrada no card do Maps (heurística DOM). null se não achou. */
  instagram: string | null
  /** URL do Facebook encontrada no card do Maps (heurística DOM). null se não achou. */
  facebook: string | null
  /** WhatsApp detectado (telefone com whatsapp). null se não achou. */
  whatsapp: string | null
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

export interface ImportOptions {
  /** Origem do lead (default: 'google_maps'). */
  source?: string
  /** Detalhe da origem (default: 'vyntra_prospector'). */
  sourceDetail?: string
  /** Tags automáticas (ex: ['Google Maps','Sem Site','Alta Oportunidade']). */
  tags?: string[]
  /** Snapshot dos filtros usados na prospecção automática. */
  prospectFilters?: Record<string, unknown>
  /** Vyntra Score 0..100 (gravado em leads.score). */
  score?: number
  /** Fatores do score (gravado em leads.score_factors). */
  scoreFactors?: Record<string, unknown>
  /** Serviço de interesse: site | landing | sistema | outro | null. */
  serviceInterest?: string | null
  /** Data da prospecção (ISO). Default: now(). */
  prospectedAt?: string
}

export async function importLeads(
  cfg: StoredConfig,
  leads: ScrapedLead[],
  onProgress?: (done: number, total: number) => void,
  opts?: ImportOptions,
): Promise<{ ok: number; failed: number; firstError?: string }> {
  const client = getClient(cfg)
  if (!client) return { ok: 0, failed: leads.length, firstError: 'Configure a URL e a chave anon do Supabase.' }

  // Cada importação vira uma "sessão de captura" (para agrupar na Guia Leads).
  let sessionId: string | null = null
  if (leads.length > 0) {
    const { data, error } = await client.from('capture_sessions').insert({ imported_by: 'extension' }).select('id').single()
    if (!error && data) sessionId = data.id
  }

  const source = opts?.source ?? 'google_maps'
  const sourceDetail = opts?.sourceDetail ?? 'vyntra_prospector'
  const prospectedAt = opts?.prospectedAt ?? new Date().toISOString()

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
      source,
      source_detail: sourceDetail,
      instagram: lead.instagram || null,
      facebook: lead.facebook || null,
      has_website: !!lead.website,
      prospected_at: prospectedAt,
    }
    if (opts?.tags) row.tags = opts.tags
    if (opts?.prospectFilters) row.prospect_filters = opts.prospectFilters
    if (opts?.score != null) row.score = opts.score
    if (opts?.scoreFactors) row.score_factors = opts.scoreFactors
    if (opts?.serviceInterest != null) row.service_interest = opts.serviceInterest

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