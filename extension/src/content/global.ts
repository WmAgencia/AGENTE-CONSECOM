import { getStoredConfig, type StoredConfig } from '../shared/config'
import { getPlanQuota, getExtensionSites, importLeads, type ExtensionSites, type PlanQuota, type ScrapedLead } from '../shared/leads'
import { classifyBrazilianPhone } from '../shared/phone'
import { injectStyles, showToast } from './index'
import {
  prospectWepsy,
  isWepsyCatalog,
  type WepsyContact,
} from './wepsy'
import {
  prospectWebMotors,
  isWebMotorsList,
  type WebMotorsContact,
} from './webmotors'

type AdapterMode = 'global' | 'wepsy' | 'webmotors'

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
  private imported = new Set<string>()
  private importStop = false
  private mode: AdapterMode = 'global'
  private planQuota: PlanQuota | null = null
  private planEl: HTMLElement | null = null
  private prospecting = false
  private stopFlag = { cancelled: false }
  private prospectBtn: HTMLButtonElement | null = null
  private stopBtn: HTMLButtonElement | null = null
  private statusEl: HTMLElement | null = null
  private maxInput: HTMLInputElement | null = null
  private sites: ExtensionSites = { maps: true, webmotors: true, wepsy: true }
  private sitesEl: HTMLElement | null = null
  private searchCity: HTMLInputElement | null = null
  private searchState: HTMLInputElement | null = null
  private filterBtns: HTMLButtonElement[] = []

  async init(): Promise<void> {
    this.cfg = await getStoredConfig()
    injectStyles()
    this.sites = await getExtensionSites()
    this.mode = isWepsyCatalog(location.href)
      ? 'wepsy'
      : isWebMotorsList(location.href)
        ? 'webmotors'
        : 'global'
    // Se o site atual estiver desativado no Master, não opera.
    const activeHere = this.mode === 'wepsy' ? this.sites.wepsy : this.sites.webmotors
    if (this.mode !== 'global' && !activeHere) return
    if (this.mode === 'global') {
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
    if (shouldOpen) {
      this.renderList()
      void this.refreshQuota()
    } else this.ensureLauncher()
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
    void this.refreshQuota()
    this.balloon.style.right = `${pos.right}px`
    this.balloon.style.top = `${pos.top}px`
    document.body.appendChild(this.balloon)
    requestAnimationFrame(() => this.balloon?.classList.add('open'))
    this.renderList()
  }

  private buildBalloon(): HTMLElement {
    const balloon = document.createElement('aside')
    balloon.className = 'consecom-balloon'

    // Grip fino (arrastar) + fechar. Sem branding grande, mantém o arraste.
    const header = document.createElement('div')
    header.className = 'cs-panel__header cs-panel__header--slim'
    this.headerEl = header
    const grip = document.createElement('div')
    grip.className = 'cs-panel__grip'
    grip.title = 'Arrastar painel'
    grip.innerHTML = '&#8942;&#8942;'
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'cs-panel__btn'
    closeBtn.title = 'Fechar'
    closeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12"><path fill="currentColor" d="M18.3 5.71 12 12l6.3 6.29-1 1L12 14l-6.3 6.3-1-1L10.8 12 4.5 5.7l1-1L12 10.8l6.3-6.3z"/></svg>'
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.toggleBalloon(false)
    })
    header.append(grip, closeBtn)
    this.enableDrag(header, balloon)

    const body = document.createElement('div')
    body.className = 'cs-panel__body'

    // Faixa de sites (ativação controlada no Master; desativados ficam cinza).
    const sites = document.createElement('div')
    sites.className = 'cs-sites'
    this.sitesEl = sites
    const siteDefs = [
      { key: 'maps' as const, label: 'GOOGLE MAPS' },
      { key: 'webmotors' as const, label: 'WEBMOTORS' },
      { key: 'wepsy' as const, label: 'WEPSY' },
    ]
    for (const s of siteDefs) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'cs-site'
      b.dataset.site = s.key
      b.textContent = s.label
      const on = this.sites[s.key] !== false
      if (!on) {
        b.classList.add('cs-site--off')
        b.disabled = true
        b.title = 'Desativado no painel Master'
      } else if (this.mode === s.key) {
        b.classList.add('cs-site--active')
      }
      sites.appendChild(b)
    }

    // Barra de busca: cidade + estado (Wepsy / WebMotors) + botão PESQUISAR.
    const search = document.createElement('div')
    search.className = 'cs-search'
    const fields = document.createElement('div')
    fields.className = 'cs-search__fields'
    const cityWrap = document.createElement('label')
    cityWrap.className = 'cs-search__field'
    const cityLab = document.createElement('span')
    cityLab.textContent = 'CIDADE'
    const cityInput = document.createElement('input')
    cityInput.type = 'text'
    cityInput.className = 'cs-search__input'
    cityInput.placeholder = 'Ex.: Sorocaba'
    cityInput.autocomplete = 'off'
    this.searchCity = cityInput
    cityWrap.append(cityLab, cityInput)
    const stateWrap = document.createElement('label')
    stateWrap.className = 'cs-search__field cs-search__field--sm'
    const stateLab = document.createElement('span')
    stateLab.textContent = 'ESTADO'
    const stateInput = document.createElement('input')
    stateInput.type = 'text'
    stateInput.className = 'cs-search__input'
    stateInput.placeholder = 'SP'
    stateInput.maxLength = 2
    stateInput.autocomplete = 'off'
    this.searchState = stateInput
    stateWrap.append(stateLab, stateInput)
    fields.append(cityWrap, stateWrap)
    const searchBtn = document.createElement('button')
    searchBtn.type = 'button'
    searchBtn.className = 'cs-search__btn'
    searchBtn.textContent = 'PESQUISAR'
    searchBtn.addEventListener('click', () => void this.doSearch())
    search.append(fields, searchBtn)
    body.appendChild(sites)

    // Filtros: NOTA BAIXA / SEM SITE / COM WHATSAPP.
    const filters = document.createElement('div')
    filters.className = 'cs-filters2'
    const filtersTitle = document.createElement('div')
    filtersTitle.className = 'cs-filters2__title'
    filtersTitle.textContent = 'FILTROS'
    const chips = document.createElement('div')
    chips.className = 'cs-chips'
    const chipDefs = ['NOTA BAIXA', 'SEM SITE', 'COM WHATSAPP']
    this.filterBtns = []
    for (const t of chipDefs) {
      const c = document.createElement('button')
      c.type = 'button'
      c.className = 'cs-chip'
      c.textContent = t
      c.addEventListener('click', () => {
        c.classList.toggle('cs-chip--on')
        this.renderList()
      })
      this.filterBtns.push(c)
      chips.appendChild(c)
    }
    filters.append(filtersTitle, chips)

    // PROSPECTAR (CTA principal).
    const prospectBtn = document.createElement('button')
    prospectBtn.type = 'button'
    prospectBtn.className = 'cs-prospect'
    prospectBtn.textContent = 'PROSPECTAR'
    prospectBtn.addEventListener('click', () => void this.doProspect())
    this.prospectBtn = prospectBtn

    const status = document.createElement('div')
    status.className = 'cs-panel__loc'
    status.innerHTML = pinIcon
    this.statusEl = document.createElement('span')
    this.statusEl.textContent =
      this.contacts.length > 0
        ? `${this.contacts.length} contato(s) encontrado(s)`
        : this.mode === 'wepsy'
          ? 'Preencha cidade/estado e toque em PESQUISAR, ou PROSPECTAR para buscar o catálogo.'
          : 'Preencha cidade/estado e toque em PESQUISAR, ou PROSPECTAR para buscar as lojas desta busca.'
    status.append(this.statusEl)

    // Área de leads com scroll.
    const leads = document.createElement('div')
    leads.className = 'cs-leads'
    const leadsTitle = document.createElement('div')
    leadsTitle.className = 'cs-leads__title'
    leadsTitle.textContent = 'AREA DE LEADS E SCROLL'
    const list = document.createElement('div')
    list.className = 'cs-panel__list'
    this.listEl = list
    const planEl = document.createElement('div')
    planEl.className = 'cs-panel__plan'
    planEl.style.display = 'none'
    this.planEl = planEl
    leads.append(leadsTitle, list, planEl)

    body.append(search, filters, prospectBtn, status, leads)

    // Rodapé: EXCLUIR / LIMPAR + IMPORTAR LEADS.
    const footer = document.createElement('div')
    footer.className = 'cs-panel__footer'
    const countEl = document.createElement('div')
    countEl.className = 'cs-footer__count'
    this.countEl = countEl
    const row = document.createElement('div')
    row.className = 'cs-footer__row'
    const excludeBtn = document.createElement('button')
    excludeBtn.type = 'button'
    excludeBtn.className = 'cs-footer__btn cs-foot-delete'
    excludeBtn.textContent = 'EXCLUIR'
    excludeBtn.addEventListener('click', () => {
      this.contacts = this.contacts.filter((c) => !this.selected.has(c.key))
      this.selected.clear()
      this.renderList()
    })
    const clearBtn = document.createElement('button')
    clearBtn.type = 'button'
    clearBtn.className = 'cs-footer__btn cs-foot-clear'
    clearBtn.textContent = 'LIMPAR'
    clearBtn.addEventListener('click', () => {
      this.contacts = []
      this.selected.clear()
      this.renderList()
    })
    row.append(excludeBtn, clearBtn)
    const importBtn = document.createElement('button')
    importBtn.type = 'button'
    importBtn.className = 'cs-footer__btn cs-foot-import cs-import'
    importBtn.textContent = 'IMPORTAR LEADS'
    importBtn.addEventListener('click', () => void this.doImport(importBtn))
    footer.append(countEl, row, importBtn)

    balloon.append(header, body, footer)
    return balloon
  }

  /** Busca: navega para a busca do site (cidade/estado) com os valores digitados. */
  private doSearch(): void {
    const city = (this.searchCity?.value ?? '').trim()
    const state = (this.searchState?.value ?? '').trim().toUpperCase()
    if (this.mode === 'webmotors') {
      if (!city) return showToast('Digite a cidade para pesquisar no WebMotors.', 'warn')
      const url = state
        ? `https://www.webmotors.com.br/carros/${state.toLowerCase()}/${city.toLowerCase().replace(/\s+/g, '-')}`
        : `https://www.webmotors.com.br/carros/${city.toLowerCase().replace(/\s+/g, '-')}`
      window.location.href = url
    } else if (this.mode === 'wepsy') {
      if (!city) return showToast('Digite a cidade para pesquisar na Wepsy.', 'warn')
      window.location.href = `https://www.wepsy.com.br/catalogo`
      showToast('Pesquise a cidade na página da Wepsy e toque em PROSPECTAR.')
    } else {
      showToast('Selecione um site para pesquisar.', 'warn')
    }
  }

  private renderList(): void {
    if (!this.listEl) return
    this.updateCounts()
    if (this.contacts.length === 0) {
      this.listEl.innerHTML = ''
      const empty = document.createElement('div')
      empty.className = 'cs-empty'
      empty.innerHTML =
        this.mode === 'wepsy'
          ? '<b>0 contatos</b><br/>Toque em PROSPECTAR para buscar os psicólogos do catálogo Wepsy.'
          : this.mode === 'webmotors'
            ? '<b>0 contatos</b><br/>Toque em PROSPECTAR para buscar as lojas desta busca no WebMotors.'
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
      if (this.imported.has(c.key)) return
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
    const label = leadBtn.querySelector('[data-role="lead-label"]') as HTMLElement | null
    if (this.imported.has(c.key)) {
      leadBtn.classList.add('used')
      leadBtn.classList.remove('on')
      leadBtn.disabled = true
      if (label) label.textContent = 'Importado'
      row.style.opacity = '0.55'
      return
    }
    row.style.opacity = ''
    leadBtn.disabled = false
    leadBtn.classList.toggle('on', this.selected.has(c.key))
    leadBtn.innerHTML = (this.selected.has(c.key) ? checkIcon : plusIcon) + '<span data-role="lead-label">Lead</span>'
  }

  private updateCounts(): void {
    if (this.countEl) {
      const imp = this.imported.size
      this.countEl.innerHTML =
        `<b>${this.contacts.length}</b> encontrados · <b>${this.selected.size}</b> selecionados` +
        (imp > 0 ? ` · <b>${imp}</b> importados` : '')
    }
  }

  /** Busca o saldo de leads do plano e atualiza o badge do painel. */
  private async refreshQuota(): Promise<void> {
    this.cfg = this.cfg ?? (await getStoredConfig())
    if (!this.cfg) return
    const quota = await getPlanQuota(this.cfg)
    this.planQuota = quota
    if (this.planEl) {
      if (quota && quota.limited) {
        const remaining = quota.remaining ?? 0
        this.planEl.style.display = ''
        this.planEl.textContent = `Plano: ${quota.used}/${quota.limit} leads usados · ${remaining} restantes`
        this.planEl.style.color = remaining <= 0 ? '#f87171' : '#6ee7b7'
      } else {
        this.planEl.style.display = 'none'
      }
    }
  }

  private async doImport(btn: HTMLButtonElement): Promise<void> {
    if (this.importing) return
    this.cfg = this.cfg ?? (await getStoredConfig())
    if (!this.cfg || !this.cfg.extensionKey || !this.cfg.ownerUserId) {
      alert('Baixe novamente a extensão no painel Vyntra para vincular à sua conta.')
      return
    }
    await this.refreshQuota()
    if (this.planQuota?.limited && (this.planQuota.remaining ?? 0) <= 0) {
      showToast('Seu plano de leads está esgotado. Renove/assine um plano no painel Vyntra.', 'warn')
      return
    }
    const selectedContacts = this.contacts
      .filter((c) => this.selected.has(c.key) && !this.imported.has(c.key))
    const leads: ScrapedLead[] = selectedContacts
      .map((c) => this.contactToLead(c))
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
        this.importOptions(),
      )
      for (const c of selectedContacts.slice(0, 50)) this.imported.add(c.key)
      btn.textContent = res.failed === 0 ? '✓' : `${res.ok} ok, ${res.failed} falharam`
      await this.refreshQuota()
      if (res.quotaCut && res.quotaCut > 0) {
        showToast(`⚠️ Plano atingiu o limite: ${res.quotaCut} lead(s) não importados. Renove/assine um plano.`, 'warn')
      } else if (res.failed === 0) {
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

  private contactToLead(c: Contact): ScrapedLead {
    return {
      name: c.name,
      phone: c.phone,
      category:
        this.mode === 'wepsy'
          ? 'Psicólogo'
          : this.mode === 'webmotors'
            ? 'Loja de Carros'
            : null,
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
    }
  }

  private importOptions() {
    return {
      source: 'url_prospecting',
      sourceDetail: window.location.href,
      tags: ['url_prospecting', 'extensao_global'],
      prospectedAt: new Date().toISOString(),
    }
  }

  /**
   * Importa TODOS os contatos restantes em lotes de 50, automaticamente:
   * lote 1 (1-50) → lote 2 (51-100) → ... até terminarem.
   * Mostra progresso no botão e marca os contatos como importados na lista.
   */
  private async doImportBatches(btn: HTMLButtonElement): Promise<void> {
    if (this.importing) return
    this.cfg = this.cfg ?? (await getStoredConfig())
    if (!this.cfg || !this.cfg.extensionKey || !this.cfg.ownerUserId) {
      alert('Baixe novamente a extensão no painel Vyntra para vincular à sua conta.')
      return
    }
    const remaining = this.contacts.filter((c) => !this.imported.has(c.key))
    if (remaining.length === 0) {
      showToast('Todos os contatos já foram importados.', 'warn')
      return
    }
    await this.refreshQuota()
    if (this.planQuota?.limited && (this.planQuota.remaining ?? 0) <= 0) {
      showToast('Seu plano de leads está esgotado. Renove/assine um plano no painel Vyntra.', 'warn')
      return
    }
    this.importing = true
    this.importStop = false
    const prev = btn.textContent
    btn.disabled = true
    let totalOk = 0
    let totalFailed = 0
    let batch = 0
    let planExhausted = false
    const totalBatches = Math.ceil(remaining.length / 50)
    try {
      for (let i = 0; i < remaining.length; i += 50) {
        if (this.importStop) break
        batch++
        const chunk = remaining.slice(i, i + 50)
        const leads = chunk.map((c) => this.contactToLead(c))
        btn.textContent = `Lote ${batch}/${totalBatches} · ${totalOk} ok`
        // seleciona visualmente o lote atual
        this.selected = new Set(chunk.map((c) => c.key))
        this.renderList()
        const res = await importLeads(this.cfg, leads, (d, t) => {
          btn.textContent = `Lote ${batch}/${totalBatches} · ${d}/${t}…`
        }, this.importOptions())
        totalOk += res.ok
        totalFailed += res.failed
        for (const c of chunk) this.imported.add(c.key)
        this.selected.clear()
        this.renderList()
        if ((res.quotaCut && res.quotaCut > 0) || (res.failed > 0 && res.firstError && /plano|esgotado|exhausted/i.test(res.firstError))) {
          planExhausted = true
          this.importStop = true
          showToast(`⚠️ Plano atingiu o limite de leads. Importação parada em ${totalOk} lead(s). Renove/assine um plano.`, 'warn')
          break
        }
        if (res.failed > 0 && res.firstError) {
          showToast(`⚠️ Lote ${batch}: ${res.failed} falharam: ${res.firstError}`, 'warn')
        }
      }
      btn.textContent = this.importStop
        ? `Parado · ${totalOk} ok`
        : `✓ ${totalOk} lead(s) importado(s)`
      showToast(
        this.importStop
          ? `⏹ Importação interrompida. ${totalOk} lead(s) importado(s).`
          : `✅ ${totalOk} lead(s) importado(s) em ${batch} lote(s)!`,
      )
      if (totalFailed > 0) showToast(`⚠️ ${totalFailed} falharam no total.`, 'warn')
    } catch (err) {
      btn.textContent = `Erro: ${err}`
      showToast(`Erro ao importar: ${err}`, 'warn')
    } finally {
      this.importing = false
      this.importStop = false
      this.selected.clear()
      this.renderList()
      setTimeout(() => {
        btn.textContent = prev
        btn.disabled = false
      }, 4000)
    }
  }

  /** Adiciona um contato vindo de um adaptador (Wepsy/WebMotors, dedup por número). */
  private addAdapterContact(wc: WepsyContact | WebMotorsContact): void {
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

  /** Limite máximo de contatos por adaptador. */
  private adapterMax(): number {
    return this.mode === 'webmotors' ? 167000 : this.mode === 'wepsy' ? 2965 : 500
  }

  /** Prospecção via adaptador: pagina a fonte e coleta contatos (API pública). */
  private async doProspect(): Promise<void> {
    if (this.prospecting) return
    this.cfg = this.cfg ?? (await getStoredConfig())
    if (!this.cfg || !this.cfg.extensionKey || !this.cfg.ownerUserId) {
      alert('Baixe novamente a extensão no painel Vyntra para vincular à sua conta.')
      return
    }
    const max = Math.min(
      this.adapterMax(),
      Math.max(10, parseInt(this.maxInput?.value || '200', 10) || 200),
    )
    this.prospecting = true
    this.stopFlag = { cancelled: false }
    if (this.prospectBtn) {
      this.prospectBtn.disabled = true
      this.prospectBtn.textContent = 'PROSPECTANDO…'
    }
    if (this.stopBtn) this.stopBtn.style.display = 'inline-block'
    let last = 0
    const renderThrottle = () => {
      const now = Date.now()
      if (now - last > 250 || this.contacts.length % 3 === 0) {
        last = now
        if (this.statusEl) this.statusEl.textContent = `${this.contacts.length} contato(s) encontrado(s)`
        this.renderList()
      }
    }
    try {
      if (this.mode === 'wepsy') {
        await prospectWepsy({
          max,
          signal: this.stopFlag,
          onResult: (wc) => {
            this.addAdapterContact(wc)
            renderThrottle()
          },
          onProgress: (msg) => {
            if (this.statusEl) this.statusEl.textContent = `${msg} · ${this.contacts.length} ok`
          },
        })
      } else if (this.mode === 'webmotors') {
        await prospectWebMotors({
          max,
          signal: this.stopFlag,
          onResult: (wc) => {
            this.addAdapterContact(wc)
            renderThrottle()
          },
          onProgress: (msg) => {
            if (this.statusEl) this.statusEl.textContent = `${msg} · ${this.contacts.length} ok`
          },
        })
      }
      if (!this.stopFlag.cancelled) {
        showToast(`✓ ${this.contacts.length} contato(s) encontrado(s).`)
      }
    } catch (err) {
      showToast(`Erro na prospecção: ${err}`, 'warn')
    } finally {
      this.prospecting = false
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