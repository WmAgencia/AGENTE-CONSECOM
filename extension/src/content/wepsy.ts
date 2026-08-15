/**
 * Adaptador Vyntra Prospector — Wepsy (wepsy.com.br/catalogo).
 *
 * O catálogo público da Wepsy lista psicólogos, mas a listagem
 * (`/user-professionals/recommended`) NÃO expõe telefones. Cada perfil
 * (`/user-professionals/{id}`) traz o `mobile`/`phone` e as flags de opt-in
 * (`show_contact_whatsapp`/`show_contact_phone`). Este adaptador pagina a
 * listagem e busca os perfis um a um (com concorrência limitada) para extrair
 * nome + celular — respeitando apenas contatos que o profissional optou por
 * exibir publicamente.
 *
 * API: https://api.wepsy.com.br (CORS *, sem auth).
 */
import { classifyBrazilianPhone } from '../shared/phone'

const API = 'https://api.wepsy.com.br'

interface RecommendedItem {
  id: number
  user?: { name?: string | null } | null
}

interface WepsyProfile {
  id: number
  mobile?: string | null
  phone?: string | null
  contact_email?: string | null
  show_contact_whatsapp?: boolean | null
  show_contact_phone?: boolean | null
  user?: { name?: string | null } | null
  address?: {
    city?: {
      name?: string | null
      state?: { abbreviation?: string | null } | null
    } | null
  } | null
}

export interface WepsyContact {
  key: string
  name: string
  phone: string
  whatsapp: boolean
  city: string | null
  state: string | null
}

export interface WepsyProspectOptions {
  max: number
  pageSize?: number
  signal?: { cancelled: boolean }
  onResult: (c: WepsyContact) => void
  onProgress: (msg: string) => void
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

async function fetchProfile(
  id: number,
  fallbackName: string,
  opts: WepsyProspectOptions,
): Promise<void> {
  try {
    const r = await fetch(`${API}/user-professionals/${id}`, {
      headers: { Accept: 'application/json' },
    })
    if (!r.ok) return
    const p = (await r.json()) as WepsyProfile
    const canShow =
      p.show_contact_whatsapp === true || p.show_contact_phone === true
    const raw = (p.mobile && String(p.mobile).trim()) || (p.phone && String(p.phone).trim()) || ''
    if (!canShow || !raw) return
    const info = classifyBrazilianPhone(raw)
    if (info.class !== 'MOBILE' || !info.e164) return
    opts.onResult({
      key: info.e164,
      name: (p.user?.name || fallbackName || 'Sem nome').trim(),
      phone: raw,
      whatsapp: p.show_contact_whatsapp === true,
      city: p.address?.city?.name ?? null,
      state: p.address?.city?.state?.abbreviation ?? null,
    })
  } catch {
    /* perfil inacessível: ignora e segue */
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
 * Pagina o catálogo recomendado e coleta contatos com celular público.
 * Retorna quantos itens da listagem processou e o total de páginas.
 */
export async function prospectWepsy(
  opts: WepsyProspectOptions,
): Promise<{ scanned: number; pages: number }> {
  const limit = opts.pageSize ?? 50
  const seenIds = new Set<number>()
  let page = 1
  let pages = 0
  let scanned = 0

  while (scanned < opts.max) {
    if (opts.signal?.cancelled) break
    opts.onProgress(`Buscando página ${page}… ${scanned} contato(s)`)
    let list: RecommendedItem[] = []
    try {
      const r = await fetch(
        `${API}/user-professionals/recommended?page=${page}&limit=${limit}`,
        { headers: { Accept: 'application/json' } },
      )
      if (!r.ok) break
      const j = (await r.json()) as {
        metadata?: { pages?: number; total?: number }
        result?: RecommendedItem[]
      }
      list = j.result ?? []
      pages = j.metadata?.pages ?? 0
    } catch {
      break
    }
    if (list.length === 0) break

    // Filtra ids já vistos (rotação do catálogo pode repetir).
    const fresh = list.filter((p) => p.id != null && !seenIds.has(p.id))
    for (const p of fresh) seenIds.add(p.id)

    const room = opts.max - scanned
    const batch = fresh.slice(0, room)
    if (batch.length === 0) {
      scanned += list.length
    } else {
      await runBatch(
        batch.map((p) => () =>
          fetchProfile(p.id, (p.user?.name || '').trim(), opts),
        ),
        5,
        120,
        opts.signal,
      )
      scanned += batch.length
    }

    if (pages > 0 && page >= pages) break
    page++
  }

  return { scanned, pages }
}

/** Detecta se a página atual é o catálogo da Wepsy. */
export function isWepsyCatalog(href: string): boolean {
  try {
    const u = new URL(href)
    return /(^|\.)wepsy\.com\.br$/.test(u.hostname)
  } catch {
    return false
  }
}
