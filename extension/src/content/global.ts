import { getStoredConfig, type StoredConfig } from '../shared/config'
import { importLeads, type ScrapedLead } from '../shared/leads'
import { classifyBrazilianPhone } from '../shared/phone'
import { injectStyles, showToast } from './index'
import {
  prospectWepsy,
  isWepsyCatalog,
  type WepsyContact,
} from './wepsy'

interface Contact {
  key: string
  name: string
  phone: string
  phone_normalized: string | null
  whatsapp: boolean
  context: string | null
  city: string | null
  state: string | null
  el: HTMLElement | null
}

const TELEPHONE_RE =
  /(?:\+?55[\s-]?)?(?:\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}/g

const MAX_RESULTS = 120

/**
 * Vyntra Prospector GLOBAL — funciona em QUALQUER página (não só Google Maps).
 * Varre o DOM da página atual e coleta links tel:, wa.me, api.whatsapp.com e
 * textos com telefone brasileiro, deduplicando por número normalizado. Mostra
 * um painel flutuante com a prévia (nome editável + seleção) e importa como
 * leads via importLeads (mesmo fluxo /importados do app).
 */
export class GlobalScanner {
  private cfg: StoredConfig | null = null
  private contacts: Contact[] = []
  private selected = new Set<string>()
  private balloon: HTMLElement | null = null
  private floatBtn: HTMLElement | null = null
  private headerEl: HTMLElement | null = null
  private listEl: HTMLElement | null = null
  private countEl: HTMLElement | null = null
  private locEl: HTMLElement | null = null
  private importing = false
  private isWepsy = false
  private wepsyProspecting = false
  private wepsyStop = { cancelled: false }
  private prospectBtn: HTMLButtonElement | null = null
  private stopBtn: HTMLButtonElement | null = null
  private statusEl: HTMLElement | null = null
  private maxInput: HTMLInputElement | null = null

