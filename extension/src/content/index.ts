import { getStoredConfig, type StoredConfig } from '../shared/config'
import { importLeads, deleteLeads, knownPlaceIds, type ScrapedLead, type ImportOptions } from '../shared/leads'
import { computeVyntraScore, bandClass, bandEmoji } from '../shared/score'
import {
  DEFAULT_FILTERS,
  matchFilters,
  describeFilters,
  buildTagsForLead,
  FILTER_CHIPS,
  type ProspectFilters,
  type SiteFilter,
  type DigitalFilter,
  type QualifyFilter,
  type ScoreBand,
  type ServiceInterest,
} from '../shared/filters'
import css from './style.css?raw'

interface ParsedCard {
  lead: ScrapedLead
  host: HTMLElement | null
  key: string
  control: HTMLElement | null
}

export class MapsScanner {
  private cfg: StoredConfig | null = null
  private found: ParsedCard[] = []
  private selected = new Set<string>()
  private used = new Set<string>()
  private noInterest = new Set<string>()
  private scanning = false
  /** Sessão limpa pelo botão "Limpar": evita que o scan repoupe `found` até uma nova busca. */
  private clearedSession = false

  private bubble: HTMLElement | null = null
  private balloon: HTMLElement | null = null
  private floatBtn: HTMLElement | null = null
  private headerEl: HTMLElement | null = null
  private listEl: HTMLElement | null = null
  private locEl: HTMLElement | null = null
  private countEl: HTMLElement | null = null

  private lastQuery = ''

  // === Prospecção automática (Vyntra Prospector) ===
  private filters: ProspectFilters = { ...DEFAULT_FILTERS }
  private filtersPanel: HTMLElement | null = null
  private resultPanel: HTMLElement | null = null
  private prospecting = false
  private prospectCancel = false
  /** Leads que passaram nos filtros na última prospecção (para relatório). */
  private lastMatched: ParsedCard[] = []

