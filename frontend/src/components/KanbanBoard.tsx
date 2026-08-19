import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase, type Lead, type LeadStatus, type Campaign, type ConversationMessage, type FollowUp } from '../lib/supabase'
import { computeEngagement, type Engagement } from '../lib/engagement'
import { filterLeadsBySearch } from '../lib/kanbanSearch'
import { LeadChat } from './LeadChat'
import { followUpsApi, leadsApi } from '../lib/api'
import { Modal } from './ui'

type Section =
  | 'enviados'
  | 'ia'
  | 'necessita_humano'
  | 'conversando'
  | 'sem_interesse'
  | 'remarketing'
  | 'responder_depois'
  | 'reuniao_marcada'
  | 'reuniao_cancelada'
  | 'para_ligacao'
  | 'concluidos'

const SECTIONS: { key: Section; label: string; icon: string; statuses: LeadStatus[] }[] = [
  { key: 'enviados', label: 'Enviados', icon: '📤', statuses: ['enviado', 'na_fila'] },
  { key: 'ia', label: 'IA', icon: '🤖', statuses: ['ia'] },
  { key: 'necessita_humano', label: 'Necessita de humano', icon: '🙋', statuses: ['necessita_humano'] },
  { key: 'conversando', label: 'Conversando', icon: '💬', statuses: ['conversando'] },
  { key: 'remarketing', label: 'Remarketing', icon: '🔁', statuses: ['remarketing'] },
  { key: 'responder_depois', label: 'Responder depois', icon: '↩', statuses: ['responder_depois'] },
  { key: 'sem_interesse', label: 'Sem interesse', icon: '🚫', statuses: ['sem_interesse'] },
  { key: 'reuniao_marcada', label: 'Reuniões', icon: '📅', statuses: ['reuniao_marcada'] },
  { key: 'reuniao_cancelada', label: 'Reuniões canceladas', icon: '🗓️', statuses: ['reuniao_cancelada'] },
  { key: 'para_ligacao', label: 'Nº p/ ligação', icon: '📞', statuses: ['para_ligacao'] },
  { key: 'concluidos', label: 'Concluídos', icon: '✅', statuses: ['fechado', 'nao_fechado'] },
]

const SECTION_COLOR: Record<Section, string> = {
  enviados: 'bg-sky-500',
  ia: 'bg-fuchsia-500',
  necessita_humano: 'bg-red-500',
  conversando: 'bg-violet-500',
  remarketing: 'bg-amber-500',
  responder_depois: 'bg-cyan-500',
  sem_interesse: 'bg-rose-500',
  reuniao_marcada: 'bg-emerald-500',
  reuniao_cancelada: 'bg-orange-500',
  para_ligacao: 'bg-cyan-400',
  concluidos: 'bg-green-500',
}

const NO_CAMPAIGN = '__none__'

// Permite navegar horizontalmente na pipeline segurando Ctrl + scroll.
// Precisa de listener nativo com passive:false (o onWheel do React é passivo,
// então preventDefault não cancelaria o zoom do navegador).
function useCtrlWheelHorizontalScroll() {
  const elRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    const scroller: HTMLDivElement = el
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey) return
      e.preventDefault()
      scroller.scrollLeft += e.deltaY + e.deltaX
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })
  return elRef
}

const BAR_COLOR: Record<Engagement['band'], string> = {
  alto: '#22c55e',
  bom: '#10b981',
  medio: '#f59e0b',
  baixo: '#f97316',
  nenhum: '#f43f5e',
}

function emptySections(): Record<Section, number> {
  return {
    enviados: 0,
    ia: 0,
    necessita_humano: 0,
    conversando: 0,
    sem_interesse: 0,
    remarketing: 0,
    responder_depois: 0,
    reuniao_marcada: 0,
    reuniao_cancelada: 0,
    para_ligacao: 0,
    concluidos: 0,
  }
}

