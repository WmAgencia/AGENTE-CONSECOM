/**
 * Adaptador Vyntra Prospector — Airbnb (airbnb.com.br / airbnb.com).
 *
 * O Airbnb NÃO expõe o telefone do anfitrião na busca nem no anúncio — a menos
 * que o host escreva um número na DESCRIÇÃO do imóvel (raro, ~4-5%). Este
 * adaptador:
 *   1. Lê os <script id="data-deferred-state-*.json"> embebidos na página de
 *      busca para obter os IDs numéricos dos anúncios (base64).
 *   2. Para cada anúncio (limite configurável), busca a página /rooms/{id} e
 *      extrai nome do anfitrião, cidade e texto da descrição.
 *   3. Varre o texto por link tel:/wa.me ou telefone brasileiro escrito à mão
 *      e emite contatos com WhatsApp (dedup por número normalizado).
 *
 * Tudo roda no browser do usuário (same-origin), respeitando o login.
 */
import { classifyBrazilianPhone } from '../shared/phone'

export interface AirbnbContact {
  key: string
  name: string
  phone: string
  whatsapp: boolean
  city: string | null
  state: string | null
  listingUrl: string
}

export interface AirbnbProspectOptions {
  max: number
  signal?: { cancelled: boolean }
  onResult: (c: AirbnbContact) => void
  onProgress: (msg: string) => void
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

interface SearchListing {
  id: string
  title: string
  price: string | null
  url: string
}

/** Decodifica um id de anúncio Airbnb ('RGVtYW5kU3RheUxpc3Rpbmc6MTcyOTgx...' → número). */
export function decodeListingId(b64: string): string | null {
  try {
    const dec = atob(b64)
    const m = dec.match(/DemandStayListing:(\d+)/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/** Lê os JSONs embebidos <script id="data-deferred-state-N"> da página. */
function readEmbeddedJson(root: ParentNode): unknown[] {
  const out: unknown[] = []
  const scripts = root.querySelectorAll<HTMLScriptElement>('script[id^="data-deferred-state"]')
  scripts.forEach((s) => {
    try {
      out.push(JSON.parse(s.textContent || '{}'))
    } catch {
      /* script malformado — ignora */
    }
  })
  return out
}

/** Extrai os anúncios da busca a partir do niobeClientData embebido. */
export function extractSearchListings(root: ParentNode = document): SearchListing[] {
  const out: SearchListing[] = []
  const seen = new Set<string>()
  for (const d of readEmbeddedJson(root)) {
    const nc = (d as { niobeClientData?: unknown }).niobeClientData
    const arr = Array.isArray(nc) ? nc : undefined
    const client = arr?.[0]?.[1] as { presentation?: { staysSearch?: { results?: { searchResults?: unknown[] } } } } | undefined
    const results = client?.presentation?.staysSearch?.results?.searchResults
    if (!Array.isArray(results)) continue
    for (const r of results as Array<{
      demandStayListing?: {
        id?: string
        description?: { name?: { localizedStringWithTranslationPreference?: string } }
      }
      structuredDisplayPrice?: { primaryLine?: { price?: string } }
      location?: { coordinate?: { latitude?: number | null; longitude?: number | null } }
    }>) {
      const idb64 = r.demandStayListing?.id
      if (!idb64) continue
      const numericId = decodeListingId(idb64)
      if (!numericId || seen.has(numericId)) continue
      seen.add(numericId)
      const price = r.structuredDisplayPrice?.primaryLine?.price ?? null
      const title =
        r.demandStayListing?.description?.name?.localizedStringWithTranslationPreference ||
        (price ? `Anúncio Airbnb · ${price}` : 'Anúncio Airbnb')
      out.push({
        id: numericId,
        title,
        price,
        url: `https://www.airbnb.com.br/rooms/${numericId}`,
      })
    }
  }
  return out
}

/** Extrai nome do host, cidade e descrição a partir do HTML da página do anúncio. */
async function fetchPdpData(
  numericId: string,
  signal: { cancelled: boolean } | undefined,
): Promise<{ hostName: string | null; city: string | null; description: string } | null> {
  if (signal?.cancelled) return null
  try {
    const r = await fetch(`https://www.airbnb.com.br/rooms/${numericId}`, {
      headers: { Accept: 'text/html' },
      credentials: 'include',
    })
    if (!r.ok) return null
    const html = await r.text()

    const re = /<script id="data-deferred-state-\d+" type="application\/json">([\s\S]*?)<\/script>/g
    let hostName: string | null = null
    let city: string | null = null
    const texts: string[] = []
    let m: RegExpExecArray | null
    while ((m = re.exec(html))) {
      let d: unknown
      try {
        d = JSON.parse(m[1])
      } catch {
        continue
      }
      const nc = (d as { niobeClientData?: unknown }).niobeClientData
      const arr = Array.isArray(nc) ? nc : undefined
      const client = arr?.[0]?.[1] as
        | {
            pdpSections?: Array<{ section?: { hostInfo?: { passportData?: { name?: string } } } }>
            pdpContext?: { location?: { city?: string } }
            description?: unknown
          }
        | undefined
      if (!client) continue
      if (!hostName) {
        const sec = client.pdpSections?.find((s) => s.section?.hostInfo?.passportData?.name)
        hostName = sec?.section?.hostInfo?.passportData?.name ?? null
      }
      if (!city) city = client.pdpContext?.location?.city ?? null
      const collect = (obj: unknown) => {
        if (!obj) return
        if (typeof obj === 'string') {
          if (obj.trim().length >= 8) texts.push(obj)
          return
        }
        if (Array.isArray(obj)) {
          obj.forEach(collect)
          return
        }
        if (typeof obj === 'object') {
          const o = obj as Record<string, unknown>
          if (typeof o.localizedString === 'string') texts.push(o.localizedString)
          const htmlText = o.htmlText as { html?: string } | undefined
          if (htmlText?.html) texts.push(htmlText.html)
          if (typeof o.string === 'string') texts.push(o.string)
          for (const k in o) {
            if (k === 'photo' || k === 'pictureUrl' || k === 'imageUrl') continue
            collect(o[k])
          }
        }
      }
      collect(client.description)
    }
    return {
      hostName,
      city,
      description: texts.join('\n').replace(/<[^>]+>/g, ' '),
    }
  } catch {
    return null
  }
}

/** Procura telefone/WhatsApp em um texto (links tel:/wa.me ou números escritos). */
function findPhones(text: string): string[] {
  const found = new Set<string>()
  const linkRe = /(?:tel:|wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?[\d\s\-()]+)/gi
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(text))) {
    const raw = m[1].replace(/\D/g, '')
    if (raw.length >= 10 && raw.length <= 13) found.add(raw)
  }
  const phoneRe = /(?:\+?55[\s-]?)?(?:\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}/g
  while ((m = phoneRe.exec(text))) {
    const digits = m[0].replace(/\D/g, '')
    if (digits.length < 10 || digits.length > 13) continue
    const info = classifyBrazilianPhone(digits)
    if (info.class === 'MOBILE' && info.e164) found.add(info.e164)
  }
  return Array.from(found)
}

/** Executa tarefas com concorrência limitada e pausa entre chamadas. */
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
 * Prospecta os anúncios da busca atual: busca cada PDP, lê a descrição e emite
 * contatos para os que tiverem telefone/WhatsApp no texto.
 */
export async function prospectAirbnb(
  opts: AirbnbProspectOptions,
): Promise<{ scanned: number; total: number }> {
  const listings = extractSearchListings()
  const total = listings.length
  if (total === 0) return { scanned: 0, total: 0 }
  const slice = listings.slice(0, opts.max)
  let done = 0
  const tasks = slice.map((l) => async () => {
    if (opts.signal?.cancelled) return
    const label = l.price ? l.title.replace(l.price, '').trim() || l.title : l.title
    opts.onProgress(`Lendo anúncio ${done + 1}/${slice.length}…`)
    done++
    const data = await fetchPdpData(l.id, opts.signal)
    if (!data) return
    const phones = findPhones(data.description)
    if (phones.length === 0) return
    const name = data.hostName?.trim() || 'Anfitrião Airbnb'
    const hasWa =
      /whatsapp|wa\.me|api\.whatsapp|zap|whats/i.test(data.description)
    for (const raw of phones) {
      const info = classifyBrazilianPhone(raw)
      if (info.class !== 'MOBILE' || !info.e164) continue
      opts.onResult({
        key: info.e164,
        name,
        phone: raw,
        whatsapp: hasWa,
        city: data.city,
        state: null,
        listingUrl: l.url,
      })
    }
  })
  await runBatch(tasks, 3, 300, opts.signal)
  return { scanned: slice.length, total }
}

/** Detecta página de busca de anúncios do Airbnb (ex.: /s/Sorocaba--Brasil/homes). */
export function isAirbnbSearch(href: string): boolean {
  try {
    const u = new URL(href)
    if (!/(^|\.)airbnb\.com(\.br)?$/.test(u.hostname)) return false
    return /\/s\/.*\/homes|\/s\//.test(u.pathname)
  } catch {
    return false
  }
}