  async init(): Promise<void> {
    this.cfg = await getStoredConfig()
    injectStyles()
    this.isWepsy = isWepsyCatalog(location.href)
    if (!this.isWepsy) {
      this.scan()
      const obs = new MutationObserver(() => this.debounceScan())
      obs.observe(document.body, { childList: true, subtree: true })
      window.addEventListener('scroll', () => this.debounceScan(), { passive: true })
    }

    window.addEventListener('click', (e) => {
      if (!this.balloon?.classList.contains('open')) return
      if (this.balloon.contains(e.target as Node)) return
      if (this.floatBtn?.contains(e.target as Node)) return
      this.toggleBalloon(false)
    })

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'consecom:open' || msg?.type === 'consecom:ping') {
        this.toggleBalloon(true)
      }
    })

    this.ensureLauncher()
  }

  private ensureLauncher(): void {
    if (this.balloon && this.balloon.classList.contains('open')) return
    if (this.floatBtn && document.body.contains(this.floatBtn)) return
    if (!this.floatBtn || !document.body.contains(this.floatBtn)) {
      this.floatBtn = this.buildFloatBtn()
      document.body.appendChild(this.floatBtn)
    }
    const pos = this.readPosition()
    this.floatBtn.style.right = `${pos.right}px`
    this.floatBtn.style.top = `${pos.top}px`
    requestAnimationFrame(() => this.floatBtn?.classList.add('open'))
  }

  private readPosition(): { right: number; top: number } {
    const right = parseFloat(localStorage.getItem('consecom-float-right') || '20')
    const top = parseFloat(localStorage.getItem('consecom-float-top') || '20')
    return {
      right: Math.max(12, Number.isFinite(right) ? right : 20),
      top: Math.max(12, Number.isFinite(top) ? top : 20),
    }
  }

  private savePosition(el: HTMLElement): void {
    const r = parseFloat(el.style.right) || 20
    const t = parseFloat(el.style.top) || 20
    localStorage.setItem('consecom-float-right', String(Math.max(12, r)))
    localStorage.setItem('consecom-float-top', String(Math.max(12, t)))
  }

  private buildFloatBtn(): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'consecom-floatbtn'
    btn.title = 'Abrir Vyntra'
    btn.textContent = 'V'
    btn.addEventListener('click', () => {
      if (btn.dataset.dragged === 'true') {
        btn.dataset.dragged = 'false'
        return
      }
      this.toggleBalloon(true)
    })
    this.enableDrag(btn, btn)
    return btn
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

  private scan(): void {
    const next = this.collect()
    // Mantém seleção de leads que continuam existindo; preserva nomes editados.
    const prev = new Map(this.contacts.map((c) => [c.key, c]))
    this.contacts = []
    for (const c of next) {
      const p = prev.get(c.key)
      if (p && p.name && !this.isDefaultName(p.name)) c.name = p.name
      this.contacts.push(c)
    }
    this.selected = new Set(
      Array.from(this.selected).filter((k) => this.contacts.some((c) => c.key === k)),
    )
    if (this.locEl) this.locEl.textContent = `${this.contacts.length} contato(s) encontrado(s)`
    if (this.balloon?.classList.contains('open')) this.renderList()
    else this.updateCounts()
  }

  private isDefaultName(name: string): boolean {
    return /^sem nome$/i.test(name.trim())
  }

  private collect(): Contact[] {
    const found = new Map<string, Contact>()
    const add = (raw: { name?: string; phone: string; el: HTMLElement | null; via?: string }) => {
      if (found.size >= MAX_RESULTS) return
      const pinfo = classifyBrazilianPhone(raw.phone)
      if (pinfo.class !== 'MOBILE') return
      const key = pinfo.e164!
      if (found.has(key)) {
        const existing = found.get(key)!
        if (!existing.name || this.isDefaultName(existing.name)) {
          if (raw.name && !this.isDefaultName(raw.name)) existing.name = raw.name
        }
        return
      }
      found.set(key, {
        key,
        name: raw.name && !this.isDefaultName(raw.name) ? raw.name : 'Sem nome',
        phone: raw.phone,
        phone_normalized: pinfo.e164,
        whatsapp: raw.via === 'wa' || raw.via === 'tel',
        context: this.guessContext(raw.el),
        city: null,
        state: null,
        el: raw.el,
      })
    }

    // 1) Links tel: (com texto do link ou heading próximo como nome)
    document.querySelectorAll<HTMLAnchorElement>('a[href^="tel:"]').forEach((a) => {
      const phone = a.getAttribute('href')!.replace('tel:', '').trim()
      add({ name: this.anchorName(a), phone, el: a, via: 'tel' })
    })

    // 2) Links wa.me / api.whatsapp.com
    document.querySelectorAll<HTMLAnchorElement>('a[href*="wa.me"], a[href*="api.whatsapp.com"]').forEach((a) => {
      const href = a.href || ''
      const m = href.match(/(?:wa\.me|whatsapp\.com)\/(?:send\?phone=)?([\d\s\-()+]+)/)
      const phone = m ? m[1].trim() : ''
      if (phone) add({ name: this.anchorName(a), phone, el: a, via: 'wa' })
    })

    // 3) Texto com telefone brasileiro em blocos semânticos (heading anterior como nome)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    let n = walker.nextNode()
    while (n) {
      if (n.nodeValue && n.nodeValue.trim()) nodes.push(n as Text)
      n = walker.nextNode()
    }
    for (const node of nodes) {
      const text = node.nodeValue || ''
      const cleaned = text.replace(/[\s.\-()]/g, '')
      if (!/^(\+?55)?\d{10,13}$/.test(cleaned)) continue
      const matches = text.match(TELEPHONE_RE)
      if (!matches) continue
      for (const m of matches) {
        if (found.size >= MAX_RESULTS) break
        const digits = m.replace(/\D/g, '')
        if (digits.length < 10 || digits.length > 13) continue
        add({ name: this.nodeName(node), phone: digits, el: node.parentElement, via: 'text' })
      }
    }

    return Array.from(found.values())
  }

  private anchorName(a: HTMLAnchorElement): string {
    const t = (a.textContent || '').trim()
    if (t && t.length < 60) return t.split('\n')[0].trim()
    const ctx = this.guessContext(a)
    return ctx ?? ''
  }

  private nodeName(node: Text): string {
    const ctx = this.guessContext(node.parentElement)
    return ctx ?? ''
  }

  /** Heurística: procura o heading/título mais próximo antes do elemento. */
  private guessContext(el: HTMLElement | null): string | null {
    if (!el) return null
    const headingSel = 'h1, h2, h3, h4, h5, h6, [aria-label], header, [role="heading"]'
    const own = el.querySelector<HTMLElement>(headingSel)
    if (own) {
      const t = own.textContent?.trim()
      if (t && t.length < 60) return t
    }
    let p: HTMLElement | null = el
    for (let i = 0; i < 4 && p; i++) {
      const h = p.querySelector<HTMLElement>(headingSel)
      if (h) {
        const t = h.textContent?.trim()
        if (t && t.length < 60 && t !== el.textContent?.trim()) return t
      }
      p = p.parentElement
    }
    // Fallback: título do documento, exceto quando igual à URL/domínio.
    const title = document.title?.trim()
    if (title && title.length < 80 && !/^\d+$/.test(title)) return title
    return null
  }

  // --- painel flutuante ---

  private toggleBalloon(open?: boolean): void {
    const shouldOpen = open ?? !this.balloon?.classList.contains('open')
    if (!this.balloon || !document.body.contains(this.balloon)) {
      if (shouldOpen) this.ensureBalloon()
      return
    }
    this.balloon.classList.toggle('open', shouldOpen)
    if (shouldOpen) this.renderList()
    else this.ensureLauncher()
  }

  private ensureBalloon(): void {
    if (this.balloon && document.body.contains(this.balloon)) {
      const pos = this.readPosition()
      this.balloon.style.right = `${pos.right}px`
      this.balloon.style.top = `${pos.top}px`
      requestAnimationFrame(() => this.balloon?.classList.add('open'))
      this.renderList()
      return
    }
    this.balloon = this.buildBalloon()
    const pos = this.readPosition()
    this.balloon.style.right = `${pos.right}px`
    this.balloon.style.top = `${pos.top}px`
    document.body.appendChild(this.balloon)
    requestAnimationFrame(() => this.balloon?.classList.add('open'))
    this.renderList()
  }

  private buildBalloon(): HTMLElement {
    const balloon = document.createElement('aside')
    balloon.className = 'consecom-balloon'

    const header = document.createElement('div')
    header.className = 'cs-panel__header'
    this.headerEl = header

    const grip = document.createElement('div')
    grip.className = 'cs-panel__grip'
    grip.title = 'Arrastar painel'
    grip.innerHTML = '&#8230;<br>&#8230;<br>&#8230;'

    const logo = document.createElement('div')
    logo.className = 'cs-panel__logo'
    logo.textContent = 'V'
    const titles = document.createElement('div')
    titles.className = 'cs-panel__titles'
    const name = document.createElement('div')
    name.className = 'cs-panel__name'
    name.textContent = 'VYNTRA'
    const tag = document.createElement('div')
    tag.className = 'cs-panel__tag'
    tag.textContent = this.isWepsy ? 'Prospector Wepsy' : 'Prospector Global'
    const tagline = document.createElement('div')
    tagline.className = 'cs-panel__tagline'
    tagline.textContent = this.isWepsy
      ? 'Busca psicólogos do catálogo Wepsy e importa os contatos com WhatsApp público.'
      : 'Contatos encontrados nesta página. Revise e importe como leads.'
    titles.append(name, tag, tagline)

    const controls = document.createElement('div')
    controls.className = 'cs-panel__controls'
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'cs-panel__btn'
    closeBtn.title = 'Fechar'
    closeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M18.3 5.71 12 12l6.3 6.29-1 1L12 14l-6.3 6.3-1-1L10.8 12 4.5 5.7l1-1L12 10.8l6.3-6.3z"/></svg>'
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleBalloon(false)
    })
    controls.appendChild(closeBtn)
    header.append(grip, logo, titles, controls)
    this.enableDrag(header, balloon)

    const body = document.createElement('div')
    body.className = 'cs-panel__body'

    if (this.isWepsy) {
      // Barra de prospecção Wepsy (CTA + max + status + parar).
      const cta = document.createElement('div')
      cta.className = 'cs-filters'
      const prospectBtn = document.createElement('button')
      prospectBtn.type = 'button'
      prospectBtn.className = 'cs-prospect'
      prospectBtn.textContent = 'PROSPECTAR'
      prospectBtn.addEventListener('click', () => void this.doWepsy())
      this.prospectBtn = prospectBtn
      const stopBtn = document.createElement('button')
      stopBtn.type = 'button'
      stopBtn.className = 'cs-footer__btn cs-foot-clear'
      stopBtn.textContent = 'Parar'
      stopBtn.style.display = 'none'
      stopBtn.addEventListener('click', () => {
        this.wepsyStop.cancelled = true
      })
      this.stopBtn = stopBtn
      const maxWrap = document.createElement('label')
      maxWrap.className = 'cs-adv__item'
      maxWrap.style.margin = '0 0 0 8px'
      const maxLab = document.createElement('span')
      maxLab.textContent = 'Máx.'
      const maxInput = document.createElement('input')
      maxInput.type = 'number'
      maxInput.min = '10'
      maxInput.max = '2965'
      maxInput.value = '200'
      maxInput.style.width = '70px'
      maxInput.className = 'bg-field border border-line-2 rounded px-2 py-1 text-sm'
      this.maxInput = maxInput
      maxWrap.append(maxLab, maxInput)
      const ctaRow = document.createElement('div')
      ctaRow.className = 'cs-chips'
      ctaRow.style.flexWrap = 'wrap'
      ctaRow.append(prospectBtn, maxWrap, stopBtn)
      const status = document.createElement('div')
      status.className = 'cs-panel__loc'
      status.innerHTML = pinIcon
      this.statusEl = document.createElement('span')
      this.statusEl.textContent =
        this.contacts.length > 0
          ? `${this.contacts.length} contato(s) encontrado(s)`
          : 'Toque em PROSPECTAR para buscar os psicólogos desta página.'
      status.append(this.statusEl)
      cta.append(ctaRow, status)
      body.appendChild(cta)
    } else {
      const loc = document.createElement('div')
      loc.className = 'cs-panel__loc'
      loc.innerHTML = pinIcon
      this.locEl = document.createElement('span')
      this.locEl.textContent = `${this.contacts.length} contato(s) encontrado(s)`
      loc.append(this.locEl)
      body.appendChild(loc)
    }

    const list = document.createElement('div')
    list.className = 'cs-panel__list'
    this.listEl = list
    body.appendChild(list)

    const footer = document.createElement('div')
    footer.className = 'cs-panel__footer'
    const countEl = document.createElement('div')
    countEl.className = 'cs-footer__count'
    this.countEl = countEl
    const row2 = document.createElement('div')
    row2.className = 'cs-footer__row'
    const clearBtn = document.createElement('button')
    clearBtn.type = 'button'
    clearBtn.className = 'cs-footer__btn cs-foot-clear'
    clearBtn.innerHTML = 'Limpar' + trashIcon
    clearBtn.addEventListener('click', () => {
      this.selected.clear()
      this.renderList()
      showToast('Seleção limpa')
    })
    const selectAllBtn = document.createElement('button')
    selectAllBtn.type = 'button'
    selectAllBtn.className = 'cs-footer__btn cs-foot-config'
    selectAllBtn.title = 'Seleciona até 50 contatos (limite por importação)'
    selectAllBtn.textContent = 'Sel. todos'
    selectAllBtn.addEventListener('click', () => {
      const keys = this.contacts.slice(0, 50).map((c) => c.key)
      this.selected = new Set(keys)
      this.renderList()
      showToast(`✓ ${Math.min(50, this.contacts.length)} selecionado(s)`)
    })
    const importBtn = document.createElement('button')
    importBtn.type = 'button'
    importBtn.className = 'cs-footer__btn cs-foot-config'
    importBtn.title = 'Importar selecionados'
    importBtn.innerHTML = 'Importar' + downloadIcon
    importBtn.addEventListener('click', () => void this.doImport(importBtn))
    row2.append(clearBtn, selectAllBtn, importBtn)
    footer.append(countEl, row2)

    balloon.append(header, body, footer)
    return balloon
  }

  private renderList(): void {
    if (!this.listEl) return
    this.updateCounts()
    if (this.contacts.length === 0) {
      this.listEl.innerHTML = ''
      const empty = document.createElement('div')
      empty.className = 'cs-empty'
      empty.innerHTML = this.isWepsy
        ? '<b>0 contatos</b><br/>Toque em PROSPECTAR para buscar os psicólogos do catálogo Wepsy.'
        : '<b>0 contatos encontrados</b><br/>Nenhum telefone móvel detectado nesta página. Acesse uma página com contatos e tente novamente.'
      this.listEl.appendChild(empty)
      return
    }
    const frag = document.createDocumentFragment()
    for (const c of this.contacts) {
      frag.appendChild(this.buildRow(c))
    }
    this.listEl.replaceChildren(frag)
  }

  private buildRow(c: Contact): HTMLElement {
    const row = document.createElement('div')
    row.className = 'cs-pcard'
    row.dataset.key = c.key

    const top = document.createElement('div')
    top.className = 'cs-pcard__top'
    const nm = document.createElement('div')
    nm.className = 'cs-pcard__name'
    nm.textContent = c.name
    nm.title = c.name
    const badge = document.createElement('div')
    badge.className = 'cs-pcard__badge cs-band--media'
    badge.textContent = c.whatsapp ? 'WhatsApp' : 'Celular'
    top.append(nm, badge)

    const meta = document.createElement('div')
    meta.className = 'cs-pcard__meta'
    meta.textContent = c.phone
    if (c.context && c.context !== c.name) meta.textContent += ` • ${c.context}`

    const actions = document.createElement('div')
    actions.className = 'cs-pcard__actions'
    const leadBtn = document.createElement('button')
    leadBtn.type = 'button'
    leadBtn.className = 'cs-pcard__btn cs-pcard__lead'
    leadBtn.innerHTML = (this.selected.has(c.key) ? checkIcon : plusIcon) + '<span data-role="lead-label">Lead</span>'
    leadBtn.addEventListener('click', () => {
      if (this.selected.has(c.key)) this.selected.delete(c.key)
      else this.selected.add(c.key)
      this.renderList()
    })
    actions.append(leadBtn)

    row.append(top, meta, actions)
    this.updateRow(row, c)
    return row
  }

  private updateRow(row: HTMLElement, c: Contact): void {
    const leadBtn = row.querySelector('.cs-pcard__lead') as HTMLButtonElement | null
    if (!leadBtn) return
    leadBtn.classList.toggle('on', this.selected.has(c.key))
    leadBtn.innerHTML = (this.selected.has(c.key) ? checkIcon : plusIcon) + '<span data-role="lead-label">Lead</span>'
  }

  private updateCounts(): void {
    if (this.countEl) {
      this.countEl.innerHTML = `<b>${this.contacts.length}</b> encontrados · <b>${this.selected.size}</b> selecionados`
    }
  }

  private async doImport(btn: HTMLButtonElement): Promise<void> {
    if (this.importing) return
    this.cfg = this.cfg ?? (await getStoredConfig())
    if (!this.cfg || !this.cfg.extensionKey || !this.cfg.ownerUserId) {
      alert('Baixe novamente a extensão no painel Vyntra para vincular à sua conta.')
      return
    }
    const leads: ScrapedLead[] = this.contacts
      .filter((c) => this.selected.has(c.key))
      .map((c) => ({
        name: c.name,
        phone: c.phone,
        category: this.isWepsy ? 'Psicólogo' : null,
        website: null,
        address: null,
        city: c.city,
        state: c.state,
        rating: null,
        reviews: null,
        latitude: null,
        longitude: null,
        place_id: null,
        instagram: null,
        facebook: null,
      }))
      .slice(0, 50)
    if (leads.length === 0) {
      showToast('Selecione ao menos um contato para importar.', 'warn')
      return
    }

    this.importing = true
    const prev = btn.innerHTML
    btn.disabled = true
    try {
      let done = 0
      const res = await importLeads(
        this.cfg,
        leads,
        (d, total) => {
          done = d
          btn.textContent = `${d}/${total}…`
        },
        {
          source: 'url_prospecting',
          sourceDetail: window.location.href,
          tags: ['url_prospecting', 'extensao_global'],
          prospectedAt: new Date().toISOString(),
        },
      )
      btn.textContent = res.failed === 0 ? '✓' : `${res.ok} ok, ${res.failed} falharam`
      if (res.failed === 0) {
        showToast(res.ok > 0 ? `✅ ${res.ok} lead(s) importado(s)!` : 'Nenhum lead novo para importar.')
        this.selected.clear()
      } else {
        showToast(`⚠️ ${res.ok} ok, ${res.failed} falharam${res.firstError ? `: ${res.firstError}` : ''}`, 'warn')
      }
      this.renderList()
      setTimeout(() => {
        btn.innerHTML = prev
        btn.disabled = false
      }, 3000)
      void done
    } catch (err) {
      btn.textContent = `Erro: ${err}`
      setTimeout(() => {
        btn.innerHTML = prev
        btn.disabled = false
      }, 3000)
    } finally {
      this.importing = false
    }
  }

  /** Adiciona um contato vindo do adaptador Wepsy (dedup por número). */
  private addWepsyContact(wc: WepsyContact): void {
    if (this.contacts.some((c) => c.key === wc.key)) {
      // Aproveita o nome se o novo for melhor.
      const ex = this.contacts.find((c) => c.key === wc.key)!
      if ((!ex.name || this.isDefaultName(ex.name)) && !this.isDefaultName(wc.name)) ex.name = wc.name
      return
    }
    this.contacts.push({
      key: wc.key,
      name: wc.name,
      phone: wc.phone,
      phone_normalized: wc.key,
      whatsapp: wc.whatsapp,
      context: [wc.city, wc.state].filter(Boolean).join(' · ') || null,
      city: wc.city,
      state: wc.state,
      el: null,
    })
  }

  /** Prospecção Wepsy: pagina o catálogo e busca perfis (API pública). */
  private async doWepsy(): Promise<void> {
    if (this.wepsyProspecting) return
    this.cfg = this.cfg ?? (await getStoredConfig())
    if (!this.cfg || !this.cfg.extensionKey || !this.cfg.ownerUserId) {
      alert('Baixe novamente a extensão no painel Vyntra para vincular à sua conta.')
      return
    }
    const max = Math.min(
      2965,
      Math.max(10, parseInt(this.maxInput?.value || '200', 10) || 200),
    )
    this.wepsyProspecting = true
    this.wepsyStop = { cancelled: false }
    if (this.prospectBtn) {
      this.prospectBtn.disabled = true
      this.prospectBtn.textContent = 'PROSPECTANDO…'
    }
    if (this.stopBtn) this.stopBtn.style.display = 'inline-block'
    let last = 0
    try {
      await prospectWepsy({
        max,
        signal: this.wepsyStop,
        onResult: (wc) => {
          this.addWepsyContact(wc)
          // Throttle render: a cada ~3 contatos ou 250ms.
          const now = Date.now()
          if (now - last > 250 || this.contacts.length % 3 === 0) {
            last = now
            if (this.statusEl) this.statusEl.textContent = `${this.contacts.length} contato(s) encontrado(s)`
            this.renderList()
          }
        },
        onProgress: (msg) => {
          if (this.statusEl) this.statusEl.textContent = `${msg} · ${this.contacts.length} ok`
        },
      })
      if (!this.wepsyStop.cancelled) {
        showToast(`✓ ${this.contacts.length} contato(s) encontrado(s).`)
      }
    } catch (err) {
      showToast(`Erro na prospecção Wepsy: ${err}`, 'warn')
    } finally {
      this.wepsyProspecting = false
      if (this.prospectBtn) {
        this.prospectBtn.disabled = false
        this.prospectBtn.textContent = this.contacts.length > 0 ? 'PROSPECTAR MAIS' : 'PROSPECTAR'
      }
      if (this.stopBtn) this.stopBtn.style.display = 'none'
      if (this.statusEl) this.statusEl.textContent = `${this.contacts.length} contato(s) encontrado(s)`
      this.renderList()
    }
  }

  // --- drag ---

  private enableDrag(handle: HTMLElement, target: HTMLElement): void {
    const MIN_EDGE = 12
    let active = false
    let moved = false
    let startX = 0
    let startY = 0
    let startRight = 0
    let startTop = 0

    const down = (e: PointerEvent) => {
      if (e.button !== 0 || active) return
      const t = e.target as HTMLElement | null
      if (t && t !== handle && t.closest('button, input, select, textarea, a, .cs-panel__controls, [data-no-drag]')) return
      e.preventDefault()
      active = true
      moved = false
      target.dataset.dragged = 'false'
      startX = e.clientX
      startY = e.clientY
      startRight = parseFloat(target.style.right) || 20
      startTop = parseFloat(target.style.top) || 20
      try {
        handle.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }

    const move = (e: PointerEvent) => {
      if (!active) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
      const maxRight = Math.max(0, window.innerWidth - MIN_EDGE - target.offsetWidth)
      const maxTop = Math.max(0, window.innerHeight - MIN_EDGE - target.offsetHeight)
      const right = Math.min(Math.max(0, startRight - dx), maxRight)
      const top = Math.min(Math.max(0, startTop + dy), maxTop)
      target.style.right = `${right}px`
      target.style.top = `${top}px`
      target.style.left = ''
      target.style.bottom = ''
    }

    const up = (e: PointerEvent) => {
      if (!active) return
      active = false
      try {
        if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      if (moved) {
        target.dataset.dragged = 'true'
        this.savePosition(target)
      }
    }

    handle.addEventListener('pointerdown', down)
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
    handle.addEventListener('lostpointercapture', () => {
      active = false
    })
  }
}

const checkIcon = '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>'
const plusIcon = '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>'
const pinIcon = '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>'
const downloadIcon = '<svg viewBox="0 0 24 24"><path d="M11 5h2v7h2l-3 3-3-3h2V5zm-6 12h14v2H5v-2z"/></svg>'
const trashIcon = '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>'