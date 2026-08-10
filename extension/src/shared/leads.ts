import { getClient, type StoredConfig } from './config'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PostgrestError } from '@supabase/supabase-js'

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
  /** ID do usuário (opcional, para multi-tenant quando captura_sessions tiver user_id). */
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

/** Campos que a tabela `leads` tem APÓS as migrations v6/v8. */
const V8_COLUMNS = [
  'source',
  'source_detail',
  'instagram',
  'facebook',
  'tags',
  'prospect_filters',
  'prospected_at',
  'has_website',
  'score',
  'score_factors',
  'service_interest',
  'strategy_id',
  'interest_level',
  'has_system',
  'problem_identified',
  'problem_description',
  'objection',
  'meeting_outcome',
  'sale_status',
  'loss_reason',
]

/** Cache de schema: true se as colunas v8 (source/instagram/facebook/tags/...) são suportadas. */
let schemaCache: boolean | null = null
async function dbSupportsV8Columns(client: SupabaseClient): Promise<boolean> {
  if (schemaCache !== null) return schemaCache
  // Probe explícito: pede um registro usando a coluna `source`.
  // Se ela não existir, PostgREST retorna 400 com code 42703 (Postgres) ou
  // PGRST204 (PostgREST schema cache desatualizado).
  const { error } = await client.from('leads').select('source').limit(1).maybeSingle()
  const supported = !error || (error.code !== '42703' && error.code !== 'PGRST204')
  schemaCache = supported
  console.log('[IMPORT] DB schema v8 (source/instagram/facebook/tags...):', supported)
  if (error && !supported) {
    console.log('[IMPORT] DB schema probe error:', error.code, error.message)
  }
  return supported
}

export async function importLeads(
  cfg: StoredConfig,
  leads: ScrapedLead[],
  onProgress?: (done: number, total: number) => void,
  opts?: ImportOptions,
): Promise<ImportResult> {
  const client = getClient(cfg)
  if (!client) return { ok: 0, failed: leads.length, firstError: 'Configure a URL e a chave anon do Supabase.', errors: [] }

  // Detecta compatibilidade de schema (v6+v8 aplicadas vs. apenas base).
  // Se as colunas v8 (source, facebook, instagram, tags, ...) não existirem,
  // enviamos um payload reduzido com apenas colunas do schema base para não
  // tombar todos os INSERTs com 42703/PGRST204. A feature detect é por probe
  // SELECT explícito na coluna `source`.
  const supportsV8 = await dbSupportsV8Columns(client)

  console.log('[IMPORT] Starting import')
  console.log('[IMPORT] Leads:', leads.length)
  console.log('[IMPORT] Endpoint:', `${cfg.supabaseUrl}/rest/v1/leads`)
  console.log('[IMPORT] Schema v8 columns:', supportsV8 ? 'available (full payload)' : 'missing (base-only payload)')

  // Cada importação vira uma "sessão de captura" (para agrupar na Guia Leads).
  // Tratamento best-effort: se capture_sessions INSERT falhar (ex.: RLS sem
  // policy anon_insert, ou tabela sem user_id), seguimos com sessionId=null.
  // Os leads ainda são importados — apenas sem agrupamento por sessão.
  let sessionId: string | null = null
  if (leads.length > 0) {
    const sessInsert: Record<string, unknown> = { imported_by: 'extension' }
    if (supportsV8) sessInsert.user_id = opts?.userId ?? null
    const { data, error } = await client.from('capture_sessions').insert(sessInsert).select('id').single()
    if (error) {
      console.log('[IMPORT] capture_sessions INSERT best-effort failed (continuing without session):', error.code, error.message)
      console.log('[IMPORT]   Hint: aplique a migration v9 (capture_sessions_anon_insert policy) no Supabase.')
    }
    if (!error && data) {
      sessionId = data.id
      console.log('[IMPORT] capture session:', sessionId)
    }
  }

  const source = opts?.source ?? 'google_maps'
  const sourceDetail = opts?.sourceDetail ?? 'vyntra_prospector'
  const prospectedAt = opts?.prospectedAt ?? new Date().toISOString()

  let ok = 0
  let failed = 0
  let firstError: string | undefined
  const errors: Array<{ index: number; name: string; error: string }> = []

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i]
    // Mapper normalizer: ScrapedLead (Google Maps) → row compatível com leads.
    // Colunas base SEMPRE presentes no schema. Colunas v6/v8 só se o DB as
    // suportar (feature-detect via probe).
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

    if (supportsV8) {
      row.source = source
      row.source_detail = sourceDetail
      row.instagram = lead.instagram || null
      row.facebook = lead.facebook || null
      row.has_website = !!lead.website
      row.prospected_at = prospectedAt
      if (opts?.tags) row.tags = opts.tags
      if (opts?.prospectFilters) row.prospect_filters = opts.prospectFilters
      if (opts?.score != null) row.score = opts.score
      if (opts?.scoreFactors) row.score_factors = opts.scoreFactors
      if (opts?.serviceInterest != null) row.service_interest = opts.serviceInterest
    }

    try {
      const { error } = await upsertWithRetry(client, row)
      if (error) {
        failed++
        const msg = error.message
        if (!firstError) firstError = msg
        errors.push({ index: i, name: lead.name, error: msg })
        console.log(`[IMPORT] Failed lead: ${lead.name} | Error reason: ${msg}`)
      } else {
        ok++
        console.log(`[IMPORT] OK: ${lead.name} | place_id: ${lead.place_id}`)
      }
    } catch (e) {
      failed++
      const msg = e instanceof Error ? e.message : String(e)
      if (!firstError) firstError = msg
      errors.push({ index: i, name: lead.name, error: msg })
      console.log(`[IMPORT] Exception lead: ${lead.name} | Error reason: ${msg}`)
    }
    onProgress?.(i + 1, leads.length)
  }

  console.log('[IMPORT] Response summary: ok=', ok, 'failed=', failed)
  if (firstError) console.log('[IMPORT] firstError:', firstError)
  return { ok, failed, firstError, errors }
}

/**
 * Upsert com retry controlado apenas para erros TRANSIENTES (rede/5xx).
 * Não retried: erros determinísticos (payload inválido = 4xx não-retryável).
 */
async function upsertWithRetry(
  client: SupabaseClient,
  row: Record<string, unknown>,
  maxAttempts = 3,
): Promise<{ error: PostgrestError | null }> {
  let lastError: PostgrestError | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { error } = await client.from('leads').upsert(row, {
      onConflict: 'place_id',
      ignoreDuplicates: false,
    })
    if (!error) return { error: null }
    lastError = error
    // Retry apenas para erros TRANSIENTES: timeout, rede, 5xx, 429.
    // Erros determinísticos (coluna inexistente = PGRST204, payload inválido)
    // NÃO recebem retry — já falham de cara e de novo não resolve.
    const transient =
      error.code === 'PGRST302' ||
      error.message.toLowerCase().includes('timeout') ||
      error.message.toLowerCase().includes('network') ||
      error.message.toLowerCase().includes('econn')
    if (!transient || attempt === maxAttempts) break
    console.log(`[IMPORT] Retry attempt ${attempt}/${maxAttempts} for place_id=${row.place_id}`)
    await sleep(Math.pow(2, attempt) * 300) // backoff exponencial
  }
  lastError && console.log(`[IMPORT] Failed after ${maxAttempts} attempts: ${lastError.message}`)
  return { error: lastError }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}