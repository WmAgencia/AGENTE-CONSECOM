/**
 * Adaptador Vyntra Prospector — WebMotors (webmotors.com.br/carros/...).
 *
 * A API de busca pública retorna os anúncios SEM telefone. O telefone da loja
 * é exposto apenas pelo endpoint de detalhe:
 *   GET /api/detail/phone/{dealer|private-seller}/car/{marca}/{modelo}/{versao}/{ano}/{id}
 * Este adaptador pagina a busca (100 por página), deduplica por VENDEDOR
 * (Id + SellerType) e, para cada loja/concessionária única, busca o telefone
 * usando o primeiro anúncio dela. A página de listagem roda no browser do
 * usuário, então as chamadas same-origin passam no anti-bot (PerimeterX).
 *
 * API: https://www.webmotors.com.br/api/search/car + /api/detail/phone/...
 */
import { classifyBrazilianPhone } from '../shared/phone'

const API = 'https://www.webmotors.com.br/api'

interface SearchHit {
  UniqueId: number
  Specification?: {
    Title?: string | null
    Make?: { Value?: string | null } | null
    Model?: { Value?: string | null } | null
    Version?: { Value?: string | null } | null
    YearFabrication?: string | number | null
  } | null
  Seller?: {
    Id: number
    SellerType?: string | null
    City?: string | null
    State?: string | null
    FantasyName?: string | null
    AdType?: { Value?: string | null } | null
    Localization?: Array<{
      Neighborhood?: string | null
      AbbrState?: string | null
    }> | null
  } | null
}

interface SearchResponse {
  SearchResults?: SearchHit[]
  Count?: number
  Pagination?: { PageCurrent?: number; PageTotal?: number }
}

export interface WebMotorsContact {
  key: string
  name: string
  phone: string
  whatsapp: boolean
  city: string | null
  state: string | null
  dealerId: number
}

export interface WebMotorsProspectOptions {
  max: number
  pageSize?: number
  signal?: { cancelled: boolean }
  onResult: (c: WebMotorsContact) => void
  onProgress: (msg: string) => void
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

/** Monta o endpoint de telefone a partir de um anúncio. */
function slugPart(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function phoneUrlFor(hit: SearchHit): string | null {
  const s = hit.Specification
  if (!s) return null
  const make = slugPart(s.Make?.Value || '')
  const model = slugPart(s.Model?.Value || '')
  const version = slugPart(s.Version?.Value || '')
  const year = String(s.YearFabrication ?? '')
  if (!make || !model || !version || !year || !hit.UniqueId) return null
  const kind = hit.Seller?.SellerType === 'PF' ? 'private-seller' : 'dealer'
  return `${API}/detail/phone/${kind}/car/${make}/${model}/${version}/${year}/${hit.UniqueId}`
}

/** Busca o telefone do vendedor via endpoint de detalhe. */
async function fetchPhones(
  url: string,
  opts: WebMotorsProspectOptions,
): Promise<string[]> {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!r.ok) return []
    const j = (await r.json()) as Array<{ Phone?: string | null }>
    return (j || []).map((p) => (p.Phone || '').trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** Executa tarefas com concorrência limitada e pausa entre lotes. */
async function runBatch(
  tasks: Array<() => Promise<void>>,
  concurrency: number,
  gapMs: number,
  signal: { cancelled: boolean } | undefined,
): Promise<void> {
  let i = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < tasks.length) {
      if (signal?.cancelled) return
      const idx = i++
      await tasks[idx]()
      if (gapMs > 0) await sleep(gapMs)
    }
  })
  await Promise.all(workers)
}

/**
 * Pagina a busca (até `max` VENDEDORES únicos) e coleta telefones.
 * Retorna quantos vendedores processou e o total de páginas disponíveis.
 */