  async init(): Promise<void> {
    this.cfg = await getStoredConfig()
    injectStyles()
    this.observeDom()
    this.scan('force')

    window.addEventListener('click', (e) => {
      if (!this.balloon?.classList.contains('open')) return
      if (this.balloon.contains(e.target as Node)) return
      if (this.floatBtn?.contains(e.target as Node)) return
      // clique fora do painel (e do botão minimizado) → fecha
      this.toggleBalloon(false)
    })

    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'consecom:open' || msg?.type === 'consecom:ping') {
        this.toggleBalloon(true)
      }
    })

    // reajusta posição/size quando a viewport mudar
    window.addEventListener('resize', () => {
      if (this.balloon?.classList.contains('open')) this.clampElement(this.balloon)
      if (this.floatBtn && document.body.contains(this.floatBtn)) this.clampElement(this.floatBtn)
    })

    // Estado inicial: nada aberto → mostra o launcher flutuante (botão "V")
    // sobre o Maps, garantindo que o usuário sempre tenha como abrir a sidebar.
    this.ensureLauncher()
  }

  /** Garante que o launcher (botão "V") flutuante esteja visível quando a sidebar estiver fechada. */
  private ensureLauncher(): void {
    if (this.balloon && this.balloon.classList.contains('open')) return
    // Se a sidebar estiver aberta, nada a fazer. Se minimizada, o floatBtn já existe.
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
      this.clearedSession = false
      this.selected.clear()
      this.found = []
      if (this.locEl) this.locEl.textContent = query
      if (this.balloon?.classList.contains('open')) this.renderCardList()
    }
    if (query) this.lastQuery = query
  }

  // --- cartões nativos: só nome, site, telefone e botão de selecionar ---

  private renderControls(): void {
    // Intencionalmente vazio: a seleção de leads é feita integralmente pelo
    // painel VYNTRA (botão PROSPECTAR → seleção automática). Não injetamos
    // controles nativos em cada card do Google Maps.
    return
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

  private ensureBalloon(): void {
    if (this.balloon && document.body.contains(this.balloon)) {
      const pos = this.readPosition()
      this.balloon.style.right = `${pos.right}px`
      this.balloon.style.top = `${pos.top}px`
      requestAnimationFrame(() => this.balloon?.classList.add('open'))
      return
    }
    this.balloon = this.buildBalloon()
    const pos = this.readPosition()
    this.balloon.style.right = `${pos.right}px`
    this.balloon.style.top = `${pos.top}px`
    document.body.appendChild(this.balloon)
    this.positionBalloon()
    // animação de abertura suave (fade + slide)
    requestAnimationFrame(() => this.balloon?.classList.add('open'))
  }

  /** Minimiza o painel para um botão flutuante no mesmo canto. */
  private minimizeBalloon(): void {
    if (!this.balloon || !this.headerEl) return
    this.balloon.classList.remove('open')
    this.balloon.style.display = 'none'
    this.balloon.dataset.minimized = 'true'
    if (!this.floatBtn || !document.body.contains(this.floatBtn)) {
      this.floatBtn = this.buildFloatBtn()
      document.body.appendChild(this.floatBtn)
    }
    const pos = this.readPosition()
    this.floatBtn.style.right = `${pos.right}px`
    this.floatBtn.style.top = `${pos.top}px`
    requestAnimationFrame(() => this.floatBtn?.classList.add('open'))
  }

  private buildFloatBtn(): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'consecom-floatbtn'
    btn.title = 'Abrir Vyntra'
    btn.textContent = 'V'
    btn.addEventListener('click', () => {
      // Se o usuário arrastou o botão, não restaura o painel por engano.
      if (btn.dataset.dragged === 'true') {
        btn.dataset.dragged = 'false'
        return
      }
      this.restoreBalloon()
    })
    this.enableDrag(btn, btn)
    return btn
  }

  /** Restaura o painel a partir do botão minimizado. */
  private restoreBalloon(): void {
    if (!this.balloon) {
      this.balloon = this.buildBalloon()
      document.body.appendChild(this.balloon)
    }
    this.balloon.style.display = 'flex'
    this.balloon.dataset.minimized = 'false'
    const pos = this.floatBtn
      ? { right: parseFloat(this.floatBtn.style.right) || 20, top: parseFloat(this.floatBtn.style.top) || 20 }
      : this.readPosition()
    this.balloon.style.right = `${pos.right}px`
    this.balloon.style.top = `${pos.top}px`
    this.clampElement(this.balloon)
    requestAnimationFrame(() => this.balloon?.classList.add('open'))
    if (this.floatBtn) {
      this.floatBtn.classList.remove('open')
      this.floatBtn.remove()
      this.floatBtn = null
    }
    this.renderBalloonList()
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

  /**
   * Drag robusto baseado em Pointer Events.
   * `handle` é a área que recebe o ponteiro (ex: header/grip); `target` é o
   * elemento fixo que se move (ex: balloon/float button). Nunca deixa o
   * target sair da viewport e ignora cliques/arrastos sobre elementos
   * interativos (botões, inputs, selects, links, controles do header).
   */
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
      // Ignora arrasto iniciado em elementos interativos (descendentes),
      // exceto quando o próprio handle é um <button> (ex: float button).
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

  private buildBalloon(): HTMLElement {
    const balloon = document.createElement('aside')
    balloon.className = 'consecom-balloon'

    // Header (área de drag: grip + título + controles)
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
    tag.textContent = 'Prospecção Automática'
    const tagline = document.createElement('div')
    tagline.className = 'cs-panel__tagline'
    tagline.textContent = 'Encontre empresas qualificadas no Google Maps e importe os melhores leads.'
    titles.append(name, tag, tagline)

    // Controles do header: minimizar + fechar
    const controls = document.createElement('div')
    controls.className = 'cs-panel__controls'
    const minimizeBtn = document.createElement('button')
    minimizeBtn.type = 'button'
    minimizeBtn.className = 'cs-panel__btn'
    minimizeBtn.title = 'Minimizar'
    minimizeBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor" d="M19 13h-4v4h-2v-4H5v-2h4V7h2v4h4z"/></svg>'
    minimizeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.minimizeBalloon()
    })
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
    controls.append(minimizeBtn, closeBtn)
    header.append(grip, logo, titles, controls)
    this.enableDrag(header, balloon)

    // Corpo com scroll interno
    const body = document.createElement('div')
    body.className = 'cs-panel__body'

    // Busca + localização
    const search = document.createElement('div')
    search.className = 'cs-panel__search'
    const input = document.createElement('input')
    input.className = 'cs-panel__input'
    input.type = 'text'
    input.placeholder = 'Buscar empresas'
    input.spellcheck = false
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const q = input.value.trim()
        if (!q) return
        const mapsInput = document.querySelector<HTMLInputElement>(
          'input#searchboxinput, input[aria-label*="pesquisa"], input[aria-label*="search"]',
        )
        if (mapsInput) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          setter?.call(mapsInput, q)
          mapsInput.dispatchEvent(new Event('input', { bubbles: true }))
          mapsInput.dispatchEvent(new Event('change', { bubbles: true }))
          mapsInput.focus()
          mapsInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        } else {
          this.lastQuery = q
          this.selected.clear()
          this.found = []
          this.scan('force')
        }
      }
    })
    const loc = document.createElement('div')
    loc.className = 'cs-panel__loc'
    loc.innerHTML = pinIcon
    this.locEl = document.createElement('span')
    this.locEl.textContent = 'Aguardando busca…'
    loc.append(this.locEl)
    search.append(input, loc)

    // Botão PROSPECTAR
    const prospectBtn = document.createElement('button')
    prospectBtn.type = 'button'
    prospectBtn.className = 'cs-prospect'
    prospectBtn.textContent = 'PROSPECTAR'
    prospectBtn.addEventListener('click', () => void this.runProspect(prospectBtn))

    // Painel de filtros (Prospecção Automática)
    const filtersPanel = this.buildFiltersPanel()
    this.filtersPanel = filtersPanel

    // Painel de resultado (preenchido após prospecção)
    const resultPanel = document.createElement('div')
    resultPanel.className = 'cs-result'
    resultPanel.style.display = 'none'
    this.resultPanel = resultPanel

    // Lista de cards
    const list = document.createElement('div')
    list.className = 'cs-panel__list'
    this.listEl = list

     // Rodapé: ações de manutenção (o prospecting é via PROSPECTAR +
     // IMPORTAR no painel de resultado — não há botões de prospecção concorrentes)
     const footer = document.createElement('div')
     footer.className = 'cs-panel__footer'
     // Contador da sessão de captura (atualizado em renderBalloonList)
     const countEl = document.createElement('div')
     countEl.className = 'cs-footer__count'
     this.countEl = countEl
     const row2 = document.createElement('div')
     row2.className = 'cs-footer__row'
     const clearBtn = document.createElement('button')
     clearBtn.type = 'button'
     clearBtn.className = 'cs-footer__btn cs-foot-clear'
     clearBtn.innerHTML = 'Limpar' + trashIcon
     clearBtn.addEventListener('click', () => void this.confirmClear())
     const deleteBtn = document.createElement('button')
     deleteBtn.type = 'button'
     deleteBtn.className = 'cs-footer__btn cs-foot-delete'
     deleteBtn.innerHTML = 'Excluir' + trashIcon
     deleteBtn.addEventListener('click', () => void this.doDelete(deleteBtn))
     const configBtn = document.createElement('button')
     configBtn.type = 'button'
     configBtn.className = 'cs-footer__btn cs-foot-config'
     configBtn.title = 'Configurar Supabase'
     configBtn.innerHTML = 'Configurar' + gearIcon
     configBtn.addEventListener('click', () => void this.promptConfig())
      row2.append(clearBtn, deleteBtn, configBtn)
      footer.append(countEl, row2)

    body.append(search, prospectBtn, filtersPanel, resultPanel, list)

    balloon.append(header, body, footer)
    this.balloon = balloon
    return balloon
  }

  /**
   * PROSPECÇÃO AUTOMÁTICA (Vyntra Prospector).
   * Pipeline:
   *   1. loading progressivo (analisando/encontrando/calculando)
   *   2. varre os cards do Maps disponíveis (paginação segura)
   *   3. lê filtros da UI
   *   4. aplica matchFilters (OR dentro / AND entre categorias)
   *   5. seleciona automaticamente os que passaram
   *   6. mostra resultado (X oportunidades) + separa novos vs existentes
   *   7.botão IMPORTAR usa o fluxo existente (importLeads)
   */
  private async runProspect(btn: HTMLButtonElement): Promise<void> {
    if (this.prospecting) return
    this.prospecting = true
    this.prospectCancel = false
    this.clearedSession = false
    btn.disabled = true

    try {
      // Etapa 1: coleta incremental (scroll → lazy load) com feedback progressivo
      await this.runProspectStages(btn)

      // Etapa 2: varredura final dos cards disponíveis
      this.scan('force')

      // Etapa 3: ler filtros da UI (sempre refletidos no state)
      this.readFiltersFromPanel()

      // Etapa 4: aplicar filtros + seleção automática
      const { matched, novoCount, existenteCount } = this.applyAutomaticSelection()

      // Etapa 5: renderizar resultado
      this.renderResult(matched, novoCount, existenteCount)
      this.renderBalloonList()
    } catch (err) {
      showToast(`Erro na prospecção: ${err}`, 'warn')
    } finally {
      btn.textContent = 'PROSPECTAR'
      btn.disabled = false
      this.prospecting = false
    }
  }

  /**
   * Coleta resultados do Google Maps com feedback progressivo.
   * Enquanto a página carrega lazy results (scroll), faz scroll no container
   * de resultados para acelerar o carregamento incremental e atualiza o
   * indicador "N / total". Interrompe ao não haver novos cards por um ciclo.
   */
  private async runProspectStages(btn: HTMLButtonElement): Promise<void> {
    const stages: Array<[string, number]> = [
      ['Coletando resultados', 320],
      ['Aprofundando a busca', 340],
      ['Carregando mais empresas', 360],
      ['Calculando oportunidades', 380],
    ]
    for (const [sub, ms] of stages) {
      if (this.prospectCancel) break
      // Botão principal mostra "PROSPECTANDO..." + contagem (§6 UX)
      const n = this.found.length
      btn.textContent = n > 0 ? `PROSPECTANDO… ${n} resultados` : `PROSPECTANDO…`
      this.updateProspectProgress()
      await this.scrollAndCollect()
      await sleep(ms)
      this.updateProspectProgress()
    }
  }

  /** Faz scroll no container de resultados do Maps para disparar lazy-load. */
  private async scrollAndCollect(): Promise<void> {
    const anchors = Array.from(document.querySelectorAll<HTMLElement>(nativeCardSelector()))
    if (anchors.length === 0) return
    const host = closestCard(anchors[0])
    const scrollEl = host ? findScrollParent(host) : null
    if (!scrollEl) return
    const before = this.found.length
    const delta = Math.min(600, (scrollEl as HTMLElement).offsetHeight || 400)
    scrollEl.scrollBy({ top: delta, behavior: 'smooth' })
    await sleep(340)
    this.scan('force')
    // repete uma vez se não coletou nada (lazy load atrasado)
    if (this.found.length === before) {
      scrollEl.scrollBy({ top: delta, behavior: 'smooth' })
      await sleep(340)
      this.scan('force')
    }
  }

  /** Mostra progresso incremental "N / total" durante a análise. */
  private updateProspectProgress(): void {
    if (!this.resultPanel) return
    const total = this.found.length
    const prog = document.createElement('div')
    prog.className = 'cs-result__progress'
    prog.textContent = `Coletados: ${total}`
    this.resultPanel.replaceChildren(prog)
    this.resultPanel.style.display = 'block'
  }

  /**
   * Filtra `found` pelos filtros atuais e marca seleção automática.
   * Respeita `used` (já importados) e `noInterest` (sem interesse) — esses
   * nunca entram na seleção automática, mas são contados como "já existentes".
   */
  private applyAutomaticSelection(): {
    matched: ParsedCard[]
    novoCount: number
    existenteCount: number
  } {
    const eligible = this.found.filter(
      (f) => !this.used.has(f.key) && !this.noInterest.has(f.key),
    )
    const matched = eligible.filter((pc) => matchFilters(pc.lead, this.filters))
    this.lastMatched = matched

    // Seleção automática dos que passaram
    this.selected.clear()
    for (const pc of matched) this.selected.add(pc.key)

    // Duplicidade: leads já importados (used) entre os que passariam nos filtros
    const existentes = this.found.filter(
      (f) => this.used.has(f.key) && matchFilters(f.lead, this.filters),
    )

    return {
      matched,
      novoCount: matched.length,
      existenteCount: existentes.length,
    }
  }

  /** Constrói o painel de filtros (chips, referência VYNTRA). */
  private buildFiltersPanel(): HTMLElement {
    const panel = document.createElement('div')
    panel.className = 'cs-filters'

    const title = document.createElement('div')
    title.className = 'cs-filters__title'
    title.textContent = 'Encontrar oportunidades'
    panel.appendChild(title)

    // Chips (OR intra-categoria / AND inter-categoria)
    const chipsWrap = document.createElement('div')
    chipsWrap.className = 'cs-chips'
    for (const chip of FILTER_CHIPS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'cs-chip'
      btn.dataset.id = chip.id
      btn.dataset.cat = chip.cat
      btn.dataset.value = chip.value
      btn.dataset.accent = chip.accent ?? '#8b5cf6'
      btn.textContent = chip.label
      btn.addEventListener('click', () => {
        if (this.filters.activeChips.has(chip.id)) this.filters.activeChips.delete(chip.id)
        else this.filters.activeChips.add(chip.id)
        btn.classList.toggle('cs-chip--on')
        this.syncChipsFromState(btn, chip.accent)
      })
      // estado inicial
      this.syncChipsFromState(btn, chip.accent)
      chipsWrap.appendChild(btn)
    }
    panel.appendChild(chipsWrap)

    // Advanced: nota/avaliações mínimas (compacto)
    const adv = document.createElement('div')
    adv.className = 'cs-adv'
    const ratingWrap = document.createElement('label')
    ratingWrap.className = 'cs-adv__item'
    const rLab = document.createElement('span')
    rLab.textContent = 'Nota mín.'
    const rSel = document.createElement('select')
    rSel.dataset.cat = 'minRating'
    for (const v of [0, 4.0, 4.5, 4.8]) {
      const o = document.createElement('option')
      o.value = String(v)
      o.textContent = v === 0 ? 'Qualquer' : `${v.toFixed(1)}+`
      rSel.appendChild(o)
    }
    ratingWrap.append(rLab, rSel)
    const revWrap = document.createElement('label')
    revWrap.className = 'cs-adv__item'
    const vLab = document.createElement('span')
    vLab.textContent = 'Avaliações mín.'
    const vSel = document.createElement('select')
    vSel.dataset.cat = 'minReviews'
    for (const v of [0, 10, 50, 100, 500]) {
      const o = document.createElement('option')
      o.value = String(v)
      o.textContent = v === 0 ? 'Qualquer' : `${v}+`
      vSel.appendChild(o)
    }
    revWrap.append(vLab, vSel)
    adv.append(ratingWrap, revWrap)
    panel.appendChild(adv)

    // Serviço (radio compacto)
    panel.appendChild(this.buildServiceGroup())

    return panel
  }

  private syncChipsFromState(btn: HTMLButtonElement, accent?: string): void {
    const on = btn.classList.contains('cs-chip--on')
    if (on) {
      btn.style.borderColor = accent ?? '#8b5cf6'
      btn.style.background = `${accent ?? '#8b5cf6'}22`
      btn.style.color = '#fff'
    } else {
      btn.style.borderColor = ''
      btn.style.background = ''
      btn.style.color = ''
    }
  }

  private buildServiceGroup(): HTMLElement {
    const group = document.createElement('div')
    group.className = 'cs-fgroup cs-fgroup--svc'
    const h = document.createElement('div')
    h.className = 'cs-fgroup__h'
    h.textContent = 'SERVIÇO / NECESSIDADE'
    group.appendChild(h)
    const wrap = document.createElement('div')
    wrap.className = 'cs-radio'
    const services: Array<{ id: ServiceInterest; label: string }> = [
      { id: 'todos', label: 'Todos' },
      { id: 'site', label: 'Site' },
      { id: 'sistema', label: 'Sistema' },
      { id: 'trafego', label: 'Tráfego pago' },
      { id: 'automacao', label: 'Automação' },
      { id: 'presenca', label: 'Presença digital' },
    ]
    for (const s of services) {
      const row = document.createElement('label')
      row.className = 'cs-radio__item'
      const r = document.createElement('input')
      r.type = 'radio'
      r.name = 'cs-service'
      r.value = s.id
      r.dataset.cat = 'service'
      if (s.id === 'todos') r.checked = true
      const span = document.createElement('span')
      span.textContent = s.label
      row.append(r, span)
      wrap.appendChild(row)
    }
    group.appendChild(wrap)
    return group
  }

  /** Reconstrói this.filters a partir dos chips ativos + selects. */
  private readFiltersFromPanel(): void {
    if (!this.filtersPanel) return
    const site: SiteFilter[] = []
    const digital: DigitalFilter[] = []
    const qualify: QualifyFilter[] = []
    const scoreBands: ScoreBand[] = []

    this.filtersPanel.querySelectorAll<HTMLButtonElement>('.cs-chip.cs-chip--on').forEach((chip) => {
      const cat = chip.dataset.cat
      const value = chip.dataset.value
      if (!cat || !value) return
      if (cat === 'site') site.push(value as SiteFilter)
      else if (cat === 'digital') digital.push(value as DigitalFilter)
      else if (cat === 'score') scoreBands.push(value as ScoreBand)
      else if (cat === 'qualify') qualify.push(value as QualifyFilter)
    })

    let minRating: number | null = null
    let minReviews: number | null = null
    const rSel = this.filtersPanel.querySelector<HTMLSelectElement>('select[data-cat=minRating]')
    if (rSel) minRating = parseFloat(rSel.value) || null
    const revSel = this.filtersPanel.querySelector<HTMLSelectElement>('select[data-cat=minReviews]')
    if (revSel) minReviews = parseInt(revSel.value, 10) || null

    let service: ServiceInterest = 'todos'
    const svcRadio = this.filtersPanel.querySelector<HTMLInputElement>('input[name=cs-service]:checked')
    if (svcRadio) service = svcRadio.value as ServiceInterest

    this.filters = {
      site,
      digital,
      qualify,
      minRating,
      minReviews,
      scoreBands,
      service,
      activeChips: this.filters.activeChips,
    }
  }

  /** Renderiza o resultado da prospecção automática. */
  private renderResult(
    matched: ParsedCard[],
    novoCount: number,
    existenteCount: number,
  ): void {
    if (!this.resultPanel) return
    const total = this.found.length
    const panel = document.createElement('div')
    panel.className = 'cs-result__card'

    // Header
    const head = document.createElement('div')
    head.className = 'cs-result__head'
    const big = document.createElement('div')
    big.className = 'cs-result__big'
    big.textContent = `${novoCount}`
    const sub = document.createElement('div')
    sub.className = 'cs-result__sub'
    sub.textContent =
      novoCount === 1 ? 'oportunidade encontrada' : 'oportunidades encontradas'
    head.append(big, sub)
    panel.appendChild(head)

    // Stats
    const stats = document.createElement('div')
    stats.className = 'cs-result__stats'
    const analyzed = document.createElement('div')
    analyzed.innerHTML = `<span>${total}</span> analisadas`
    const sel = document.createElement('div')
    sel.innerHTML = `<span>${novoCount}</span> selecionadas automaticamente`
    stats.append(analyzed, sel)
    if (existenteCount > 0) {
      const dup = document.createElement('div')
      dup.className = 'cs-result__dup'
      dup.innerHTML = `⚠ ${existenteCount} já existem na Vyntra`
      stats.appendChild(dup)
    }
    panel.appendChild(stats)

    // Recomendação do Alex (resumo textual; não impede a importação)
    if (matched.length > 0) {
      const alex = this.buildAlexHint(matched)
      panel.appendChild(alex)
    }

    // CTA IMPORTAR
    if (novoCount > 0) {
      const importCta = document.createElement('button')
      importCta.type = 'button'
      importCta.className = 'cs-result__cta'
      const target = existenteCount > 0 ? `${novoCount} NOVOS` : `${novoCount} LEADS`
      importCta.textContent = existenteCount > 0 ? `IMPORTAR ${novoCount} NOVOS` : `IMPORTAR ${novoCount} LEADS`
      importCta.addEventListener('click', () => void this.doProspectImport(importCta, matched, target))
      panel.appendChild(importCta)
    } else {
      const empty = document.createElement('div')
      empty.className = 'cs-result__empty'
      empty.textContent = 'Nenhuma empresa corresponde aos critérios. Ajuste os filtros e tente novamente.'
      panel.appendChild(empty)
    }

    this.resultPanel.replaceChildren(panel)
    this.resultPanel.style.display = 'block'
  }

  /** Recomendação do Alex (resumo determinístico, sem IA por ora). */
  private buildAlexHint(matched: ParsedCard[]): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cs-alex'
    const avatar = document.createElement('div')
    avatar.className = 'cs-alex__avatar'
    avatar.textContent = '🤖'
    const body = document.createElement('div')
    body.className = 'cs-alex__body'
    const name = document.createElement('div')
    name.className = 'cs-alex__name'
    name.textContent = 'Alex'
    const msg = document.createElement('div')
    msg.className = 'cs-alex__msg'
    const alta = matched.filter((m) => computeVyntraScore(m.lead).band === 'alta').length
    const semSite = matched.filter((m) => !m.lead.website).length
    const maior = semSite >= matched.length / 2 ? 'sem site ou com presença digital fraca' : 'com boa avaliação e presença consolidada'
    msg.textContent =
      `Encontrei ${matched.length} empresas que parecem boas oportunidades para prospecção.` +
      (alta > 0 ? ` ${alta} delas possuem alta oportunidade.` : '') +
      ` A maior oportunidade está em empresas ${maior}.`
    body.append(name, msg)
    wrap.append(avatar, body)
    return wrap
  }

  /**
   * Importa os leads selecionados automaticamente, REUSANDO o fluxo atual
   * (importLeads). Aplica tags automáticas, source/source_detail, score e
   * snapshot dos filtros usados. Mostra progresso e relatório final.
   */
  private async doProspectImport(
    btn: HTMLButtonElement,
    matched: ParsedCard[],
    _target: string,
  ): Promise<void> {
    this.cfg = this.cfg ?? (await getStoredConfig())
    if (!this.cfg || !this.cfg.extensionKey || !this.cfg.ownerUserId) {
      alert('Baixe novamente a extensão no painel Vyntra para vincular à sua conta.')
      return
    }

    // leads a importar = matched (já sem used/noInterest), respeita limite 50
    const leads = matched.map((pc) => pc.lead).slice(0, 50)
    if (leads.length === 0) {
      alert('Nenhuma empresa nova selecionada para importar.')
      return
    }

    const prev = btn.textContent
    btn.disabled = true
    try {
      // Tags + score por lead: importLeads grava os mesmos campos para todos;
      // tags individuais seriam ideais, mas o upsert atual é por-place_id.
      // Para respeitar a arquitetura sem criar fluxo paralelo, enviamos tags
      // agregadas + score médio no snapshot (filtros), e mantemos has_website
      // por linha (já gravado em importLeads).
      const baseTags = ['Google Maps']
      const serviceTag = this.filters.service !== 'todos' ? `Interesse: ${this.serviceLabel(this.filters.service)}` : null
      const allTags = serviceTag ? [...baseTags, serviceTag] : baseTags
      const opts: ImportOptions = {
        source: 'google_maps',
        sourceDetail: 'vyntra_prospector',
        tags: allTags,
        prospectFilters: this.filtersToSnapshot(),
        prospectedAt: new Date().toISOString(),
      }

      let done = 0
      const res = await importLeads(this.cfg, leads, (d, total) => {
        done = d
        const pct = Math.round((d / total) * 100)
        btn.textContent = `Importando… ${pct}%`
      }, opts)

      console.log('[IMPORT] Resultado completo:', {
        ok: res.ok,
        failed: res.failed,
        firstError: res.firstError,
        errors: res.errors,
      })

      // Relatório final
      this.renderProspectReport({
        analyzed: this.found.length,
        opportunities: matched.length,
        imported: res.ok,
        failed: res.failed,
        alreadyExists: this.countAlreadyExists(matched),
        filtersText: describeFilters(this.filters),
      })

      btn.textContent = res.failed === 0 ? `✓ ${res.ok} LEADS IMPORTADOS` : `${res.ok} ok, ${res.failed} falharam`
      if (res.failed === 0) {
        showToast(`✅ ${res.ok} lead(s) importado(s)!`)
        this.selected.clear()
      } else {
        showToast(`⚠️ ${res.ok} ok, ${res.failed} falharam${res.firstError ? `: ${res.firstError}` : ''}`, 'warn')
      }
      void this.checkUsed()
      this.syncAll()
      void done
    } catch (err) {
      btn.textContent = `Erro: ${err}`
      showToast(`Erro ao importar: ${err}`, 'warn')
    } finally {
      setTimeout(() => {
        btn.textContent = prev
        btn.disabled = false
      }, 4000)
    }
  }

  private countAlreadyExists(matched: ParsedCard[]): number {
    return matched.filter((pc) => this.used.has(pc.key)).length
  }

  private serviceLabel(s: ServiceInterest): string {
    const map: Record<ServiceInterest, string> = {
      todos: 'Todos',
      site: 'Site',
      sistema: 'Sistema',
      trafego: 'Tráfego pago',
      automacao: 'Automação',
      presenca: 'Presença digital',
    }
    return map[s]
  }

  private filtersToSnapshot(): Record<string, unknown> {
    return {
      site: this.filters.site,
      digital: this.filters.digital,
      minRating: this.filters.minRating,
      minReviews: this.filters.minReviews,
      scoreBands: this.filters.scoreBands,
      service: this.filters.service,
      query: this.lastQuery,
      at: new Date().toISOString(),
    }
  }

  /** Renderiza o relatório final de prospecção (PROSPECÇÃO CONCLUÍDA). */
  private renderProspectReport(r: {
    analyzed: number
    opportunities: number
    imported: number
    failed: number
    alreadyExists: number
    filtersText: string[]
  }): void {
    if (!this.resultPanel) return
    const panel = document.createElement('div')
    panel.className = 'cs-result__card cs-result__report'

    const head = document.createElement('div')
    head.className = 'cs-result__head cs-result__head--ok'
    const title = document.createElement('div')
    title.className = 'cs-result__title'
    title.textContent = 'PROSPECÇÃO CONCLUÍDA'
    head.appendChild(title)
    panel.appendChild(head)

    const lines = [
      `${r.analyzed} empresas analisadas`,
      `${r.opportunities} oportunidades encontradas`,
      `${r.imported} novos leads importados`,
      r.failed > 0 ? `${r.failed} com erro` : null,
      r.alreadyExists > 0 ? `${r.alreadyExists} já estavam na Vyntra` : null,
    ].filter(Boolean) as string[]
    const ul = document.createElement('ul')
    ul.className = 'cs-result__lines'
    for (const l of lines) {
      const li = document.createElement('li')
      li.textContent = l
      ul.appendChild(li)
    }
    panel.appendChild(ul)

    if (r.filtersText.length > 0) {
      const crit = document.createElement('div')
      crit.className = 'cs-result__crit'
      crit.innerHTML = '<div class="cs-result__crit-h">Critérios:</div>'
      const tags = document.createElement('div')
      tags.className = 'cs-result__tags'
      for (const t of r.filtersText) {
        const tag = document.createElement('span')
        tag.className = 'cs-result__chip'
        tag.textContent = `✓ ${t}`
        tags.appendChild(tag)
      }
      crit.appendChild(tags)
      panel.appendChild(crit)
    }

    const verBtn = document.createElement('button')
    verBtn.type = 'button'
    verBtn.className = 'cs-result__cta cs-result__cta--ghost'
    verBtn.textContent = 'VER LEADS'
    verBtn.addEventListener('click', () => this.renderBalloonList())
    panel.appendChild(verBtn)

    this.resultPanel.replaceChildren(panel)
    this.resultPanel.style.display = 'block'
  }

  /** "PROSPECTAR": força a varredura dos cards do Maps e seleciona os disponíveis. */
  private doProspect(btn: HTMLButtonElement): void {
    void this.runProspect(btn)
  }

  private renderBalloonList(): void {
    if (!this.balloon || !this.listEl) return
    this.updateCounts()
    this.renderCardList()
  }

  private renderCardList(): void {
    if (!this.listEl) return
    if (this.found.length === 0) {
      this.listEl.innerHTML = ''
      const empty = document.createElement('div')
      empty.className = 'cs-empty'
      if (this.clearedSession) {
        empty.innerHTML =
          '<span class="cs-empty__icon">✓</span><b>0 leads capturados</b> · <b>0 leads selecionados</b><br/>Sessão limpa. Inicie uma nova busca e toque em PROSPECTAR para capturar novamente.'
      } else {
        empty.innerHTML =
          '<b>0 leads capturados</b> · <b>0 leads selecionados</b><br/>Rode a busca no Google Maps e toque em PROSPECTAR para listar as empresas.'
      }
      this.listEl.appendChild(empty)
      return
    }
    const frag = document.createDocumentFragment()
    for (const pc of this.found) {
      frag.appendChild(this.buildCard(pc))
    }
    this.listEl.replaceChildren(frag)
  }

  private buildCard(pc: ParsedCard): HTMLElement {
    const card = document.createElement('div')
    card.className = 'cs-pcard'
    card.dataset.key = pc.key

    const score = computeVyntraScore(pc.lead)

    // Linha 1: nome + badge
    const top = document.createElement('div')
    top.className = 'cs-pcard__top'
    const nm = document.createElement('div')
    nm.className = 'cs-pcard__name'
    nm.textContent = pc.lead.name
    nm.title = pc.lead.name
    const badge = document.createElement('div')
    badge.className = 'cs-pcard__badge ' + bandClass(score.band)
    badge.textContent = score.label
    top.append(nm, badge)

    // Linha 2: meta (endereço • telefone • nota)
    const meta = document.createElement('div')
    meta.className = 'cs-pcard__meta'
    const metaParts: HTMLElement[] = []
    if (pc.lead.address) {
      const s = document.createElement('span')
      s.textContent = pc.lead.address.split(',')[0]
      metaParts.push(s)
    }
    if (pc.lead.phone) {
      const s = document.createElement('span')
      s.textContent = pc.lead.phone
      metaParts.push(s)
    }
    if (pc.lead.rating != null) {
      const rt = document.createElement('span')
      rt.className = 'cs-pcard__rating'
      rt.innerHTML = starIcon + pc.lead.rating.toFixed(1)
      metaParts.push(rt)
    }
    for (let i = 0; i < metaParts.length; i++) {
      if (i > 0) meta.appendChild(document.createTextNode(' • '))
      meta.appendChild(metaParts[i])
    }
    if (metaParts.length === 0) {
      meta.textContent = '—'
    }

    // Linha 3: barra de score
    const bar = document.createElement('div')
    bar.className = 'cs-pcard__scorebar'
    const barTrack = document.createElement('div')
    barTrack.className = 'cs-pcard__bar'
    const barFill = document.createElement('div')
    barFill.className = 'cs-pcard__barfill'
    barFill.style.width = `${score.total}%`
    barTrack.appendChild(barFill)
    const scoreTxt = document.createElement('div')
    scoreTxt.className = 'cs-pcard__score'
    scoreTxt.innerHTML = `${score.total}<small>/100</small>`
    bar.append(barTrack, scoreTxt)

    // Linha 4: ações
    const actions = document.createElement('div')
    actions.className = 'cs-pcard__actions'
    const leadBtn = document.createElement('button')
    leadBtn.type = 'button'
    leadBtn.className = 'cs-pcard__btn cs-pcard__lead'
    leadBtn.innerHTML = (this.selected.has(pc.key) ? checkIcon : plusIcon) + '<span data-role="lead-label">Lead</span>'
    leadBtn.addEventListener('click', () => {
      if (this.used.has(pc.key) || this.noInterest.has(pc.key)) return
      this.toggleControl(pc.key)
    })
    const siteBtn = document.createElement('button')
    siteBtn.type = 'button'
    siteBtn.className = 'cs-pcard__btn cs-pcard__site'
    siteBtn.title = 'Abrir site'
    siteBtn.innerHTML = websiteIcon
    if (pc.lead.website) {
      siteBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        window.open(pc.lead.website!, '_blank', 'noopener,noreferrer')
      })
    } else {
      siteBtn.disabled = true
    }
    actions.append(leadBtn, siteBtn)

    card.append(top, meta, bar, actions)
    this.updateCard(card, pc)
    return card
  }

  private updateCard(card: HTMLElement, pc: ParsedCard): void {
    const leadBtn = card.querySelector('.cs-pcard__lead') as HTMLButtonElement | null
    if (!leadBtn) return
    const label = leadBtn.querySelector('[data-role="lead-label"]') as HTMLElement | null
    if (this.noInterest.has(pc.key)) {
      leadBtn.classList.add('nointerest')
      leadBtn.disabled = true
      if (label) label.textContent = 'Sem interesse'
      return
    }
    if (this.used.has(pc.key)) {
      leadBtn.classList.add('used')
      leadBtn.disabled = true
      if (label) label.textContent = 'Importado'
      return
    }
    leadBtn.classList.toggle('on', this.selected.has(pc.key))
    leadBtn.innerHTML = (this.selected.has(pc.key) ? checkIcon : plusIcon) + '<span data-role="lead-label">Lead</span>'
  }

  private syncAll(): void {
    this.updateCounts()
    this.renderControls()
    this.renderBalloonList()
  }

  private updateCounts(): void {
    if (!this.listEl) return
    const cards = this.listEl.querySelectorAll<HTMLElement>('.cs-pcard')
    cards.forEach((c) => {
      const key = c.dataset.key
      const pc = key ? this.found.find((f) => f.key === key) : undefined
      if (pc) this.updateCard(c, pc)
    })
    if (this.countEl) {
      const captured = this.found.length
      const selected = this.selected.size
      this.countEl.innerHTML = `<b>${captured}</b> capturados · <b>${selected}</b> selecionados`
    }
  }

  private toggleBalloon(open?: boolean): void {
    // Se minimizado (botão flutuante ativo) e pedido para ABRIR → restaura
    if (open && this.floatBtn) {
      this.restoreBalloon()
      return
    }
    const shouldOpen = open ?? !this.balloon?.classList.contains('open')
    if (!this.balloon || !document.body.contains(this.balloon)) {
      if (shouldOpen) this.ensureBalloon()
      return
    }
    this.balloon.classList.toggle('open', shouldOpen)
    if (shouldOpen) this.renderBalloonList()
    else this.ensureLauncher()
  }

  /**
   * Mantém um elemento fixo totalmente dentro da viewport com margem mínima.
   * Se estiver em posição inválida (ex: após resize), reposiciona para a
   * posição válida mais próxima (clamp em todas as bordas).
   */
  private clampElement(el: HTMLElement): void {
    if (!document.body.contains(el)) return
    const MARGIN = 12
    const w = el.offsetWidth || 0
    const h = el.offsetHeight || 0
    const maxRight = Math.max(0, window.innerWidth - MARGIN - w)
    const maxTop = Math.max(0, window.innerHeight - MARGIN - h)

    const right = parseFloat(el.style.right)
    const top = parseFloat(el.style.top)
    if (!Number.isFinite(right) || !Number.isFinite(top)) return

    const nr = Math.min(Math.max(0, right), maxRight)
    const nt = Math.min(Math.max(0, top), maxTop)
    if (nr !== right || nt !== top) {
      el.style.right = `${nr}px`
      el.style.top = `${nt}px`
      el.style.left = ''
      el.style.bottom = ''
      this.savePosition(el)
    }
  }

  /** Reposiciona o painel dentro da viewport caso a posição salva esteja inválida. */
  private positionBalloon(): void {
    if (!this.balloon) return
    const saved = this.readPosition()
    this.balloon.style.right = `${Math.max(12, saved.right)}px`
    this.balloon.style.top = `${Math.max(12, saved.top)}px`
    this.clampElement(this.balloon)
  }

  // --- varredura dos cards nativos ---

  private refreshCards(): void {
    // Após "Limpar", não repopular a lista até o usuário iniciar nova busca
    // ou rodar PROSPECTAR novamente (limpeza é local, não toca no banco).
    if (this.clearedSession) return
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
    if (!cfg.extensionKey || !cfg.ownerUserId) return
    const ids = this.found.map((f) => f.lead.place_id).filter((x): x is string => !!x)
    if (ids.length === 0) return
    try {
      const res = await knownPlaceIds(cfg, ids)
      this.used = new Set(res.used)
      const now = Date.now()
      this.noInterest = new Set(
        Object.entries(res.noInterest)
          .filter(([, until]) => until && new Date(until).getTime() > now)
          .map(([placeId]) => placeId),
      )
      this.syncAll()
    } catch {
      /* rede/erro: segue sem rótulos de usado */
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
      instagram: extractInstagram(card),
      facebook: extractFacebook(card),
    }
  }

  // --- configuração e importação ---

  private async promptConfig(): Promise<void> {
    const cfg = this.cfg ?? (await getStoredConfig())
    alert(
      cfg.extensionKey && cfg.ownerUserId
        ? 'Extensão vinculada à sua conta Vyntra ✓'
        : 'Esta extensão não está vinculada a uma conta. Baixe novamente a extensão no painel Vyntra.',
    )
  }

  private async doImport(btn: HTMLButtonElement): Promise<void> {
    this.cfg = this.cfg ?? (await getStoredConfig())
    if (!this.cfg || !this.cfg.extensionKey || !this.cfg.ownerUserId) {
      alert('Baixe novamente a extensão no painel Vyntra para vincular à sua conta.')
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
      console.log('[IMPORT] Resultado completo:', {
        ok: res.ok,
        failed: res.failed,
        firstError: res.firstError,
        errors: res.errors,
      })
      btn.textContent = res.failed === 0 ? '✓' : `${res.ok} ok, ${res.failed} falharam`

      if (res.failed === 0) {
        showToast(res.ok > 0 ? `✅ ${res.ok} lead(s) importado(s)!` : 'Nenhum lead novo para importar.')
        this.selected.clear()
      } else {
        showToast(`⚠️ ${res.ok} ok, ${res.failed} falharam${res.firstError ? `: ${res.firstError}` : ''}`, 'warn')
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
    if (!this.cfg || !this.cfg.extensionKey || !this.cfg.ownerUserId) {
      alert('Baixe novamente a extensão no painel Vyntra para vincular à sua conta.')
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

  /**
   * LIMPAR (local): remove da lista/painel todos os leads capturados na
   * sessão atual de prospecção. NÃO apaga nada do banco (os leads já
   * importados para o VYNTRA permanecem intactos). Fluxo: modal de
   * confirmação → "Limpar leads" → lista vazia + toast "✓ Leads removidos".
   */
  private confirmClear(): Promise<void> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div')
      overlay.className = 'cs-modal'
      const card = document.createElement('div')
      card.className = 'cs-modal__card'
      const title = document.createElement('div')
      title.className = 'cs-modal__title'
      title.textContent = 'Limpar leads capturados'
      const text = document.createElement('div')
      text.className = 'cs-modal__text'
      text.textContent =
        'Tem certeza que deseja remover todos os leads capturados desta sessão? ' +
        'Leads já importados para o VYNTRA não serão afetados.'
      const actions = document.createElement('div')
      actions.className = 'cs-modal__actions'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'cs-modal__btn cs-modal__btn--ghost'
      cancel.textContent = 'Cancelar'
      cancel.addEventListener('click', () => {
        overlay.remove()
        resolve()
      })
      const confirmBtn = document.createElement('button')
      confirmBtn.type = 'button'
      confirmBtn.className = 'cs-modal__btn cs-modal__btn--danger'
      confirmBtn.textContent = 'Limpar leads'
      confirmBtn.addEventListener('click', () => {
        overlay.remove()
        this.clearLocal()
        resolve()
      })
      actions.append(cancel, confirmBtn)
      card.append(title, text, actions)
      overlay.append(card)
      document.body.appendChild(overlay)
      requestAnimationFrame(() => overlay.classList.add('cs-open'))
    })
  }

  /** Esvazia a captura local (found/selected). Sem nenhuma chamada ao banco. */
  private clearLocal(): void {
    this.clearedSession = true
    this.found = []
    this.selected.clear()
    this.lastMatched = []
    if (this.resultPanel) this.resultPanel.style.display = 'none'
    this.syncAll()
    showToast('✓ Leads removidos')
  }
}

