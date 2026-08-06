import { getStoredConfig, saveConfig, type StoredConfig } from '../shared/config'
import { importLeads, type ScrapedLead } from '../shared/leads'
import css from './style.css?raw'
import { indexHtml } from './overlay'

interface ParsedCard {
  lead: ScrapedLead
}

export function startConsecomScanner(): void {
  const scanner = new MapsScanner()
  void scanner.init()
}

if (typeof window !== 'undefined') {
  startConsecomScanner()
}

export class MapsScanner {
  private cfg: StoredConfig | null = null
  private root: HTMLDivElement | null = null
  private found: ParsedCard[] = []
  private selected = new Set<number>()
  private scanning = false

  async init(): Promise<void> {
    this.cfg = await getStoredConfig()
    injectStyles()
    this.ensureOverlay()
    this.observeDom()
    this.scan()
    window.setInterval(() => this.scan(), 4000)

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'consecom:open') this.ensureOverlay()
    })
  }

  private ensureOverlay(): void {
    if (document.getElementById('consecom-root')) return
    const root = document.createElement('div')
    root.id = 'consecom-root'
    root.innerHTML = indexHtml
    document.documentElement.appendChild(root)
    this.root = root

    root.querySelector('#consecom-close')?.addEventListener('click', () => root.remove())
    root.querySelector('#consecom-refresh')?.addEventListener('click', () => this.scan())
    root.querySelector('#consecom-config')?.addEventListener('click', () => this.toggleInput())
    root.querySelector('#consecom-save-config')?.addEventListener('click', () => this.saveFromForm())
    root.querySelector('#consecom-import')?.addEventListener('click', () => void this.importAll())
    root.querySelector('#consecom-select-all')?.addEventListener('change', (e) => {
      const cb = e.target as HTMLInputElement
      this.selected.clear()
      if (cb.checked) this.found.forEach((_, i) => this.selected.add(i))
      this.renderList()
    })
  }

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
      }, 400)
    }
  })()

  private scan(): void {
    if (this.scanning) return
    this.scanning = true
    try {
      this.found = this.queryCards()
      this.clampSelection()
      this.renderList()
      this.updateStats()
    } finally {
      this.scanning = false
    }
  }

  private clampSelection(): void {
    for (const i of Array.from(this.selected)) {
      if (i >= this.found.length) this.selected.delete(i)
    }
  }

  /** Detecta cada cartão de empresa na lista do Maps. */
  private queryCards(): ParsedCard[] {
    const anchors = document.querySelectorAll<HTMLElement>('a[href*="/maps/place/"]')
    const results: ParsedCard[] = []
    const seen = new Set<string>()

    for (const anchor of Array.from(anchors)) {
      const card = closestCard(anchor)
      const name = extractName(anchor, card)
      if (!name || seen.has(name.toLocaleLowerCase())) continue
      seen.add(name.toLocaleLowerCase())
      results.push({ lead: this.parseCard(card, name, anchor) })
    }
    return results
  }

  private parseCard(card: HTMLElement | null, name: string, link: HTMLElement): ScrapedLead {
    const text = (card?.innerText || link.innerText || '') ?? ''
    const href = (link as HTMLAnchorElement).href || ''
    const placeId = href.match(/(?:\?|&)place_id=([^&]+)/)
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
      place_id: placeId ? placeId[1] : null,
      maps_url: href || null,
    }
  }

  // ---- UI ----

  private updateStats(): void {
    const count = this.root?.querySelector('#consecom-count')
    if (count) count.textContent = String(this.found.length)
    const sel = this.root?.querySelector('#consecom-sel-count')
    if (sel) sel.textContent = String(this.selected.size)
  }

  private renderList(): void {
    const box = this.root?.querySelector('#consecom-list')
    if (!box || this.root === null) return
    box.innerHTML = ''
    if (this.found.length === 0) {
      box.innerHTML =
        '<div class="empty">Nenhuma empresa detectada ainda.<br>Faça a busca no Google Maps e a lista aparecerá aqui (ou clique em atualizar).</div>'
      return
    }
    this.found.forEach((item, i) => {
      const row = document.createElement('label')
      row.className = 'card' + (this.selected.has(i) ? ' checked' : '')
      row.innerHTML = `
        <input type="checkbox" data-idx="${i}" ${this.selected.has(i) ? 'checked' : ''}>
        <div class="card-body">
          <div class="card-name">${escapeHtml(item.lead.name)}</div>
          ${item.lead.rating != null ? `<div class="card-rating">★ ${item.lead.rating}${item.lead.reviews != null ? ` (${item.lead.reviews})` : ''}</div>` : ''}
          ${item.lead.category ? `<div class="card-sub">${escapeHtml(item.lead.category)}</div>` : ''}
          ${item.lead.phone ? `<div class="card-sub">${escapeHtml(item.lead.phone)}</div>` : ''}
        </div>`
      const cb = row.querySelector('input') as HTMLInputElement
      cb.addEventListener('change', () => {
        const idx = Number(cb.dataset.idx)
        if (cb.checked) this.selected.add(idx)
        else this.selected.delete(idx)
        row.classList.toggle('checked', cb.checked)
        this.updateStats()
      })
      box.appendChild(row)
    })
  }

  private toggleInput(): void {
    const form = this.root?.querySelector('#consecom-config-form') as HTMLElement | null
    if (!form) return
    const show = form.style.display === 'none'
    form.style.display = show ? 'block' : 'none'
    if (show && this.cfg) {
      ;(form.querySelector('#inp-url') as HTMLInputElement).value = this.cfg.supabaseUrl || ''
      ;(form.querySelector('#inp-key') as HTMLInputElement).value = this.cfg.anonKey || ''
    }
  }

  private async saveFromForm(): Promise<void> {
    const form = this.root?.querySelector('#consecom-config-form') as HTMLElement | null
    if (!form) return
    const url = ((form.querySelector('#inp-url') as HTMLInputElement).value || '').trim()
    const key = ((form.querySelector('#inp-key') as HTMLInputElement).value || '').trim()
    if (!url || !key) {
      alert('Informe a URL do projeto e a chave anon.')
      return
    }
    await saveConfig({ supabaseUrl: url, anonKey: key })
    this.cfg = { supabaseUrl: url, anonKey: key }
    const status = form.querySelector('#cfg-status')
    if (status) status.textContent = 'Configuração salva ✓'
  }

  private async importAll(): Promise<void> {
    this.cfg = this.cfg ?? (await getStoredConfig())
    if (!this.cfg || !this.cfg.supabaseUrl || !this.cfg.anonKey) {
      alert('Configure a URL do Supabase e a chave anon primeiro (botão ⚙).')
      this.toggleInput()
      return
    }
    const toImport = this.found.filter((_, i) => this.selected.has(i)).map((p) => p.lead)
    if (toImport.length === 0) {
      alert('Selecione pelo menos uma empresa para importar.')
      return
    }
    const btn = this.root?.querySelector('#consecom-import') as HTMLButtonElement | null
    const status = this.root?.querySelector('#consecom-import-status')
    if (btn) btn.disabled = true
    const res = await importLeads(this.cfg, toImport, (done, total) => {
      if (status) status.textContent = `Importando ${done}/${total}...`
    })
    if (btn) btn.disabled = false
    if (status) {
      status.textContent =
        res.failed === 0
          ? `✓ ${res.ok} lead(s) importado(s)`
          : `${res.ok} ok, ${res.failed} falharam${res.firstError ? ` (${res.firstError})` : ''}`
    }
    this.scan()
  }
}

// ---- helpers de extração ----

function closestCard(anchor: HTMLElement): HTMLElement | null {
  let el = anchor.parentElement
  for (let i = 0; i < 7 && el && el.tagName !== 'BODY'; i++) {
    if (el.getAttribute('role') === 'article') return el
    if (el.querySelector('span[aria-label*="stars"], span[aria-label*="avalia"], span[aria-label*="estrela"]')) {
      return el
    }
    if ((el.innerText || '').includes('\n') && el.querySelector('a[href*="/maps/place/"]')) return el
    el = el.parentElement
  }
  return anchor.closest('div[role="article"], [role="article"]') ?? null
}

function extractName(anchor: HTMLElement, card: HTMLElement | null): string | null {
  const a = anchor.querySelector('h3, [role="heading"], a[href*="/maps/place/"]')
  const t = (a?.textContent || anchor.textContent || '').trim()
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
  const a = card?.querySelector('a[data-tooltip="Abrir site"], a[data-tooltip="Website"]') as HTMLAnchorElement | null
  return a?.href || null
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

function injectStyles(): void {
  if (document.getElementById('consecom-css')) return
  const el = document.createElement('style')
  el.id = 'consecom-css'
  el.textContent = css
  document.head.appendChild(el)
}