import { getClient, saveConfig, type StoredConfig } from './config'
import { normalizeBrazilianPhone } from './phone'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuthError, PostgrestError } from '@supabase/supabase-js'

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
let importedFlowSchemaCache: boolean | null = null
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

const CONTACTS_API = 'https://consecom-backend-production.up.railway.app'

async function refreshBackendSession(cfg: StoredConfig): Promise<string | null> {
  if (!cfg.refreshToken) return cfg.accessToken ?? null
  try {
    const response = await fetch(`${CONTACTS_API}/api/contacts/refresh-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: cfg.refreshToken }),
    })
    const body = await response.text()
    const data = body ? JSON.parse(body) as { accessToken?: string; refreshToken?: string; message?: string } : {}
    if (!response.ok || !data.accessToken || !data.refreshToken) {
      console.error('[IMPORT] Sessão não pôde ser renovada:', { status: response.status, message: data.message ?? body.slice(0, 300) })
      return null
    }
    cfg.accessToken = data.accessToken
    cfg.refreshToken = data.refreshToken
    await saveConfig(cfg)
    return data.accessToken
  } catch (error) {
    console.error('[IMPORT] Erro ao renovar sessão:', { message: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/** Usa o backend quando a chave anon local foi revogada/rotacionada. */
async function importThroughBackend(
  cfg: StoredConfig,
  leads: ScrapedLead[],
  onProgress?: (done: number, total: number) => void,
  opts?: ImportOptions,
): Promise<ImportResult | null> {
  if (!cfg.accessToken) return null
  if (cfg.refreshToken && !(await refreshBackendSession(cfg))) {
    return { ok: 0, failed: leads.length, firstError: 'Sessão Vyntra expirada. Clique em “Sincronizar sessão do Vyntra” na extensão.', errors: [] }
  }
  const endpoint = `${CONTACTS_API}/api/contacts/import`
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.accessToken}`,
      },
      body: JSON.stringify({
        listName: `Importação ${new Date().toISOString().slice(0, 10)}`,
        contacts: leads.map((lead) => ({
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
          whatsapp: lead.whatsapp,
        })),
      }),
    })
    const body = await response.text()
    let data: { summary?: { created?: number; errors?: number }; message?: string; error?: string; firstError?: { status?: number; body?: string } } = {}
    try { data = body ? JSON.parse(body) as typeof data : {} } catch { /* diagnóstico usa o texto bruto abaixo */ }
    if (!response.ok) {
      const message = data.message ?? data.error ?? (body.trim().slice(0, 500) || `HTTP ${response.status}`)
      console.error('[IMPORT] Backend import failed:', { endpoint, status: response.status, message })
      return { ok: 0, failed: leads.length, firstError: message, errors: [] }
    }
    const ok = Number(data.summary?.created ?? 0)
    const failed = Number(data.summary?.errors ?? 0)
    console.log('[IMPORT] Backend import response:', { endpoint, status: response.status, ok, failed })
    leads.forEach((_lead, i) => onProgress?.(i + 1, leads.length))
    const firstError = data.firstError?.body
    if (failed > 0) console.error('[IMPORT] Backend reported batch errors:', data.firstError)
    return { ok, failed, firstError, errors: [] }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[IMPORT] Backend import transport error:', { endpoint, message })
    return { ok: 0, failed: leads.length, firstError: message, errors: [] }
  }
}

/** O fluxo Importados exige as colunas introduzidas pela migration v19. */
async function dbSupportsImportedFlowColumns(client: SupabaseClient): Promise<boolean> {
  if (importedFlowSchemaCache !== null) return importedFlowSchemaCache
  const { error } = await client
    .from('leads')
    .select('owner_user_id,import_state,imported_at,phone_normalized')
    .limit(1)
    .maybeSingle()
  importedFlowSchemaCache = !error
  console.log('[IMPORT] DB schema Importados (v19):', importedFlowSchemaCache)
  if (error) {
    console.error('[IMPORT] DB schema Importados error:', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    })
  }
  return importedFlowSchemaCache
}

function logPostgrestError(prefix: string, error: (PostgrestError | AuthError) | null): void {
  if (!error) return
  const detail = error as Partial<PostgrestError>
  console.error(prefix, {
    code: error.code,
    message: error.message,
    details: detail.details,
    hint: detail.hint,
  })
}

export async function importLeads(
  cfg: StoredConfig,
  leads: ScrapedLead[],
  onProgress?: (done: number, total: number) => void,
  opts?: ImportOptions,
): Promise<ImportResult> {
  const backendResult = await importThroughBackend(cfg, leads, onProgress, opts)
  if (backendResult) return backendResult

  const client = getClient(cfg)
  if (!client) return { ok: 0, failed: leads.length, firstError: 'Configure a URL e a chave anon do Supabase.', errors: [] }
  const { data: authData, error: authError } = await client.auth.getUser()
  if (authError || !authData.user) {
    logPostgrestError('[IMPORT] Auth getUser failed:', authError)
    return { ok: 0, failed: leads.length, firstError: 'Cole um access token válido da sessão Vyntra.', errors: [] }
  }

  const supportsImportedFlow = await dbSupportsImportedFlowColumns(client)
  if (!supportsImportedFlow) {
    const message = 'O banco não possui as colunas do fluxo Importados (migration v19 pendente ou schema cache desatualizado).'
    console.error('[IMPORT] Importação interrompida:', message)
    return { ok: 0, failed: leads.length, firstError: message, errors: [] }
  }

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
    // Reset da lista temporária de Importados: arquivar (distributed) leads
    // antigos 'imported' do mesmo owner que ainda não foram distribuídos,
    // para que a nova sessão não se misture com a anterior. Histórico
    // (distributed/blocked) permanece intacto.
    try {
      await client
        .from('leads')
        .update({ import_state: 'distributed', updated_at: new Date().toISOString() })
        .eq('owner_user_id', authData.user.id)
        .eq('import_state', 'imported')
    } catch {
      // best-effort: se a coluna não existir (migration pendente), ignora.
    }
    const sessInsert: Record<string, unknown> = { imported_by: 'extension' }
      if (supportsV8) sessInsert.user_id = opts?.userId ?? authData.user.id
    const { data, error } = await client.from('capture_sessions').insert(sessInsert).select('id').single()
    if (error) {
      logPostgrestError('[IMPORT] capture_sessions INSERT best-effort failed (continuing without session):', error)
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
      // Normaliza na origem (+55/DDD/só dígitos). Ao falhar (número inválido)
      // mantém o valor cru para o usuário ver/corrigir; o backend reclassifica.
      phone: normalizeBrazilianPhone(lead.phone) ?? (lead.phone || null),
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
      owner_user_id: authData.user.id,
      import_state: 'imported',
      imported_at: prospectedAt,
      phone_normalized: normalizeBrazilianPhone(lead.phone) ?? null,
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
        logPostgrestError(`[IMPORT] Failed lead: ${lead.name}`, error)
      } else {
        ok++
        console.log(`[IMPORT] OK: ${lead.name} | place_id: ${lead.place_id}`)
      }
    } catch (e) {
      failed++
      const msg = e instanceof Error ? e.message : String(e)
      if (!firstError) firstError = msg
      errors.push({ index: i, name: lead.name, error: msg })
      console.error(`[IMPORT] Exception lead: ${lead.name}`, { message: msg })
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
  if (lastError) logPostgrestError(`[IMPORT] Failed after ${maxAttempts} attempts:`, lastError)
  return { error: lastError }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