const start = () => {
  const host = window.location.hostname
  const href = window.location.href
  const isMaps = /(^|\.)google\.(com|com\.br|[a-z.]+)\/maps\//.test(href) || host.startsWith('maps.google')
  if (typeof document !== 'undefined') {
    import('./welcome').then(({ detectWelcomeSite, showWelcome }) => {
      const site = detectWelcomeSite(host, href)
      if (site && site !== 'global') showWelcome(site)
    })
  }
  if (isMaps) {
    const scanner = new MapsScanner()
    void scanner.init()
  } else {
    import('./global').then(({ GlobalScanner }) => {
      const scanner = new GlobalScanner()
      void scanner.init()
    })
  }
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

function findScrollParent(el: Element): HTMLElement | null {
  let p: HTMLElement | null = el.parentElement
  while (p && p.tagName !== 'BODY' && p.tagName !== 'HTML') {
    const s = getComputedStyle(p)
    if (
      ['auto', 'scroll'].includes(s.overflowY) ||
      (s.overflowY === 'clip' && ['auto', 'scroll'].includes(s.overflow))
    ) {
      return p
    }
    p = p.parentElement
  }
  return document.scrollingElement as HTMLElement
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

/** Heurística: procura no card do Maps um link/botão que aponte para o Instagram. */
function extractInstagram(card: HTMLElement | null): string | null {
  if (!card) return null
  const Sel = [
    'a[data-tooltip*="Instagram" i]',
    'a[aria-label*="Instagram" i]',
    'a[href*="instagram.com/"]',
    'a[href*="instagram.com"]',
  ]
  for (const sel of Sel) {
    const a = card.querySelector(sel) as HTMLAnchorElement | null
    const href = a?.href
    if (href && /instagram\.com/i.test(href)) return normalizeUrl(href)
  }
  // fallback textual
  const txt = card.innerText || ''
  const m = txt.match(/instagram\.com\/[A-Za-z0-9_.\-]+/i)
  return m ? `https://www.${m[0].toLowerCase()}` : null
}

/** Heurística: procura no card do Maps um link/botão que aponte para o Facebook. */
function extractFacebook(card: HTMLElement | null): string | null {
  if (!card) return null
  const Sel = [
    'a[data-tooltip*="Facebook" i]',
    'a[aria-label*="Facebook" i]',
    'a[href*="facebook.com/"]',
    'a[href*="fb.com/"]',
  ]
  for (const sel of Sel) {
    const a = card.querySelector(sel) as HTMLAnchorElement | null
    const href = a?.href
    if (href && /facebook\.com|fb\.com/i.test(href)) return normalizeUrl(href)
  }
  return null
}

function normalizeUrl(href: string): string {
  try {
    const u = new URL(href)
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}`
  } catch {
    return href.split('?')[0]
  }
}

function deriveRating(text: string): number | null {
  const m = text.match(/([\d.]+)[\s]*[★✩]/)
  return m ? parseFloat(m[1]) : null
}

function deriveReviews(text: string): number | null {
  const m = text.match(/\(([\d.,]+)\)/)
  return m ? parseInt(m[1].replace(/[^\d]/g, ''), 10) : null
}

export function injectStyles(): void {
  if (document.getElementById('consecom-css')) return
  const el = document.createElement('style')
  el.id = 'consecom-css'
  el.textContent = css
  document.head.appendChild(el)
}

export function showToast(text: string, kind: 'ok' | 'warn' = 'ok'): void {
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

/** Espera não-bloqueante (usada nos estágios de prospecção). */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms))
}

const phoneSvg =
  '<svg viewBox="0 0 24 24"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.8 2.1z"/></svg>'

const websiteIcon =
  '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm2.5 16c-.8 1.3-1.6 2-2.5 2s-1.7-.7-2.5-2c-.7-1.2-1.2-2.8-1.4-4.5h7.8c-.2 1.7-.7 3.3-1.4 4.5zM7.8 11.5c.2-1.7.7-3.3 1.4-4.5.8-1.3 1.6-2 2.5-2s1.7.7 2.5 2c.7 1.2 1.2 2.8 1.4 4.5H7.8zM12 4c.5.7.9 1.6 1.2 2.6h-2.4C10.6 5.6 11.2 4.6 12 4zm-3.1 7c-.1.5-.1 1 0 1.5H5.9a8 8 0 0 1 0-3h3c-.1.5-.1 1 0 1.5zm-1.6 3h3c.1 1.5.4 2.9.9 4-.9-.4-1.6-.9-2.3-1.6-.5-.6-1-1.5-1.6-2.4zM15.1 17c.7.7 1.4 1.2 2.3 1.6-.5-1.1-.8-2.5-.9-4h3a8 8 0 0 1-.9 3c-.5.5-1 .9-1.6 1.2-.6.3-1.3.5-1.9.6v-2.4zm3.6-4.5h-3.1c0-.5 0-1 .1-1.5h3a8 8 0 0 1 0 3h-3c0-.5-.1-1-.1-1.5zM7.1 7c-.7-.7-1.4-1.2-2.3-1.6.5 1.1.8 2.5.9 4h-3a8 8 0 0 1 .9-3c.5-.5 1-.9 1.6-1.2.6-.3 1.3-.5 1.9-.6V7zm0 1.5v2.4c.5 0 1 .1 1.5.1h1.6c-.1-1.4-.4-2.7-.9-3.8-.7.3-1.4.8-2.2 1.3zM12 20c-.5-.7-.9-1.6-1.2-2.6h2.4c-.3 1-.9 1.9-1.2 2.6z"/></svg>'

const checkIcon = '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>'

const plusIcon = '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>'

const gearIcon =
  '<svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm8.9-3.3a7.5 7.5 0 0 0 0-1.5l2-1.6-2-3.4-2.5 1a7.7 7.7 0 0 0-1.7-1L16 1.5h-4l-.4 2.5a7.7 7.7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 1.5l-2 1.6 2 3.4 2.5-1a7.7 7.7 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.7 7.7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6zM12 16.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>'

const starIcon =
  '<svg viewBox="0 0 24 24"><path d="M12 2l2.9 6.3 6.9.9-5 4.7 1.3 6.8L12 17.8 5.9 20.7l1.3-6.8-5-4.7 6.9-.9z"/></svg>'

const pinIcon =
  '<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>'

const downloadIcon =
  '<svg viewBox="0 0 24 24"><path d="M11 5h2v7h2l-3 3-3-3h2V5zm-6 12h14v2H5v-2z"/></svg>'

const listCheckIcon =
  '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>'

const trashIcon =
  '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>'
