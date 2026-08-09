import { getStoredConfig, saveConfig, getClient, type StoredConfig } from '../shared/config'
import type { SupabaseClient } from '@supabase/supabase-js'
import { importLeads, deleteLeads, type ScrapedLead } from '../shared/leads'
import css from './style.css?raw'

interface ParsedCard {
  lead: ScrapedLead
  host: HTMLElement | null
  key: string
  control: HTMLElement | null
}

export class MapsScanner {
  private cfg: StoredConfig | null = null
  private rtChannel: ReturnType<SupabaseClient['channel']> | null = null
  private found: ParsedCard[] = []
  private selected = new Set<string>()
  private used = new Set<string>()
  private noInterest = new Set<string>()
  private scanning = false

  private bubble: HTMLElement | null = null
  private balloon: HTMLElement | null = null
  private bCount: HTMLElement | null = null

  private lastQuery = ''
  private dragging = false
  private suppressClick = false

  async init(): Promise<void> {
    this.cfg = await getStoredConfig()
    injectStyles()
    this.ensureBubble()
    this.observeDom()
    this.scan('force')

    window.addEventListener('click', (e) => {
      if (!this.balloon?.classList.contains('open')) return
      if (this.balloon.contains(e.target as Node)) return
      if (this.bubble?.contains(e.target as Node)) return
      this.toggleBalloon(false)
    })

    this.subscribeRealtime()
  }

  /** Assina mudanças na tabela leads p/ atualizar badges (usado/sem interesse) ao vivo. */
  private subscribeRealtime(): void {
    void this.rtChannel?.unsubscribe()
    this.rtChannel = null
    const client = this.cfg ? getClient(this.cfg) : null
    if (!client) return
    this.rtChannel = client
      .channel('consecom-leads-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, () => this.debounceUsed())
      .subscribe()
  }

  private debounceUsed = (() => {
    let t: number | null = null
    return () => {
      if (t) return
      t = window.setTimeout(() => {
        t = null
        void this.checkUsed()
      }, 400)
    }
  })()

  private observeDom(): void {
    const obs = new MutationObserver(() => this.debounceScan())
    obs.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('scroll', () => this.debounceScan(), { passive: true })
  }

  private debounceScan = (() => {
    let t: number | null = null
    return () => {
      if (t) return
      t = window.setTimeout(() => {
        t = null
        this.scan()
      }, 350)
    }
  })()

  private scan(reason: 'scan' | 'force' = 'scan'): void {
    if (this.scanning && reason !== 'force') return
    this.scanning = true
    try {
      this.syncArea()
      this.refreshCards()
      this.prune()
      this.renderControls()
      this.renderBalloonList()
    } finally {
      this.scanning = false
    }
  }

  /** Detecta a área atual (a busca vigente) e limpa quando muda. */
  private syncArea(): void {
    const input = document.querySelector<HTMLInputElement>(
      'input#searchboxinput, input[aria-label*="pesquisa"], input[aria-label*="search"]',
    )
    const query = (input?.value || '').trim()
    if (query && query !== this.lastQuery) {
      this.lastQuery = query
      this.selected.clear()
      this.found = []
    }
    if (query) this.lastQuery = query
  }

  // --- cartões nativos: só nome, site, telefone e botão de selecionar ---

  private renderControls(): void {
    if (this.found.length === 0) return
    for (const pc of this.found) {
      if (!pc.host || !document.body.contains(pc.host)) continue
      if (pc.control && pc.control.isConnected) {
        this.updateControl(pc)
        continue
      }
      pc.control = this.buildControl(pc)
      this.makeHostSlim(pc.host)
      pc.host.appendChild(pc.control)
    }
  }

  private makeHostSlim(host: HTMLElement): void {
    if (!host.classList.contains('consecom-host')) {
      host.classList.add('consecom-host')
    }
  }

  private toggleSelected(key: string): void {
    if (this.used.has(key) || this.noInterest.has(key)) return
    if (this.selected.has(key)) this.selected.delete(key)
    else this.selected.add(key)
    this.syncAll()
  }

  private toggleControl(key: string): void {
    this.toggleSelected(key)
  }

  private selectAllAvailable(): void {
    const avail = this.found.filter((f) => !this.used.has(f.key) && !this.noInterest.has(f.key))
    const max = Math.min(50, avail.length)
    const next = new Set<string>()
    for (let i = 0; i < max; i++) next.add(avail[i].key)
    this.selected = next
    this.syncAll()
    showToast(`✅ ${this.selected.size} selecionado(s) (máx. 50 por importação)`)
  }

  private clearSelection(): void {
    this.selected.clear()
    this.syncAll()
  }

  private buildControl(pc: ParsedCard): HTMLElement {
    const c = document.createElement('div')
    c.className = 'consecom-control'
    c.title = pc.lead.name

    const mark = document.createElement('button')
    mark.type = 'button'
    mark.className = 'cs-round cs-select'
    mark.title = 'Selecionar'
    mark.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.toggleControl(pc.key)
    })

