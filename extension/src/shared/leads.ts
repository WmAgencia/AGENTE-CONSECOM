import { getStoredConfig, type StoredConfig } from './config'
import { normalizeBrazilianPhone } from './phone'

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
  /** URL do Instagram encontrada no card do Maps (heurística DOM). null se não achou. */
  instagram: string | null
  /** URL do Facebook encontrada no card do Maps (heurística DOM). null se não achou. */
  facebook: string | null
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
  /** ID do usuário (opcional, para multi-tenant quando capture_sessions tiver user_id). */
  userId?: string | null
  /** Timeout por requisição (ms). Default: 15000. */
  timeoutMs?: number
}

export interface ImportResult {
  ok: number
  failed: number
  firstError?: string
  errors: Array<{ index: number; name: string; error: string }>
}

export interface KnownResult {
  used: string[]
  noInterest: Record<string, string>
}

/** Envia uma chamada para o backend VIA SERVICE WORKER (sem CORS). */
async function backend(
  path: string,
  body: Record<string, unknown> | undefined,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const cfg = await getStoredConfig()
  const res = await chrome.runtime.sendMessage({
    type: 'consecom:api',
    path,
    method: 'POST',
    headers,
    body,
    extensionKey: cfg.extensionKey,
  })
  if (res?.ok === false && res?.status === 403) {
    return { ok: false, status: 403, data: { message: 'Extensão não vinculada. Baixe novamente a extensão no painel Vyntra.' } }
  }
  return res ?? { ok: false, status: 0, data: { message: 'Sem resposta do background.' } }
}

/** Exclui do banco os leads cujo place_id consta em `placeIds`. */
export async function deleteLeads(
  cfg: StoredConfig,
  placeIds: string[],
): Promise<{ ok: number; failed: number }> {
  if (placeIds.length === 0) return { ok: 0, failed: 0 }
  const res = await backend('/api/extension/delete', {
    placeIds,
    ownerUserId: cfg.ownerUserId,
  })
  if (!res.ok) return { ok: 0, failed: placeIds.length }
  const data = (res.data ?? {}) as { ok?: number; failed?: number }
  return { ok: Number(data.ok ?? 0), failed: Number(data.failed ?? 0) }
}

/** Importa os leads direto no backend (grava em `leads` com import_state=imported). */
export async function importLeads(
  cfg: StoredConfig,
  leads: ScrapedLead[],
  _onProgress?: (done: number, total: number) => void,
  opts?: ImportOptions,
): Promise<ImportResult> {
  if (!cfg.extensionKey || !cfg.ownerUserId) {
    return {
      ok: 0,
      failed: leads.length,
      firstError: 'Extensão não vinculada a uma conta Vyntra. Baixe novamente a extensão no painel.',
      errors: [],
    }
  }

  const contacts = leads.map((lead) => ({
    name: lead.name,
    phone: lead.phone ?? '',
    category: lead.category,
    website: lead.website,
    address: lead.address,
    city: lead.city,
    state: lead.state,
    rating: lead.rating,
    reviews: lead.reviews,
    latitude: lead.latitude,
    longitude: lead.longitude,
    place_id: lead.place_id,
    instagram: lead.instagram,
    facebook: lead.facebook,
  }))

  const res = await backend('/api/extension/import-leads', {
    ownerUserId: cfg.ownerUserId,
    leads: contacts,
    listName: `Importação ${new Date().toISOString().slice(0, 10)}`,
    source: opts?.source ?? 'google_maps',
    sourceDetail: opts?.sourceDetail ?? 'vyntra_prospector',
    tags: opts?.tags,
    prospectFilters: opts?.prospectFilters,
    score: opts?.score,
    serviceInterest: opts?.serviceInterest,
    prospectedAt: opts?.prospectedAt ?? new Date().toISOString(),
  })

  if (!res.ok) {
    const data = (res.data ?? {}) as { message?: string; error?: string }
    const message = data.message ?? data.error ?? `HTTP ${res.status}`
    console.error('[IMPORT] Backend import failed:', { status: res.status, message })
    return { ok: 0, failed: leads.length, firstError: message, errors: [] }
  }

  const data = (res.data ?? {}) as {
    summary?: { created?: number; errors?: number; duplicates?: number }
    firstError?: { body?: string }
  }
  const ok = Number(data.summary?.created ?? 0)
  const failed = Number(data.summary?.errors ?? 0)
  console.log('[IMPORT] Backend import response:', { status: res.status, ok, failed })
  leads.forEach((_lead, i) => _onProgress?.(i + 1, leads.length))
  return {
    ok,
    failed,
    firstError: typeof data.firstError?.body === 'string' ? data.firstError.body : undefined,
    errors: [],
  }
}

/** Consulta quais place_ids já estão no banco (usados) e o no_interest_until. */
export async function knownPlaceIds(cfg: StoredConfig, placeIds: string[]): Promise<KnownResult> {
  if (placeIds.length === 0) return { used: [], noInterest: {} }
  const res = await backend('/api/extension/known', { placeIds })
  if (!res.ok) return { used: [], noInterest: {} }
  const data = (res.data ?? {}) as KnownResult
  return {
    used: Array.isArray(data.used) ? data.used : [],
    noInterest: data.noInterest ?? {},
  }
}