export async function prospectWebMotors(
  opts: WebMotorsProspectOptions,
): Promise<{ scanned: number; pages: number; total: number }> {
  const limit = opts.pageSize ?? 100
  const seenDealers = new Set<string>()
  let page = 1
  let pages = 0
  let total = 0
  let scanned = 0

  while (scanned < opts.max) {
    if (opts.signal?.cancelled) break
    opts.onProgress(`Buscando página ${page}… ${scanned} loja(s)`)
    let hits: SearchHit[] = []
    try {
      const u = new URL(`${API}/search/car`)
      // URLSearchParams.set já codifica o valor uma vez; NÃO usar encodeURIComponent
      // aqui (senão vira %252F = codificação dupla → 502).
      u.searchParams.set('url', window.location.origin + window.location.pathname)
      u.searchParams.set('actualPage', String(page))
      u.searchParams.set('displayPerPage', String(limit))
      u.searchParams.set('order', '1')
      u.searchParams.set('showMenu', 'false')
      u.searchParams.set('showCount', 'true')
      u.searchParams.set('showBanner', 'false')
      u.searchParams.set('filtersource', 'form')
      // Repassa os filtros ativos da busca atual (ex.: estadocidade, precoate,
      // marca, cidade...), ignorando parâmetros de rastreamento/paginação.
      const skip = new Set([
        'url', 'actualPage', 'displayPerPage', 'order', 'showMenu', 'showCount',
        'showBanner', 'filtersource', 'page', 'o', 'gclid', 'gclsrc', 'gbraid',
        'gad_source', 'gad_campaignid', 'utm_id', 'utm_source', 'utm_medium',
        'utm_campaign', 'utm_content', 'utm_term', 'idcmp',
      ])
      for (const [k, v] of new URLSearchParams(window.location.search)) {
        if (!skip.has(k) && !u.searchParams.has(k)) u.searchParams.set(k, v)
      }
      // Espaços chegam como '+'; a API espera '%20' (confirmação do formato que
      // funciona no site). Troca só na query string, sem tocar o pathname.
      const qs = u.searchParams.toString().replace(/\+/g, '%20')
      const r = await fetch(`${u.origin}${u.pathname}?${qs}`, {
        headers: { Accept: 'application/json' },
      })
      if (!r.ok) break
      const j = (await r.json()) as SearchResponse
      hits = j.SearchResults ?? []
      pages = j.Pagination?.PageTotal ?? 0
      total = j.Count ?? 0
    } catch {
      break
    }
    if (hits.length === 0) break

    // Deduplica por vendedor (Id + tipo), usando o 1º anúncio da página.
    const tasks: Array<() => Promise<void>> = []
    for (const hit of hits) {
      const seller = hit.Seller
      if (!seller || seller.Id == null) continue
      const dkey = `${seller.SellerType ?? ''}-${seller.Id}`
      if (seenDealers.has(dkey)) continue
      seenDealers.add(dkey)
      const phoneUrl = phoneUrlFor(hit)
      if (!phoneUrl) continue
      const room = opts.max - scanned
      if (tasks.length >= room) break
      tasks.push(async () => {
        const phones = await fetchPhones(phoneUrl, opts)
        for (const raw of phones) {
          const info = classifyBrazilianPhone(raw)
          if (!info.e164) continue
          const city = seller.City || null
          const state = seller.State
            ? (seller.State.match(/\(([A-Z]{2})\)/) || [])[1] || seller.State
            : null
          opts.onResult({
            key: info.e164,
            name: (seller.FantasyName || 'Sem nome').trim(),
            phone: raw,
            whatsapp: false,
            city,
            state,
            dealerId: seller.Id,
          })
        }
      })
    }

    if (tasks.length > 0) {
      await runBatch(tasks, 5, 120, opts.signal)
      scanned += tasks.length
    }

    if (pages > 0 && page >= pages) break
    page++
  }

  return { scanned, pages, total }
}

/** Detecta se a página atual é uma listagem de veículos do WebMotors. */
export function isWebMotorsList(href: string): boolean {
  try {
    const u = new URL(href)
    if (!/(^|\.)webmotors\.com\.br$/.test(u.hostname)) return false
    return /^\/(carros|motos)\//.test(u.pathname)
  } catch {
    return false
  }
}