    const name = document.createElement('span')
    name.className = 'cs-name'
    name.textContent = pc.lead.name
    name.title = pc.lead.name

    const act = document.createElement('div')
    act.className = 'cs-actions'

    const site = document.createElement('button')
    site.type = 'button'
    site.className = 'cs-round'
    site.title = 'Abrir site'
    site.innerHTML = websiteIcon
    if (pc.lead.website) {
      site.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        window.open(pc.lead.website!, '_blank', 'noopener,noreferrer')
      })
    } else {
      site.disabled = true
    }

    const phone = document.createElement('button')
    phone.type = 'button'
    phone.className = 'cs-round'
    phone.title = 'Chamar'
    phone.innerHTML = phoneSvg
    if (pc.lead.phone) {
      phone.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        window.location.href = `tel:${pc.lead.phone!.replace(/\s+/g, '')}`
      })
    } else {
      phone.disabled = true
    }

    act.append(site, phone)

    const badge = document.createElement('span')
    badge.className = 'cs-badge'
    badge.textContent = 'Sem interesse'
    badge.style.display = 'none'

    c.append(mark, name, act, badge)
    return c
  }

  private updateControl(pc: ParsedCard): void {
    const mark = pc.control?.querySelector('.cs-select') as HTMLButtonElement | null
    if (!mark) return
    const noInterest = this.noInterest.has(pc.key)
    mark.classList.toggle('nointerest', noInterest)
    const badge = pc.control?.querySelector('.cs-badge') as HTMLElement | null
    if (badge) badge.style.display = noInterest ? 'block' : 'none'
    if (noInterest) {
      mark.disabled = true
      mark.title = 'Sem interesse — não importar (6 meses)'
      mark.innerHTML = '✕'
      return
    }
    if (this.used.has(pc.key)) {
      mark.classList.add('used')
      mark.disabled = true
      mark.title = 'Já importado anteriormente'
      mark.innerHTML = checkIcon
    } else {
      mark.disabled = false
      mark.classList.toggle('on', this.selected.has(pc.key))
      mark.title = this.selected.has(pc.key) ? 'Remover seleção' : 'Selecionar'
      mark.innerHTML = this.selected.has(pc.key) ? checkIcon : plusIcon
    }
  }

  // --- bolha flutuante (arrastável) + painel vertical ---

  private buildBubble(): HTMLElement {
    const bubble = document.createElement('div')
    bubble.className = 'consecom-bubble'
    bubble.title = 'Consecom'

    const icon = document.createElement('span')
    icon.className = 'consecom-bubble__icon'
    icon.textContent = 'C'

    const count = document.createElement('span')
    count.className = 'consecom-bubble__count'
    count.textContent = '0'
    this.bCount = count

    bubble.append(icon, count)
    this.bubble = bubble

    bubble.addEventListener('click', () => {
      if (this.suppressClick) {
        this.suppressClick = false
        return
      }
      this.toggleBalloon()
    })
    this.enableDrag(bubble)

    bubble.style.left = localStorage.getItem('consecom-bubble-x') || '20px'
    bubble.style.top = localStorage.getItem('consecom-bubble-top') || '16px'
    return bubble
  }

  private ensureBubble(): void {
    if (this.bubble && document.body.contains(this.bubble)) return
    const b = this.buildBubble()
    document.body.appendChild(b)
  }

  private enableDrag(elm: HTMLElement): void {
    let startX = 0
    let startY = 0
    let origLeft = 0
    let origTop = 0
    const moved = { v: false }

    const down = (e: PointerEvent) => {
      this.dragging = true
      moved.v = false
      startX = e.clientX
      startY = e.clientY
      origLeft = elm.offsetLeft
      origTop = elm.offsetTop
      elm.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!this.dragging) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (Math.abs(dx) + Math.abs(dy) > 4) moved.v = true
      const left = Math.max(0, Math.min(window.innerWidth - 60, origLeft + dx))
      const top = Math.max(0, Math.min(window.innerHeight - 60, origTop + dy))
      elm.style.left = `${left}px`
      elm.style.top = `${top}px`
      if (this.balloon?.classList.contains('open')) this.positionBalloon()
    }
    const up = (e: PointerEvent) => {
      if (!this.dragging) return
      if (elm.hasPointerCapture(e.pointerId)) elm.releasePointerCapture(e.pointerId)
      // só arma o movimento para suprimir o clique se houve arrasto real
      this.suppressClick = moved.v
      this.dragging = false
      localStorage.setItem('consecom-bubble-x', elm.style.left)
      localStorage.setItem('consecom-bubble-top', elm.style.top)
    }
    elm.addEventListener('pointerdown', down)
    elm.addEventListener('pointermove', move)
    elm.addEventListener('pointerup', up)
    elm.addEventListener('pointercancel', up)
    void { v: moved.v }
  }

  private buildBalloon(): HTMLElement {
    const balloon = document.createElement('aside')
    balloon.className = 'consecom-balloon'

    const panel = document.createElement('div')
    panel.className = 'consecom-balloon__panel'
    const arrow = document.createElement('div')
    arrow.className = 'consecom-balloon__arrow'

    const tools = document.createElement('div')
    tools.className = 'consecom-balloon__tools'

    const importBtn = document.createElement('button')
    importBtn.type = 'button'
    importBtn.className = 'cs-btn cs-import'
    importBtn.innerHTML = `<span data-role="import-label">Importar</span>`
    importBtn.addEventListener('click', () => void this.doImport(importBtn))

    const selectAll = document.createElement('button')
    selectAll.type = 'button'
    selectAll.className = 'cs-btn cs-selectall'
    selectAll.textContent = 'Selecionar todos'
    selectAll.addEventListener('click', () => this.selectAllAvailable())

    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'cs-btn cs-delete'
    deleteBtn.textContent = 'Excluir selecionados'
    deleteBtn.addEventListener('click', () => void this.doDelete(deleteBtn))

    const configBtn = document.createElement('button')
    configBtn.type = 'button'
    configBtn.className = 'cs-btn cs-config'
    configBtn.title = 'Configurar Supabase'
    configBtn.innerHTML = '<span>Configurar</span>' + gearIcon
    configBtn.addEventListener('click', () => void this.promptConfig())

    tools.append(importBtn, selectAll, deleteBtn, configBtn)

    panel.appendChild(tools)
    panel.appendChild(arrow)
    balloon.appendChild(panel)
    this.balloon = balloon
    return balloon
  }

  private renderBalloonList(): void {
    if (!this.balloon) return
    const importLabel = this.balloon.querySelector('[data-role="import-label"]') as HTMLElement | null
    if (importLabel) {
      importLabel.textContent = this.selected.size > 0 ? `Importar (${this.selected.size})` : 'Importar'
    }
    this.updateCounts()
  }

  private syncAll(): void {
    this.updateCounts()
    this.renderControls()
    this.renderBalloonList()
  }

  private updateCounts(): void {
    if (this.bCount) this.bCount.textContent = `${this.selected.size}`
  }

  private toggleBalloon(open?: boolean): void {
    if (!this.balloon || !document.body.contains(this.balloon)) {
      this.balloon = this.buildBalloon()
      document.body.appendChild(this.balloon)
    }
    const shouldOpen = open ?? !this.balloon.classList.contains('open')
    this.balloon.classList.toggle('open', shouldOpen)
    if (shouldOpen) this.positionBalloon()
    this.renderBalloonList()
  }

  /** Posiciona o retângulo logo acima do balão (ou abaixo quando não há espaço), com a seta apontando para ele. */
  private positionBalloon(): void {
    if (!this.balloon || !this.bubble) return
    const bw = this.bubble.offsetWidth
    const bh = this.bubble.offsetHeight
    const mw = this.balloon.offsetWidth
    const mh = this.balloon.offsetHeight
    const bl = this.bubble.offsetLeft
    const bt = this.bubble.offsetTop

    let left = bl + bw / 2 - mw / 2
    left = Math.max(8, Math.min(window.innerWidth - mw - 8, left))

    const above = bt - mh - 12 >= 8
    this.balloon.classList.toggle('above', !above)
    const top = above ? bt - mh - 12 : bt + bh + 12
    this.balloon.style.left = `${left}px`
    this.balloon.style.top = `${top}px`
  }

  // --- varredura dos cards nativos ---

  private refreshCards(): void {
    const anchors = document.querySelectorAll<HTMLElement>(nativeCardSelector())
    const seen = new Set<string>()

    for (const anchor of Array.from(anchors)) {
      const card = closestCard(anchor)
      const href = (anchor as HTMLAnchorElement).href
      const name = extractName(anchor, card)
      if (!name) continue
      const placeId = matchPlaceId(href)
      const key = placeId || href
      if (!placeId && !href) continue
      if (seen.has(key)) continue
      seen.add(key)

      const existing = this.found.find((f) => f.key === key)
      if (existing) {
        existing.host = existing.host && document.body.contains(existing.host) ? existing.host : card
        existing.lead.name = name
        continue
      }

      this.found.push({
        lead: this.parseCard(card, name, href, placeId),
        host: card,
        key,
        control: null,
      })
    }
    void this.checkUsed()
  }

  private async checkUsed(): Promise<void> {
    const cfg = this.cfg ?? (await getStoredConfig())
    if (!cfg.supabaseUrl || !cfg.anonKey) return
    const ids = this.found.map((f) => f.lead.place_id).filter((x): x is string => !!x)
    if (ids.length === 0) return
    try {
      const res = await fetch(
        `${cfg.supabaseUrl}/rest/v1/leads?select=place_id,no_interest_until&place_id=in.(${ids.map(encodeURIComponent).join(',')})`,
        { headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` } },
      )
      if (res.ok) {
        const rows = (await res.json()) as { place_id: string | null; no_interest_until: string | null }[]
        this.used = new Set(rows.filter((r) => r.place_id).map((r) => r.place_id as string))
        const now = Date.now()
        this.noInterest = new Set(
          rows
            .filter((r) => r.place_id && r.no_interest_until && new Date(r.no_interest_until).getTime() > now)
            .map((r) => r.place_id as string),
        )
        this.syncAll()
      }
    } catch {
      /* rede/RLS: segue sem rótulos de usado */
    }
  }

  private prune(): void {
    this.found = this.found.filter((f) => f.host && document.body.contains(f.host))
  }

  private parseCard(card: HTMLElement | null, name: string, href: string, placeId: string | null): ScrapedLead {
    const text = (card?.innerText || '') ?? ''
    const coords = href.match(/!3d([-\d.]+)!4d([-\d.]+)/)

    return {
      name,
      phone: extractPhone(card, text),
      category: deriveCategory(text, name),
      website: extractWebsite(card),
      address: extractAddress(card),
      city: null,
      state: null,
      rating: deriveRating(text),
      reviews: deriveReviews(text),
      latitude: coords ? parseFloat(coords[1]) : null,
      longitude: coords ? parseFloat(coords[2]) : null,
      place_id: placeId,
      maps_url: href || null,
    }
  }

  // --- configuração e importação ---

  private async promptConfig(): Promise<void> {
    this.cfg = this.cfg ?? (await getStoredConfig())
    const url = prompt('URL do projeto Supabase:', this.cfg?.supabaseUrl || '')
    if (url === null) return
    const key = prompt('Chave anon (publishable):', this.cfg?.anonKey || '')
    if (key === null) return
    if (!url || !key) {
      alert('Informe URL e chave anon.')
      return
    }
    await saveConfig({ supabaseUrl: url.replace(/\/+$/, ''), anonKey: key })
    this.cfg = { supabaseUrl: url.replace(/\/+$/, ''), anonKey: key }
    this.subscribeRealtime()
  }

  private async doImport(btn: HTMLButtonElement): Promise<void> {
    this.cfg = this.cfg ?? (await getStoredConfig())
    if (!this.cfg || !this.cfg.supabaseUrl || !this.cfg.anonKey) {
      alert('Configure a URL do Supabase e a chave anon primeiro (⚙).')
      return
    }

    const leads = this.found
      .filter((f) => !this.used.has(f.key) && this.selected.has(f.key))
      .map((f) => f.lead)
      .slice(0, 50)
    if (leads.length === 0) {
      alert('Nenhuma empresa nova selecionada para importar.')
      return
    }

    const prev = btn.innerHTML
    btn.disabled = true
    btn.textContent = 'Importando…'
    try {
      let done = 0
      const res = await importLeads(this.cfg, leads, (d, total) => {
        done = d
        btn.textContent = `${d}/${total}…`
      })
      btn.textContent = res.failed === 0 ? '✓' : `${res.ok} ok, ${res.failed} falharam`

      if (res.failed === 0) {
        showToast(res.ok > 0 ? `✅ ${res.ok} lead(s) importado(s)!` : 'Nenhum lead novo para importar.')
        this.selected.clear()
      } else {
        showToast(`⚠️ ${res.ok} ok, ${res.failed} falharam`, 'warn')
      }
      void this.checkUsed()
      this.syncAll()
      setTimeout(() => {
        btn.innerHTML = prev
        btn.disabled = false
      }, 2000)
      void done
    } catch (err) {
      btn.textContent = `Erro: ${err}`
      setTimeout(() => {
        btn.innerHTML = prev
        btn.disabled = false
      }, 3000)
    }
  }

  private async doDelete(btn: HTMLButtonElement): Promise<void> {
    this.cfg = this.cfg ?? (await getStoredConfig())
    if (!this.cfg || !this.cfg.supabaseUrl || !this.cfg.anonKey) {
      alert('Configure a URL do Supabase e a chave anon primeiro (⚙).')
      return
    }

    const ids = this.found
      .filter((f) => this.selected.has(f.key) && f.lead.place_id)
      .map((f) => f.lead.place_id as string)
    if (ids.length === 0) {
      alert('Selecione pelo menos um lead para excluir.')
      return
    }
    if (!confirm(`Excluir ${ids.length} lead(s) do banco?`)) return

    const prev = btn.innerHTML
    btn.disabled = true
    btn.innerHTML = 'Excluindo…'
    try {
      const res = await deleteLeads(this.cfg, ids)
      if (res.failed === 0) {
        showToast(`🗑️ ${res.ok} lead(s) excluído(s)!`)
        for (const id of ids) this.used.delete(id)
        this.selected.clear()
      } else {
        showToast(`⚠️ ${res.ok} ok, ${res.failed} falharam ao excluir`, 'warn')
      }
      void this.checkUsed()
      this.syncAll()
    } catch (err) {
      showToast(`Erro ao excluir: ${err}`, 'warn')
    } finally {
      btn.innerHTML = prev
      btn.disabled = false
    }
  }
}

const start = () => {
  const scanner = new MapsScanner()
  void scanner.init()
}

if (typeof window !== 'undefined') start()

export function startConsecomScanner(): void {
  start()
}

// ---- helpers de extração ----

function nativeCardSelector(): string {
  return 'a[href*="/maps/place/"]'
}

function matchPlaceId(href: string): string | null {
  const m = href.match(/(?:^|[?&])place_id=([^&]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

function closestCard(anchor: HTMLElement): HTMLElement | null {
  let el = anchor.parentElement
  for (let i = 0; i < 9 && el && el.tagName !== 'BODY'; i++) {
    if (el.getAttribute('role') === 'feed') break
    if (el.getAttribute('role') === 'article') return el
    if (el.querySelector('span[aria-label*="stars"], span[aria-label*="avalia"], span[aria-label*="estrela"]')) {
      return el
    }
    if (el.querySelector('a[href*="/maps/place/"]')) return el
    el = el.parentElement
  }
  return anchor.closest('div[role="article"], [role="article"]') ?? anchor
}

function extractName(anchor: HTMLElement, card: HTMLElement | null): string | null {
  const linkText = anchor.textContent || ''
  const words = linkText.split(/\s+/).filter(Boolean)
  if (words.length > 0 && words.length < 14) return words.slice(0, 6).join(' ')
  const h = anchor.querySelector('h3, [role="heading"], [style*="font"]')
  const t = (h?.textContent || '').trim()
  if (t) return t.split('\n')[0]
  if (card) return (card.textContent || '').trim().split('\n')[0] || null
  return null
}

function extractPhone(card: HTMLElement | null, text: string): string | null {
  const tel = card?.querySelector('a[href^="tel:"]') as HTMLAnchorElement | null
  if (tel) return tel.href.replace('tel:', '').trim()
  const m = text.match(/\(\d{2,3}\)\s?\d[\d\s-]{7,}/)
  return m ? m[0].replace(/\s+/g, ' ').trim() : null
}

function deriveCategory(text: string, name: string): string | null {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t && t !== name && t.length < 40 && !/\d/.test(t) && !t.startsWith('★') && !/^\d/.test(t)) return t
  }
  return null
}

function extractWebsite(card: HTMLElement | null): string | null {
  if (!card) return null
  const selectors = [
    'a[data-tooltip="Abrir site"]',
    'a[data-tooltip="Website"]',
    'a[aria-label*="Abrir site"]',
    'a[href]:not([href^="tel:"]):not([href*="/maps/place/"]):not([href^="http://www.google.com/maps"])',
  ]
  for (const sel of selectors) {
    const a = card.querySelector(sel) as HTMLAnchorElement | null
    const href = a?.href
    if (href && href.startsWith('http')) return href.split('&place_id')[0]
  }
  const textLink = card.querySelector('a[href^="http"]') as HTMLAnchorElement | null
  const href = textLink?.href
  if (href && href.startsWith('http') && !href.includes('/maps/place/')) return href.split('&')[0]
  return null
}

function extractAddress(card: HTMLElement | null): string | null {
  const el = card?.querySelector('button[data-tooltip="Endereço"], div[class*="address"], span[data-type="address"]')
  return el?.textContent?.trim() || null
}

function deriveRating(text: string): number | null {
  const m = text.match(/([\d.]+)[\s]*[★✩]/)
  return m ? parseFloat(m[1]) : null
}

function deriveReviews(text: string): number | null {
  const m = text.match(/\(([\d.,]+)\)/)
  return m ? parseInt(m[1].replace(/[^\d]/g, ''), 10) : null
}

function injectStyles(): void {
  if (document.getElementById('consecom-css')) return
  const el = document.createElement('style')
  el.id = 'consecom-css'
  el.textContent = css
  document.head.appendChild(el)
}

function showToast(text: string, kind: 'ok' | 'warn' = 'ok'): void {
  const id = 'consecom-toast'
  document.getElementById(id)?.remove()
  const toast = document.createElement('div')
  toast.id = id
  toast.className = 'consecom-toast' + (kind === 'warn' ? ' cs-warn' : '')
  toast.textContent = text
  document.body.appendChild(toast)
  window.setTimeout(() => {
    toast.classList.add('cs-show')
  }, 20)
  window.setTimeout(() => toast.remove(), 4000)
}

const phoneSvg =
  '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1z"/></svg>'

const websiteIcon =
  '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm2.5 16c-.8 1.3-1.6 2-2.5 2s-1.7-.7-2.5-2c-.7-1.2-1.2-2.8-1.4-4.5h7.8c-.2 1.7-.7 3.3-1.4 4.5zM7.8 11.5c.2-1.7.7-3.3 1.4-4.5.8-1.3 1.6-2 2.5-2s1.7.7 2.5 2c.7 1.2 1.2 2.8 1.4 4.5H7.8zM12 4c.5.7.9 1.6 1.2 2.6h-2.4C10.6 5.6 11.2 4.6 12 4zm-3.1 7c-.1.5-.1 1 0 1.5H5.9a8 8 0 0 1 0-3h3c-.1.5-.1 1 0 1.5zm-1.6 3h3c.1 1.5.4 2.9.9 4-.9-.4-1.6-.9-2.3-1.6-.5-.6-1-1.5-1.6-2.4zM15.1 17c.7.7 1.4 1.2 2.3 1.6-.5-1.1-.8-2.5-.9-4h3a8 8 0 0 1-.9 3c-.5.5-1 .9-1.6 1.2-.6.3-1.3.5-1.9.6v-2.4zm3.6-4.5h-3.1c0-.5 0-1 .1-1.5h3a8 8 0 0 1 0 3h-3c0-.5-.1-1-.1-1.5zM7.1 7c-.7-.7-1.4-1.2-2.3-1.6.5 1.1.8 2.5.9 4h-3a8 8 0 0 1 .9-3c.5-.5 1-.9 1.6-1.2.6-.3 1.3-.5 1.9-.6V7zm0 1.5v2.4c.5 0 1 .1 1.5.1h1.6c-.1-1.4-.4-2.7-.9-3.8-.7.3-1.4.8-2.2 1.3zM12 20c-.5-.7-.9-1.6-1.2-2.6h2.4c-.3 1-.9 1.9-1.2 2.6z"/></svg>'

const checkIcon = '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>'

const plusIcon = '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>'

const gearIcon =
  '<svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm8.9-3.3a7.5 7.5 0 0 0 0-1.5l2-1.6-2-3.4-2.5 1a7.7 7.7 0 0 0-1.7-1L16 1.5h-4l-.4 2.5a7.7 7.7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 1.5l-2 1.6 2 3.4 2.5-1a7.7 7.7 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.7 7.7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6zM12 16.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>'