function engagementTooltip(e: Engagement | undefined): string | undefined {
  if (!e) return undefined
  const rows = [
    `${e.emoji} ${e.total}% · ${e.label}`,
    `⚡ Resposta rápida ${e.sub.velocidade}%`,
    `💬 Volume de conversa ${e.sub.volume}%`,
    `🎯 Interesse ${e.sub.interesse}%`,
  ]
  if (e.sub.reuniao !== null) rows.push(`📅 Interesse na reunião ${e.sub.reuniao}%`)
  return rows.join('\n')
}

function scoreTooltip(lead: Lead): string {
  const factors = Array.isArray(lead.score_factors) ? (lead.score_factors as string[]) : []
  return [
    `Score ${lead.score}/100`,
    ...factors.map((f) => `• ${f}`),
    factors.length ? '' : '• Sem motivos registrados ainda',
  ].join('\n')
}

export function KanbanBoard({
  leads,
  campaigns,
  onMeeting,
  onClose,
}: {
  leads: Lead[]
  campaigns: Campaign[]
  onMeeting: (id: string, at: string, notes: string) => Promise<boolean>
  onClose: (id: string, closed: boolean, motivo: string, valor: number | null) => Promise<boolean>
}) {
  const [campaignFilter, setCampaignFilter] = useState<'all' | string>('all')
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null)
  const [modal, setModal] = useState<'meeting' | 'close' | null>(null)
  const [chatLead, setChatLead] = useState<Lead | null>(null)
  const [messagesByLead, setMessagesByLead] = useState<Map<string, ConversationMessage[]>>(new Map())
  // Busca por nome/telefone (debounce para não filtrar a cada tecla).
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  // Leads POR CAMPANHA vêm de send_runs (a participação real da campanha),
  // NÃO da lista global /leads — assim "limpar lista" nunca apaga o Kanban.
  const [byCampaign, setByCampaign] = useState<Map<string, Lead[]>>(new Map())
  // Drag-and-drop: lead em arrasto + coluna alvo + overrides otimistas (a
  // coluna muda na hora; o realtime confirma no banco e limpa o override).
  const [dragLead, setDragLead] = useState<Lead | null>(null)
  const [dragOverSection, setDragOverSection] = useState<string | null>(null)
  const [overrides, setOverrides] = useState<Record<string, LeadStatus>>({})

  const effectiveStatus = (l: Lead): LeadStatus => overrides[l.id] ?? l.status

  // Limpa overrides já refletidos pelo backend (realtime atualizou o status).
  useEffect(() => {
    setOverrides((prev) => {
      const stale = Object.entries(prev).filter(([id, st]) => {
        const real = leads.find((l) => l.id === id)?.status
        return real === st || real === undefined
      })
      if (stale.length === 0) return prev
      const next = { ...prev }
      for (const [id] of stale) delete next[id]
      return next
    })
  }, [leads])

  async function handleDrop(target: { key: Section; statuses: LeadStatus[] }) {
    const lead = dragLead
    setDragOverSection(null)
    setDragLead(null)
    if (!lead) return
    const from = effectiveStatus(lead)
    const to = target.statuses[0]
    if (!to || from === to) return
    setOverrides((prev) => ({ ...prev, [lead.id]: to }))
    try {
      await leadsApi.updateStatus(lead.id, to, `Movido manualmente no Kanban: ${from} → ${to}`)
    } catch {
      setOverrides((prev) => {
        const next = { ...prev }
        delete next[lead.id]
        return next
      })
      window.alert('Não foi possível mover o lead. Tente novamente.')
    }
  }
  const [enrolledIds, setEnrolledIds] = useState<Set<string>>(new Set())
  const [followUpsByLead, setFollowUpsByLead] = useState<Map<string, FollowUp[]>>(new Map())

  // Leads por campanha via send_runs (fonte única para o pipeline).
  useEffect(() => {
    let active = true
    async function load() {
      const { data, error } = await supabase
        .from('send_runs')
        .select('campaign_id, lead:leads(*)')
      if (error || !data) return
      const map = new Map<string, Lead[]>()
      const ids = new Set<string>()
      const rows = data as unknown as Array<{ campaign_id: string; lead: unknown }>
      for (const r of rows) {
        const lead = Array.isArray(r.lead) ? r.lead[0] : r.lead
        if (!lead || typeof lead !== 'object') continue
        const l = lead as Lead
        ids.add(l.id)
        const arr = map.get(r.campaign_id) ?? []
        if (!arr.some((x) => x.id === l.id)) arr.push(l)
        map.set(r.campaign_id, arr)
      }
      if (active) {
        setByCampaign(map)
        setEnrolledIds(ids)
      }
    }
    void load()
    const ch = supabase
      .channel('kanban-campaign-leads')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'send_runs' }, () => void load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, () => void load())
      .subscribe()
    return () => {
      active = false
      supabase.removeChannel(ch)
    }
  }, [])

  useEffect(() => {
    let active = true
    async function load() {
      const rows = await followUpsApi.list().catch(() => [])
      const map = new Map<string, FollowUp[]>()
      for (const row of rows) {
        const arr = map.get(row.lead_id) ?? []
        arr.push(row)
        map.set(row.lead_id, arr)
      }
      if (active) setFollowUpsByLead(map)
    }
    void load()
    const ch = supabase
      .channel('follow-ups-kanban-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'follow_ups' }, () => void load())
      .subscribe()
    return () => { active = false; supabase.removeChannel(ch) }
  }, [])

  // Conversas em tempo real (métricas de engajamento) — recarrega quando uma
  // nova mensagem entra, com debounce para não refazer o fetch a cada evento.
  useEffect(() => {
    let active = true
    let t: number | null = null
    async function load() {
      const { data, error } = await supabase
        .from('consecom_conversations')
        .select('*')
        .order('created_at', { ascending: true })
      if (error || !data) return
      const map = new Map<string, ConversationMessage[]>()
      for (const m of data as ConversationMessage[]) {
        const arr = map.get(m.lead_id) ?? []
        arr.push(m)
        map.set(m.lead_id, arr)
      }
      if (active) setMessagesByLead(map)
    }
    const debounced = () => {
      if (t) return
      t = window.setTimeout(() => {
        t = null
        void load()
      }, 300)
    }
    void load()
    const ch = supabase
      .channel('conversations-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'consecom_conversations' }, debounced)
      .subscribe()
    return () => {
      active = false
      if (t) window.clearTimeout(t)
      supabase.removeChannel(ch)
    }
  }, [])

  // Busca com debounce: só filtra depois de 300ms sem digitar.
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim().toLowerCase()), 300)
    return () => window.clearTimeout(t)
  }, [searchInput])

  const engagement = useMemo(() => {
    const map = new Map<string, Engagement>()
    for (const l of leads) {
      map.set(l.id, computeEngagement(l, messagesByLead.get(l.id) ?? []))
    }
    return map
  }, [leads, messagesByLead])

  const list = useMemo(() => {
    let base: Lead[]
    if (campaignFilter === 'all') {
      const all = Array.from(byCampaign.values()).flat()
      base = all.filter((l, i) => all.findIndex((x) => x.id === l.id) === i)
    } else if (campaignFilter === NO_CAMPAIGN) {
      // Sem campanha = leads ativos ainda não vinculados a nenhuma campanha.
      base = leads.filter((l) => l.is_active_in_prospecting !== false && !enrolledIds.has(l.id))
    } else {
      base = byCampaign.get(campaignFilter) ?? []
    }
    return search ? filterLeadsBySearch(base, search) : base
  }, [leads, campaignFilter, byCampaign, enrolledIds, search])

  const perCampaign = useMemo(() => {
    const map = new Map<string | null, { total: number; sections: Record<Section, number> }>()
    for (const c of campaigns) map.set(c.id, { total: 0, sections: emptySections() })
    if (!map.has(null)) map.set(null, { total: 0, sections: emptySections() })
    const tally = (l: Lead, key: string | null) => {
      const entry = map.get(key) ?? { total: 0, sections: emptySections() }
      entry.total++
      for (const sec of SECTIONS) {
        if (sec.statuses.includes(l.status)) entry.sections[sec.key]++
      }
      map.set(key, entry)
    }
    for (const [cid, arr] of byCampaign) {
      for (const l of arr) tally(l, cid)
    }
    // Sem campanha: leads ativos ainda não vinculados a nenhuma campanha.
    for (const l of leads) {
      if (l.is_active_in_prospecting !== false && !enrolledIds.has(l.id)) tally(l, null)
    }
    return map
  }, [byCampaign, campaigns, leads, enrolledIds])

  const selectedCampaign = campaignFilter !== 'all'
    ? campaigns.find((c) => c.id === campaignFilter)
    : undefined

  const pipelineRef = useCtrlWheelHorizontalScroll()

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-line flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold">Pipeline de prospecção</h1>
          <p className="text-sm text-muted">
            {campaignFilter === 'all'
              ? 'Visão geral por campanha — clique numa campanha para abrir a pipeline'
              : selectedCampaign
                ? `Leads da campanha "${selectedCampaign.name}"`
                : 'Leads sem campanha vinculada'}
            {campaignFilter !== 'all' && (
              <span className="text-faint"> · Ctrl + scroll navega pelas etapas</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {campaignFilter !== 'all' && (
<button onClick={() => setCampaignFilter('all')}
               className="text-xs text-accent-400 hover:text-fg transition font-medium">
               ← Todas
             </button>
          )}
          {campaignFilter !== 'all' && (
            <div className="relative">
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Buscar por nome ou telefone…"
                className="w-56 bg-field border border-line-2 rounded-xl pl-3 pr-7 py-1.5 text-sm text-fg outline-none focus:border-accent-500 placeholder:text-faint"
              />
              {searchInput && (
                <button
                  onClick={() => setSearchInput('')}
                  title="Limpar busca"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-faint hover:text-fg"
                >
                  ✕
                </button>
              )}
            </div>
          )}
          <label className="text-xs text-muted">
            Filtrar por campanha
            <select value={campaignFilter} onChange={(e) => setCampaignFilter(e.target.value)}
              className="ml-2 bg-field border border-line-2 rounded-xl px-2 py-1.5 text-sm text-fg outline-none focus:border-accent-500">
              <option value="all">Todos</option>
              <option value={NO_CAMPAIGN}>Sem campanha</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>
      </div>

      {campaignFilter === 'all' ? (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {Array.from(perCampaign.entries()).map(([cid, c]) => {
              const campaign = campaigns.find((x) => x.id === cid)
              const isNone = cid === null
              const name = isNone ? 'Sem campanha' : campaign?.name ?? 'Campanha removida'
              const visibleSections = SECTIONS.filter((s) => c.sections[s.key] > 0)
              return (
                <button
                  key={cid ?? NO_CAMPAIGN}
                  onClick={() => setCampaignFilter(cid ?? NO_CAMPAIGN)}
                  className="text-left rounded-xl border border-line bg-subtle hover:border-accent-500/40 hover:bg-subtle-2 transition p-4 group"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-sm truncate group-hover:text-accent-200">{name}</div>
                      {campaign?.description && (
                        <div className="text-[11px] text-faint truncate mt-0.5">{campaign.description}</div>
                      )}
                    </div>
                    <span className="shrink-0 text-xs text-muted bg-subtle rounded-full px-2 py-0.5">
                      {c.total} lead{c.total === 1 ? '' : 's'}
                    </span>
                  </div>
                  {visibleSections.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {visibleSections.map((s) => (
                        <span key={s.key} className="inline-flex items-center gap-1 text-[11px] text-secondary bg-subtle rounded-full px-2 py-0.5">
                          <span className="text-[10px]">{s.icon}</span>
                          {s.label} <span className="text-muted font-semibold">{c.sections[s.key]}</span>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-3 text-[11px] text-slate-600">Sem leads</div>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ) : list.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-6 py-16">
          <div className="text-center">
            <div className="text-3xl mb-2">{search ? '🔍' : '📭'}</div>
            <div className="text-sm text-muted">
              {search ? 'Nenhum lead encontrado.' : 'Sem leads nesta visão.'}
            </div>
          </div>
        </div>
      ) : (
        <div ref={pipelineRef} className="flex-1 flex gap-4 px-6 py-5 overflow-x-auto">
{SECTIONS.map((sec) => {
            const items = list.filter((l) => sec.statuses.includes(effectiveStatus(l)))
            const ordered = sec.key === 'reuniao_marcada'
              ? [...items].sort((a, b) => (a.meeting_at ?? '9999').localeCompare(b.meeting_at ?? '9999'))
              : sec.key === 'concluidos'
                ? [...items].sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''))
                : sec.key === 'para_ligacao'
                  ? [...items].sort((a, b) => (b.call_moved_at ?? '').localeCompare(a.call_moved_at ?? ''))
                  : items
            const isOver = dragOverSection === sec.key
            return (
              <div
                key={sec.key}
                onDragOver={(e) => {
                  if (!dragLead) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setDragOverSection(sec.key)
                }}
                onDragLeave={() => setDragOverSection((d) => (d === sec.key ? null : d))}
                onDrop={(e) => {
                  e.preventDefault()
                  void handleDrop(sec)
                }}
                className={`w-72 shrink-0 rounded-xl border border-line bg-subtle flex flex-col transition-colors ${isOver ? 'border-accent-500 ring-2 ring-accent-500/30' : ''}`}
              >
                <div className="px-4 py-3 flex items-center gap-2">
                  <span className="text-sm">{sec.icon}</span>
                  <span className="text-xs font-semibold text-secondary uppercase tracking-wide">{sec.label}</span>
                  <span className={`w-2 h-2 rounded-full ${SECTION_COLOR[sec.key]}`} />
                  <span className="ml-auto text-xs text-faint bg-subtle rounded-full px-2 py-0.5">{items.length}</span>
                </div>
                <div className="flex-1 px-2 pb-2 space-y-2 overflow-y-auto">
                  {ordered.map((lead) => (
                    <LeadCard
                      key={lead.id}
                      lead={{ ...lead, status: effectiveStatus(lead) }}
                      engagement={engagement.get(lead.id)}
                      followUps={followUpsByLead.get(lead.id) ?? []}
                      onAction={() => setChatLead(lead)}
                      onChat={() => setChatLead(lead)}
                      onMeeting={() => { setSelectedLead(lead); setModal('meeting') }}
                      onClose={() => { setSelectedLead(lead); setModal('close') }}
                      onDragStart={(l) => setDragLead(l)}
                      dragging={dragLead?.id === lead.id}
                    />
                  ))}
                  {ordered.length === 0 && (
                    <div className="text-xs text-slate-600 text-center py-6 border border-dashed border-line rounded-xl">Sem leads</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {selectedLead && modal === 'meeting' && (
        <MeetingModal
          lead={selectedLead}
          onClose={() => { setModal(null); setSelectedLead(null) }}
          onSave={async (at, notes) => {
            const ok = await onMeeting(selectedLead.id, at, notes)
            if (ok) { setModal(null); setSelectedLead(null) }
            return ok
          }}
        />
      )}
      {selectedLead && modal === 'close' && (
        <CloseModal
          lead={selectedLead}
          onClose={() => { setModal(null); setSelectedLead(null) }}
          onSave={async (closed, motivo, valor) => {
            const ok = await onClose(selectedLead.id, closed, motivo, valor)
            if (ok) { setModal(null); setSelectedLead(null) }
            return ok
          }}
        />
      )}
      {chatLead && (
        <LeadChat lead={chatLead} onClose={() => setChatLead(null)} />
      )}
    </div>
  )
}

const STATUS_BADGE: Record<LeadStatus, { label: string; cls: string }> = {
  novo: { label: 'Novo', cls: 'bg-slate-500/15 text-secondary' },
  na_fila: { label: 'Na fila', cls: 'bg-amber-500/15 text-amber-300' },
  enviado: { label: 'Enviado', cls: 'bg-sky-500/15 text-sky-300' },
  ia: { label: 'IA', cls: 'bg-fuchsia-500/15 text-fuchsia-300' },
  necessita_humano: { label: 'Necessita de humano', cls: 'bg-red-500/15 text-red-300' },
  conversando: { label: 'Conversando', cls: 'bg-violet-500/15 text-violet-300' },
  sem_interesse: { label: 'Sem interesse', cls: 'bg-rose-500/15 text-rose-300' },
  remarketing: { label: 'Remarketing', cls: 'bg-amber-500/15 text-amber-300' },
  responder_depois: { label: 'Responder depois', cls: 'bg-cyan-500/15 text-cyan-300' },
  reuniao_marcada: { label: 'Reunião', cls: 'bg-emerald-500/15 text-emerald-300' },
  reuniao_cancelada: { label: 'Cancelada', cls: 'bg-orange-500/15 text-orange-300' },
  fechado: { label: 'Fechado', cls: 'bg-green-500/15 text-green-300' },
  nao_fechado: { label: 'Não fechado', cls: 'bg-rose-500/15 text-rose-300' },
  para_ligacao: { label: 'Telefonar', cls: 'bg-cyan-400/15 text-cyan-300' },
}

const CALL_REASON_LABEL: Record<string, string> = {
  telefone_fixo: 'Número fixo (não tem WhatsApp)',
  numero_invalido: 'Número inválido / incorreto',
}

export function LeadCard({ lead, engagement, followUps, onAction, onChat, onMeeting, onClose, onDragStart, dragging }: {
  lead: Lead
  engagement?: Engagement
  followUps: FollowUp[]
  onAction: () => void
  onChat: () => void
  onMeeting: () => void
  onClose: () => void
  onDragStart?: (l: Lead) => void
  dragging?: boolean
}) {
  const badge = STATUS_BADGE[lead.status]
  const tooltip = engagementTooltip(engagement)
  return (
    <div className={`group relative rounded-xl bg-panel border border-line p-3 hover:border-line-2 transition cursor-pointer ${dragging ? 'opacity-40' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', lead.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart?.(lead)
      }}
      onClick={onChat}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            {lead.needs_attention && (
              <span title={lead.status === 'necessita_humano' ? 'Handoff — um lead precisa da sua atenção' : 'Respondeu e precisa de atenção (IA desativada)'} className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-300 font-semibold">⚠ ATENÇÃO</span>
            )}
            <div className="font-medium text-sm truncate">{lead.name || 'Sem nome'}</div>
          </div>
          {lead.niche && <div className="text-[11px] text-accent-300/80 truncate">{lead.niche}</div>}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <button onClick={(e) => { e.stopPropagation(); onAction() }} title="Abrir conversa (WhatsApp)"
            className="text-slate-600 hover:text-fg text-xs">•••</button>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${badge.cls}`}>{badge.label}</span>
          {typeof lead.score === 'number' && (
            <span
              title={scoreTooltip(lead)}
              className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-500/15 text-slate-300 font-semibold"
            >{lead.score} pts</span>
          )}
        </div>
      </div>

      {engagement && (
        <div title={tooltip} className="mt-2 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <span className="text-sm leading-none">{engagement.emoji}</span>
          <div className="flex-1 h-1.5 rounded-full bg-subtle overflow-hidden">
            <div className="h-full rounded-full transition-all"
              style={{ width: `${engagement.total}%`, background: BAR_COLOR[engagement.band] }} />
          </div>
          <span className="text-[11px] font-semibold text-secondary">{engagement.total}%</span>
        </div>
      )}

      {lead.status === 'reuniao_marcada' && lead.meeting_at && (
        <div className="mt-2 text-[11px] text-emerald-300 bg-emerald-500/10 rounded-md px-2 py-1">
          📅 {new Date(lead.meeting_at).toLocaleString('pt-BR')}
        </div>
      )}
      {lead.status === 'reuniao_cancelada' && lead.meeting_at && (
        <div className="mt-2 text-[11px] text-orange-300 bg-orange-500/10 rounded-md px-2 py-1">
          🗓️ Cancelada — era {new Date(lead.meeting_at).toLocaleString('pt-BR')}
        </div>
      )}
      {(lead.status === 'fechado' || lead.status === 'nao_fechado') && (
        <div className="mt-2 space-y-1 text-[11px] text-muted">
          {lead.status === 'fechado' && lead.sale_value != null && lead.sale_value > 0 && (
            <div className="text-emerald-300 bg-emerald-500/10 rounded-md px-2 py-1">
              💰 {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(lead.sale_value)}
            </div>
          )}
          <div>{lead.closed_reason || '(sem motivo)'}</div>
        </div>
      )}
      {lead.status === 'para_ligacao' && (lead.call_reason || lead.call_moved_at) && (
        <div className="mt-2 text-[11px] text-cyan-300 bg-cyan-400/10 rounded-md px-2 py-1">
          📞 {CALL_REASON_LABEL[lead.call_reason ?? ''] ?? lead.call_reason}
          {lead.call_moved_at && (
            <span className="text-cyan-300/60"> · {new Date(lead.call_moved_at).toLocaleString('pt-BR')}</span>
          )}
        </div>
      )}
      {lead.status === 'responder_depois' && followUps[0] && (
        <div className="mt-2 space-y-1 text-[11px] text-cyan-200 bg-cyan-500/10 rounded-md px-2 py-1.5">
          <div>↩ {followUps[0].message}</div>
          <div>{followUps[0].scheduled_date} · {followUps[0].scheduled_time ?? 'horário não informado'}</div>
          <div className="text-cyan-300/70">{followUps[0].status} · {followUps[0].source === 'ia' ? 'Agendado pela IA' : 'Agendado pelo operador'}</div>
        </div>
      )}

      <div className="mt-2 space-y-1 text-[11px] text-muted">
        {lead.phone && <div className="truncate">☎ {lead.phone}</div>}
        {lead.city && <div className="truncate">📍 {lead.city}{lead.state ? ', ' + lead.state : ''}</div>}
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
        {lead.status === 'reuniao_marcada' && (
          <button onClick={onMeeting} className="flex-1 text-[11px] px-2 py-1.5 rounded-md bg-subtle hover:bg-subtle-2 text-emerald-300">
            Reagendar
          </button>
        )}
        {lead.status !== 'reuniao_marcada' && lead.status !== 'fechado' && lead.status !== 'nao_fechado' && (
          <button onClick={onMeeting} className="flex-1 text-[11px] px-2 py-1.5 rounded-md bg-subtle hover:bg-subtle-2 text-accent-300">
            Marcar reunião
          </button>
        )}
        {onClose && lead.status !== 'fechado' && lead.status !== 'nao_fechado' && (
          <button onClick={onClose} className="flex-1 text-[11px] px-2 py-1.5 rounded-md bg-subtle hover:bg-subtle-2 text-secondary">
            Concluir
          </button>
        )}
      </div>
    </div>
  )
}

function MeetingModal({ lead, onClose, onSave }: {
  lead: Lead
  onClose: () => void
  onSave: (at: string, notes: string) => Promise<boolean>
}) {
  const [date, setDate] = useState(lead.meeting_at ? lead.meeting_at.slice(0, 16) : '')
  const [notes, setNotes] = useState(lead.meeting_notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit() {
    setBusy(true)
    setError('')
    const ok = await onSave(date, notes)
    setBusy(false)
    if (!ok) setError('Não foi possível salvar. Tente novamente.')
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Reunião"
      subtitle={lead.name || 'Sem nome'}
      footer={
        <>
          <button onClick={onClose} className="px-3 py-2 text-sm bg-subtle hover:bg-subtle-2 rounded-xl">Cancelar</button>
          <button onClick={() => void submit()} disabled={busy} className="px-4 py-2 text-sm bg-accent-600 text-white hover:bg-accent-500 disabled:opacity-50 rounded-xl font-medium">
            {busy ? 'Salvando...' : 'Salvar'}
          </button>
        </>
      }
    >
      <label className="block text-xs text-muted mb-3">
        Data e hora
        <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)}
          className="mt-1 w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500 transition-all" />
      </label>
      <label className="block text-xs text-muted mb-3">
        Observações
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
          className="mt-1 w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500 transition-all resize-none" />
      </label>
      {error && <p className="text-sm text-rose-400 mb-2">{error}</p>}
    </Modal>
  )
}

function CloseModal({ lead, onClose, onSave }: {
  lead: Lead
  onClose: () => void
  onSave: (closed: boolean, motivo: string, valor: number | null) => Promise<boolean>
}) {
  const [closed, setClosed] = useState(true)
  const [motivo, setMotivo] = useState('')
  const [valor, setValor] = useState(lead.sale_value ? String(lead.sale_value) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function parseValor(): number | null {
    if (!closed) return null
    const raw = valor.trim().replace('.', '').replace(',', '.')
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  async function submit() {
    if (closed && valor.trim()) {
      const parsed = parseValor()
      if (parsed == null) {
        setError('Informe um valor de venda válido (ex.: 1500 ou 1.500).')
        return
      }
    }
    setBusy(true)
    setError('')
    const ok = await onSave(closed, motivo, parseValor())
    setBusy(false)
    if (!ok) setError('Não foi possível salvar. Tente novamente.')
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Concluir lead"
      subtitle={lead.name || 'Sem nome'}
      footer={
        <>
          <button onClick={onClose} className="px-3 py-2 text-sm bg-subtle hover:bg-subtle-2 rounded-xl">Cancelar</button>
          <button onClick={() => void submit()} disabled={busy} className="px-4 py-2 text-sm bg-accent-600 text-white hover:bg-accent-500 disabled:opacity-50 rounded-xl font-medium">
            {busy ? 'Salvando...' : 'Concluir'}
          </button>
        </>
      }
    >
      <div className="space-y-2 mb-3">
        <label className="flex items-center gap-2 text-sm text-secondary">
          <input type="radio" checked={closed} onChange={() => setClosed(true)} className="accent-emerald-500" />
          Fechado (cliente fechou)
        </label>
        <label className="flex items-center gap-2 text-sm text-secondary">
          <input type="radio" checked={!closed} onChange={() => setClosed(false)} className="accent-rose-500" />
          Não fechado
        </label>
      </div>
      {closed && (
        <label className="block text-xs text-muted mb-3">
          Valor da venda (R$)
          <input value={valor} onChange={(e) => setValor(e.target.value)}
            inputMode="decimal" placeholder="Ex.: 1500"
            className="mt-1 w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500" />
        </label>
      )}
      <label className="block text-xs text-muted mb-3">
        Motivo
        <input value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: fora do orçamento, já tem fornecedor..."
          className="mt-1 w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500" />
      </label>
      {error && <p className="text-sm text-rose-400 mb-2">{error}</p>}
    </Modal>
  )
}
