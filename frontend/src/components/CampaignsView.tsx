import { useEffect, useMemo, useState } from 'react'
import { Button, Badge } from './ui'
import { supabase, type Campaign, type QueueMessage, type SendRun, type WhatsAppConnection } from '../lib/supabase'
import { SequenceEditor } from './SequenceEditor'
import { campaignSchedule, type CampaignCalendarItem, type CampaignScheduleConfig } from '../lib/campaigns'
import { buildMonthCells, monthTitle, addMonths, DAY_SHORT, saLocalDay, saLocalTime, humanDateTime } from '../lib/month'
import { subscribeConnectionAlerts } from '../lib/connectionAlerts'

/** Seções de campanhas: em andamento no topo, agendadas no meio, finalizadas embaixo. */
const SECTIONS: Array<{ key: string; title: string; statuses: Campaign['status'][] }> = [
  { key: 'em_andamento', title: 'Em andamento', statuses: ['em_progresso', 'waiting_connection', 'pausada'] },
  { key: 'prontas', title: 'Prontas', statuses: ['pronta'] },
  { key: 'agendadas', title: 'Agendadas', statuses: ['agendada'] },
  { key: 'finalizadas', title: 'Finalizadas', statuses: ['finalizada', 'cancelada'] },
]

const SECTION_EMOJI: Record<string, string> = {
  em_andamento: '🟢',
  prontas: '⚡',
  agendadas: '📅',
  finalizadas: '🏁',
}

function sectionOf(c: Campaign): string {
  for (const s of SECTIONS) if (s.statuses.includes(c.status)) return s.key
  return 'finalizadas'
}

function sortCampaigns(items: Campaign[]): Campaign[] {
  return [...items].sort((a, b) => {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER
    const pb = b.position ?? Number.MAX_SAFE_INTEGER
    if (pa !== pb) return pa - pb
    return (a.created_at ?? '').localeCompare(b.created_at ?? '')
  })
}

export function CampaignsView() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [messagesByCampaign, setMessagesByCampaign] = useState<Record<string, QueueMessage[]>>({})
  const [runsByCampaign, setRunsByCampaign] = useState<Record<string, SendRun[]>>({})
  const [queueFor, setQueueFor] = useState<Campaign | null>(null)
  const [connections, setConnections] = useState<WhatsAppConnection[]>([])
  const [scheduleFor, setScheduleFor] = useState<Campaign | null>(null)
  const [schedulePicker, setSchedulePicker] = useState(false)
  const [scheduleConfig, setScheduleConfig] = useState<CampaignScheduleConfig | null>(null)
  const [calAnchor, setCalAnchor] = useState(() => {
    const d = new Date(Date.now() - 3 * 3600_000)
    return { year: d.getUTCFullYear(), month0: d.getUTCMonth() }
  })
  const [calItems, setCalItems] = useState<CampaignCalendarItem[]>([])
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    campaignSchedule.getConfig().then((r) => setScheduleConfig(r.config)).catch(() => {})
  }, [])

  const calCells = useMemo(() => buildMonthCells(calAnchor.year, calAnchor.month0), [calAnchor])
  useEffect(() => {
    let alive = true
    campaignSchedule
      .calendar(calCells[0].key, calCells[41].key)
      .then((r) => {
        if (alive) setCalItems(r.items)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [calCells])

  const calByDay = useMemo(() => {
    const map = new Map<string, CampaignCalendarItem[]>()
    for (const it of calItems) {
      const ms = Date.parse(it.startIso)
      if (Number.isNaN(ms)) continue
      const key = saLocalDay(ms)
      const arr = map.get(key) ?? []
      arr.push(it)
      map.set(key, arr)
    }
    return map
  }, [calItems])

  useEffect(() => {
    load()
  }, [])

  // atualização em tempo real da fila de envio
  useEffect(() => {
    const ch = supabase
      .channel('send_runs')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'send_runs' },
        () => void loadRuns(),
      )
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [])

  // atualização em tempo real de campanhas e sequências (debounce p/ não
  // disparar a recarga inteira a cada evento individual)
  useEffect(() => {
    let t: number | null = null
    const refresh = () => {
      if (t) return
      t = window.setTimeout(() => {
        t = null
        void load()
      }, 250)
    }
    const ch = supabase
      .channel('campaigns-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaigns' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue_messages' }, refresh)
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
      if (t) window.clearTimeout(t)
    }
  }, [])

  async function load() {
    setLoadError(null)
    const { data, error } = await supabase.from('campaigns').select('*').order('position').order('created_at')
    if (error || !data) {
      setLoading(false)
      if (error) setLoadError(error.message)
      return
    }
    setCampaigns(data)
    const grouped: Record<string, QueueMessage[]> = {}
    for (const c of data) {
      const { data: msgs } = await supabase
        .from('queue_messages')
        .select('*')
        .eq('campaign_id', c.id)
        .order('position')
      if (msgs) grouped[c.id] = msgs
    }
    setMessagesByCampaign(grouped)
    await loadRuns()
    setLoading(false)
  }

  async function loadConnections() {
    const { data, error } = await supabase
      .from('whatsapp_connections')
      .select('*')
      .order('created_at')
    if (error || !data) return
    setConnections(data as WhatsAppConnection[])
  }

  useEffect(() => {
    void loadConnections()
  }, [])

  // Alerta sonoro quando uma conexão cai (config centralizada em lib/connectionAlerts).
  useEffect(() => {
    const stop = subscribeConnectionAlerts(() => connections)
    return stop
  }, [connections])

  async function setCampaignConnections(c: Campaign, ids: string[]) {
    const { error } = await supabase
      .from('campaigns')
      .update({ connection_ids: ids })
      .eq('id', c.id)
    if (!error) await load()
  }

  /** Reordena campanhas da MESMA seção via drag & drop, persistindo `position`. */
  async function reorderSection(sectionKey: string, fromId: string, toId: string) {
    if (fromId === toId) return
    const items = sortCampaigns(campaigns.filter((c) => sectionOf(c) === sectionKey))
    const fromIdx = items.findIndex((c) => c.id === fromId)
    const toIdx = items.findIndex((c) => c.id === toId)
    if (fromIdx < 0 || toIdx < 0) return
    const [moved] = items.splice(fromIdx, 1)
    items.splice(toIdx, 0, moved)
    const positions = items.map((c, i) => ({ id: c.id, position: i }))
    setCampaigns((prev) =>
      prev.map((c) => ({ ...c, position: positions.find((p) => p.id === c.id)?.position ?? c.position })),
    )
    for (const p of positions) {
      await supabase.from('campaigns').update({ position: p.position }).eq('id', p.id)
    }
  }

async function loadRuns() {
    const { data, error } = await supabase
      .from('send_runs')
      .select('*, campaign:campaigns(name), lead:leads(id,name,phone,status)')
      .order('created_at', { ascending: true })
      .limit(500)
    if (!error && data) {
      setRunsByCampaign(groupRunsByCampaign(data))
    }
  }

  function groupRunsByCampaign(rows: SendRun[]): Record<string, SendRun[]> {
    const map: Record<string, SendRun[]> = {}
    for (const r of rows) {
      const arr = map[r.campaign_id] ?? []
      arr.push(r)
      map[r.campaign_id] = arr
    }
    for (const arr of Object.values(map)) {
      arr.sort((a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER)
        || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    }
    return map
  }

  async function removeRun(r: SendRun) {
    if (!window.confirm(`Desenfileirar "${r.lead?.name ?? 'este lead'}" da campanha "${r.campaign?.name ?? ''}"?`)) return
    const { error } = await supabase.from('send_runs').delete().eq('id', r.id)
    if (!error) {
      setRunsByCampaign((byCampaign) => {
        const next = { ...byCampaign }
        next[r.campaign_id] = (next[r.campaign_id] ?? []).filter((x) => x.id !== r.id)
        return next
      })
    }
  }

async function fireCampaign(c: Campaign) {
    const running = campaigns.filter((x) => x.status === 'em_progresso' && x.id !== c.id)
    if (running.length > 0) {
      if (!window.confirm(`A campanha "${running[0].name}" está em progresso. O worker só dispara uma por vez. Enfileirar mesmo assim?`)) return
    }
    const { error } = await supabase.from('campaigns').update({ status: 'em_progresso', started_at: new Date().toISOString(), success_count: 0, fail_count: 0 }).eq('id', c.id)
    if (!error) await load()
  }

  /** PAUSAR: grava status 'pausada' no banco — o worker para de disparar esta
   *  campanha imediatamente e continua do ponto exato ao retomar. Nada é
   *  apagado nem resetado (current_position/next_send_at ficam intactos). */
  async function pauseCampaign(c: Campaign) {
    if (!window.confirm(
      `Pausar campanha "${c.name}"?\n\nOs disparos serão interrompidos e continuarão do ponto atual quando você retomar.`,
    )) return
    const { error } = await supabase.from('campaigns').update({ status: 'pausada' }).eq('id', c.id)
    if (error) window.alert(`Não foi possível pausar: ${error.message}`)
    else await load()
  }

  /** RETOMAR: devolve a campanha para 'em_progresso'. O worker (instância
   *  única) volta a processá-la exatamente da etapa salva — idempotente, sem
   *  criar fila paralela nem reenviar mensagens já confirmadas. */
  async function resumeCampaign(c: Campaign) {
    const { error } = await supabase.from('campaigns').update({ status: 'em_progresso' }).eq('id', c.id)
    if (error) window.alert(`Não foi possível retomar: ${error.message}`)
    else await load()
  }

  async function deleteCampaign(c: Campaign) {
    const active = (runsByCampaign[c.id] ?? []).filter((r) => r.status !== 'done').length
    let msg = `Excluir a campanha "${c.name}"?\n\nIsso apaga a sequência e o histórico de envios desta campanha. Os leads permanecem cadastrados (apenas desvinculados dela).`
    if (active > 0) msg += `\n\nAtenção: ${active} envio(s) pendente(s)/em andamento serão cancelados.`
    if (!window.confirm(msg)) return
    const { error } = await supabase.from('campaigns').delete().eq('id', c.id)
    if (error) {
      window.alert(`Não foi possível excluir a campanha: ${error.message}`)
      return
    }
    await load()
  }

  /** Cancela o agendamento de uma campanha (volta para 'cancelada'). */
  async function cancelScheduleCampaign(c: Campaign) {
    if (!window.confirm(`Cancelar o agendamento de "${c.name}"?`)) return
    const r = await campaignSchedule.cancel(c.id)
    if (!r.ok) window.alert(r.message ?? 'Não foi possível cancelar o agendamento.')
    await load()
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-line flex items-center justify-between">
        <div>
<h1 className="text-lg font-semibold text-fg">
            Campanhas & disparo
          </h1>
          <p className="text-sm text-muted">
            Monte a sequência, agende o início e acompanhe a fila por campanha (WhatsApp)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setSchedulePicker(true)}>
            📅 Agendar campanha
          </Button>
          <Button variant="secondary" onClick={load}>
            Atualizar
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5 space-y-10">
        <section>
          <CampaignButton onCreated={load} />
          <div className="mt-5 space-y-10">
            {SECTIONS.map((section) => {
              const items = sortCampaigns(campaigns.filter((c) => sectionOf(c) === section.key))
              if (items.length === 0) return null
              return (
                <div key={section.key}>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-3 flex items-center gap-2">
                    <Badge color={section.key === 'em_andamento' ? 'green' : section.key === 'prontas' ? 'amber' : section.key === 'agendadas' ? 'accent' : 'sky'} size="sm">
                      {SECTION_EMOJI[section.key]} {section.title}
                    </Badge>
                    <span className="text-[11px] font-normal text-faint">({items.length})</span>
                  </h2>
                  <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                    {items.map((c) => (
                      <div
                        key={c.id}
                        draggable
                        onDragStart={() => setDragId(c.id)}
                        onDragOver={(e) => {
                          e.preventDefault()
                          setDragOver(c.id)
                        }}
                        onDragLeave={() => setDragOver((d) => (d === c.id ? null : d))}
                        onDrop={(e) => {
                          e.preventDefault()
                          if (dragId) void reorderSection(section.key, dragId, c.id)
                          setDragId(null)
                          setDragOver(null)
                        }}
                        onDragEnd={() => {
                          setDragId(null)
                          setDragOver(null)
                        }}
                        className={`transition-shadow rounded-xl ${
                          dragOver === c.id && dragId && dragId !== c.id
                            ? 'ring-2 ring-accent-400 ring-offset-1 ring-offset-panel'
                            : ''
                        } ${dragId === c.id ? 'opacity-50' : ''}`}
                        title="Arraste para reordenar dentro desta seção"
                      >
                        <CampaignCard
                          campaign={c}
                          messages={messagesByCampaign[c.id] ?? []}
                          connections={connections}
                          runs={runsByCampaign[c.id] ?? []}
                          onChanged={load}
                          onSetConnections={(ids) => void setCampaignConnections(c, ids)}
                          onShowQueue={() => setQueueFor(c)}
                          onFire={() => void fireCampaign(c)}
                          onPause={() => void pauseCampaign(c)}
                          onResume={() => void resumeCampaign(c)}
                          onSchedule={() => setScheduleFor(c)}
                          onCancelSchedule={() => void cancelScheduleCampaign(c)}
                          onDelete={() => void deleteCampaign(c)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
            {loading ? (
              <div className="grid gap-4 lg:grid-cols-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="rounded-2xl border border-line bg-panel p-5 space-y-3 animate-pulse-soft">
                    <div className="h-4 w-1/3 rounded bg-subtle-2" />
                    <div className="h-3 w-2/3 rounded bg-subtle-2" />
                    <div className="h-3 w-1/2 rounded bg-subtle-2" />
                    <div className="h-8 w-full rounded-xl bg-subtle-2" />
                  </div>
                ))}
              </div>
            ) : loadError ? (
              <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-4 text-sm text-rose-500 flex items-center justify-between gap-3">
                <span>Não foi possível carregar as campanhas.</span>
                <Button variant="outline" size="sm" onClick={() => void load()}>Tentar de novo</Button>
              </div>
            ) : campaigns.length === 0 && (
              <p className="text-sm text-faint">
                Nenhuma campanha criada ainda.
              </p>
            )}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Calendário de campanhas
            </h2>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setCalAnchor((a) => addMonths(a.year, a.month0, -1))}
                className="p-1.5 rounded-xl border border-line-2 hover:bg-subtle text-secondary text-xs"
              >
                ←
              </button>
              <span className="px-2 py-1 text-xs text-secondary border border-line-2 rounded-xl min-w-28 text-center">
                {monthTitle(calAnchor.year, calAnchor.month0)}
              </span>
              <button
                onClick={() => setCalAnchor((a) => addMonths(a.year, a.month0, 1))}
                className="p-1.5 rounded-xl border border-line-2 hover:bg-subtle text-secondary text-xs"
              >
                →
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-px bg-line-2 rounded-xl overflow-hidden border border-line-2">
            {DAY_SHORT.map((d) => (
              <div
                key={d}
                className="bg-subtle px-1 py-1 text-center text-[10px] font-medium uppercase tracking-wide text-muted"
              >
                {d}
              </div>
            ))}
            {calCells.map((cell) => {
              const dayItems = calByDay.get(cell.key) ?? []
              return (
                <div
                  key={cell.key}
                  className={`min-h-16 p-1 text-left align-top ${cell.inMonth ? 'bg-subtle' : 'bg-subtle-2/60'}`}
                >
                  <div className={`text-[11px] px-1 flex items-center justify-between ${cell.inMonth ? 'text-fg' : 'text-faint'}`}>
                    <span>{cell.day}</span>
                    {dayItems.length > 0 && (
                      <span className="text-[9px] px-1 rounded-full bg-accent-600/20 text-accent-300">
                        {dayItems.length}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 space-y-0.5">
                    {dayItems.slice(0, 2).map((it) => (
                      <button
                        key={it.campaignId}
                        onClick={() => {
                          const c = campaigns.find((x) => x.id === it.campaignId)
                          if (c) setScheduleFor(c)
                        }}
                        title={`${it.name} · ${humanDateTime(Date.parse(it.startIso))} até ${humanDateTime(Date.parse(it.endIso))} · ${it.leadCount} leads — clique para reagendar`}
                        className={`w-full truncate rounded px-1 py-0.5 text-[9px] leading-tight text-left ${
                          it.status === 'em_progresso'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : it.status === 'pausada'
                              ? 'bg-amber-500/20 text-amber-300'
                              : 'bg-accent-600/20 text-accent-300'
                        }`}
                      >
                        {saLocalTime(Date.parse(it.startIso))} {it.name}
                      </button>
                    ))}
                    {dayItems.length > 2 && (
                      <div className="px-1 text-[9px] text-faint">+{dayItems.length - 2} mais</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          {scheduleConfig && (
            <p className="text-[11px] text-faint mt-2">
              Intervalo mínimo entre campanhas: {scheduleConfig.interval_min} min. Clique em uma
              campanha no calendário para reagendar. A campanha seguinte só pode começar depois do
              fim + intervalo da anterior.
            </p>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Fila de envio
            </h2>
            <span className="text-[11px] text-faint">
              {Object.values(runsByCampaign).reduce((acc, rs) => acc + rs.filter((r) => r.status === 'pending' || r.status === 'running').length, 0)} ativo(s) em espera
            </span>
          </div>
          <div className="rounded-xl border border-line overflow-hidden">
            {campaigns.filter((c) => (runsByCampaign[c.id] ?? []).length > 0).length === 0 ? (
              <p className="text-sm text-faint border border-dashed border-line-2 rounded-xl px-4 py-6 text-center m-2">
                Nenhuma execução de envio ainda. Distribua leads para uma campanha para começar.
              </p>
            ) : (
              <table className="w-full text-sm">
                <tbody>
                  {campaigns
                    .filter((c) => (runsByCampaign[c.id] ?? []).length > 0)
                    .map((c) => {
                      const rs = runsByCampaign[c.id] ?? []
                      const active = rs.filter((r) => r.status === 'pending' || r.status === 'running').length
                      const done = rs.filter((r) => r.status === 'done').length
                      const failed = rs.filter((r) => r.status === 'failed').length
                      return (
                        <tr key={c.id} className="border-b border-line last:border-0">
                          <td className="px-4 py-2.5">
                            <div className="font-medium">{c.name}</div>
                          </td>
                          <td className="px-4 py-2.5 text-secondary">
                            <span className="text-emerald-300">{active} ativo</span>
                            {' · '}
                            <span className="text-sky-300">{done} concluído</span>
                            {failed > 0 && <> · <span className="text-rose-300">{failed} falhou</span></>}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <button
                              onClick={() => setQueueFor(c)}
                              className="text-[11px] px-2.5 py-1 rounded-xl bg-accent-600/20 text-accent-300 hover:bg-accent-600/30"
                            >
                              Fila de leads ({rs.length})
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>

{queueFor && (
        <QueueModal
          campaign={queueFor}
          runs={runsByCampaign[queueFor.id] ?? []}
          onClose={() => setQueueFor(null)}
          onRemove={removeRun}
          onChanged={() => void loadRuns()}
        />
      )}

      {scheduleFor && (
        <ScheduleModal
          initial={scheduleFor}
          campaigns={campaigns}
          config={scheduleConfig}
          connections={connections}
          onClose={() => setScheduleFor(null)}
          onSaved={() => {
            setScheduleFor(null)
            void load()
          }}
        />
      )}

      {schedulePicker && (
        <ScheduleModal
          initial={null}
          campaigns={campaigns}
          config={scheduleConfig}
          connections={connections}
          onClose={() => setSchedulePicker(false)}
          onSaved={() => {
            setSchedulePicker(false)
            void load()
          }}
        />
      )}
    </div>
  )
}

// Wrapper para criar campanha
function CampaignButton({ onCreated }: { onCreated: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')

  async function create() {
    if (!name.trim()) return
    const { error } = await supabase.from('campaigns').insert({ name: name.trim() })
    if (!error) {
      setName('')
      setOpen(false)
      await onCreated()
    }
  }

  return (
    <div>
      {open ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
          className="flex gap-2 items-center"
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nome da campanha"
            className="flex-1 max-w-xs"
          />
          <Button type="submit" onClick={() => {}}>
            Criar
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
        </form>
      ) : (
        <Button onClick={() => setOpen(true)}>
          + Nova campanha
        </Button>
      )}
    </div>
  )
}

function CampaignCard({
  campaign,
  messages,
  connections,
  runs,
  onChanged,
  onSetConnections,
  onShowQueue,
  onFire,
  onPause,
  onResume,
  onSchedule,
  onCancelSchedule,
  onDelete,
}: {
  campaign: Campaign
  messages: QueueMessage[]
  connections: WhatsAppConnection[]
  runs: SendRun[]
  onChanged: () => void
  onSetConnections: (ids: string[]) => void
  onShowQueue: () => void
  onFire: () => void
  onPause: () => void
  onResume: () => void
  onSchedule: () => void
  onCancelSchedule: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const activeConnections = connections.filter((c) => c.status === 'connected')
  const runActive = runs.filter((r) => r.status === 'pending' || r.status === 'running').length
  return (
    <div className="rounded-xl border border-line bg-subtle p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0">
          <div className="font-semibold truncate">{campaign.name}</div>
          <div className="text-[11px] text-muted">
            {messages.length} mensagem(ns) na sequência · {runs.length} lead(s) na fila
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <CampaignStatusBadge status={campaign.status} />
          <span
            onClick={onShowQueue}
            title="Ver fila de leads desta campanha"
            className="text-[11px] px-2 py-1 rounded-xl bg-accent-600/20 text-accent-300 hover:bg-accent-600/30 cursor-pointer"
          >
            Fila de leads
          </span>
          <span
            onClick={() => setOpen((o) => !o)}
            className={`text-[11px] px-2 py-1 rounded-xl cursor-pointer ${open ? 'bg-subtle hover:bg-subtle-2 text-secondary' : 'bg-accent-600/20 text-accent-300 hover:bg-accent-600/30'}`}
          >
            {open ? 'Fechar' : 'Montar sequência'}
          </span>
          <button
            onClick={onDelete}
            title="Excluir campanha"
            className="p-1.5 rounded-xl text-faint hover:text-rose-400 hover:bg-rose-500/10 transition"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-subtle text-secondary">{campaign.lead_count} leads</span>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">{campaign.success_count} sucessos</span>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300">{campaign.fail_count} falhas</span>
        {runActive > 0 && (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-300">{runActive} em fila</span>
        )}
      </div>

      <div className="mb-3 space-y-2">
        <label className="text-[11px] text-muted block">Conexões WhatsApp (round-robin por lead):</label>
        <div className="flex flex-wrap gap-2">
          {activeConnections.map((connection) => {
            const checked = (campaign.connection_ids ?? []).includes(connection.id)
            return (
              <label key={connection.id} className="flex items-center gap-1.5 rounded border border-line-2 px-2 py-1 text-[11px] text-secondary cursor-pointer">
                <input type="checkbox" checked={checked} onChange={() => onSetConnections(checked ? (campaign.connection_ids ?? []).filter((id) => id !== connection.id) : [...(campaign.connection_ids ?? []), connection.id])} />
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                {connection.display_name ?? connection.whatsapp_name ?? connection.phone_number ?? connection.instance_name}
              </label>
            )
          })}
        </div>
        {activeConnections.length === 0 && (
          <span className="text-[11px] text-amber-400/80 block">
            Nenhum WhatsApp conectado — conecte ao menos um para a campanha disparar.
          </span>
        )}
      </div>

      <CampaignStatusBanner status={campaign.status} scheduledAt={campaign.scheduled_at} />

      {campaign.status === 'pronta' && (
        <div className="space-y-2 mb-3">
          <Button className="w-full" onClick={onFire}>
            ▶ Iniciar campanha agora
          </Button>
          <Button className="w-full" onClick={onSchedule}>
            📅 Agendar início
          </Button>
        </div>
      )}
      {campaign.status === 'agendada' && (
        <div className="space-y-2 mb-3">
          <Button className="w-full" onClick={onSchedule}>
            📅 Reagendar início
          </Button>
          <Button className="w-full" variant="danger" onClick={onCancelSchedule}>
            ✕ Cancelar agendamento
          </Button>
        </div>
      )}
      {campaign.status === 'em_progresso' && (
        <Button className="w-full" onClick={onPause}>
          ⏸ Pausar campanha
        </Button>
      )}
      {campaign.status === 'pausada' && (
        <Button className="w-full" onClick={onResume}>
          ▶ Retomar campanha
        </Button>
      )}
      {campaign.status === 'waiting_connection' && (
        <Button className="w-full" onClick={onResume}>
          ▶ Retomar agora (conexão disponível)
        </Button>
      )}

      {!open ? (
        <ol className="space-y-1.5">
          {messages.map((m, i) => (
            <li key={m.id} className="text-xs flex items-center gap-2 text-secondary">
              <span className="w-5 h-5 shrink-0 rounded-full bg-subtle flex items-center justify-center text-[10px] text-muted">
                {i + 1}
              </span>
              <KindBadge kind={m.kind} />
              <span className="truncate flex-1">{m.text || (m.media_url ? 'Mídia' : '...')}</span>
              {m.delay_seconds > 0 && (
                <span className="text-[10px] text-faint shrink-0">+{m.delay_seconds}s</span>
              )}
            </li>
          ))}
          {messages.length === 0 && (
            <li className="text-xs text-slate-600">
              Sem mensagens — monte a sequência no painel da campanha.
            </li>
          )}
        </ol>
      ) : (
        <SequenceEditor campaign={campaign} messages={messages} onSaved={onChanged} />
      )}
    </div>
  )
}

/** Fila de leads de uma campanha específica (fonte de verdade: send_runs). */
function QueueModal({
  campaign,
  runs,
  onClose,
  onRemove,
  onChanged,
}: {
  campaign: Campaign
  runs: SendRun[]
  onClose: () => void
  onRemove: (r: SendRun) => void
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<SendRun | null>(null)
  if (runs.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="w-full max-w-lg rounded-2xl border border-line-2 bg-panel p-5 shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="font-semibold">Fila de leads</div>
              <div className="text-xs text-muted">Campanha: {campaign.name}</div>
            </div>
            <button onClick={onClose} className="text-muted hover:text-fg text-xl leading-none">×</button>
          </div>
          <p className="text-sm text-faint border border-dashed border-line-2 rounded-xl px-4 py-6 text-center">
            Esta campanha ainda não tem leads na fila. Distribua leads para ela na guia Importados
            ou no painel de leads para começar.
          </p>
          <div className="flex justify-end mt-4">
            <button onClick={onClose} className="px-3 py-2 text-sm bg-subtle hover:bg-subtle-2 rounded-xl">Fechar</button>
          </div>
        </div>
      </div>
    )
  }
  const activeCount = runs.filter((r) => r.status === 'pending' || r.status === 'running').length
  const doneCount = runs.filter((r) => r.status === 'done').length
  const failedCount = runs.filter((r) => r.status === 'failed').length
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl rounded-2xl border border-line-2 bg-panel p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="font-semibold">Fila de leads</div>
            <div className="text-xs text-muted">
              Campanha: {campaign.name} · {runs.length} lead(s) na fila
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-fg text-xl leading-none">×</button>
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">{activeCount} ativo(s)</span>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300">{doneCount} concluído(s)</span>
          {failedCount > 0 && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300">{failedCount} falhou(s)</span>
          )}
        </div>

        {detail ? (
          <div className="rounded-xl border border-line-2 bg-subtle-2 p-4 mb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="font-medium text-sm">{detail.lead?.name ?? '—'} <span className="text-faint font-normal">{detail.lead?.phone ?? ''}</span></div>
              <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${(RUN_STATUS[detail.status] ?? RUN_STATUS.pending).cls}`}>
                {(RUN_STATUS[detail.status] ?? RUN_STATUS.pending).label}
              </span>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-xs text-secondary">
              <div>
                <dt className="text-faint">Etapa</dt>
                <dd>#{(detail.current_position ?? 0) + 1}</dd>
              </div>
              <div>
                <dt className="text-faint">Próximo envio</dt>
                <dd>{detail.next_send_at ? new Date(detail.next_send_at).toLocaleString('pt-BR') : '—'}</dd>
              </div>
              <div>
                <dt className="text-faint">Último envio</dt>
                <dd>{detail.last_sent_at ? new Date(detail.last_sent_at).toLocaleString('pt-BR') : '—'}</dd>
              </div>
              <div>
                <dt className="text-faint">Conexão</dt>
                <dd>{detail.connection_instance ?? 'padrão'}</dd>
              </div>
              {detail.status === 'failed' && detail.fail_reason && (
                <div className="col-span-2">
                  <dt className="text-faint">Motivo da falha</dt>
                  <dd className="text-rose-300">{FAIL_REASON_LABEL[detail.fail_reason] ?? detail.fail_reason}</dd>
                </div>
              )}
            </dl>
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setDetail(null)} className="px-3 py-1.5 text-xs bg-subtle hover:bg-subtle-2 rounded-xl">Voltar</button>
              {detail.status !== 'done' && (
                <button onClick={() => { void onRemove(detail); setDetail(null) }} className="px-3 py-1.5 text-xs bg-rose-600/70 hover:bg-rose-500 rounded-xl text-white">
                  Desenfileirar
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-faint border-b border-line bg-subtle">
                  <th className="px-3 py-2 font-medium">Lead</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Conexão</th>
                  <th className="px-3 py-2 font-medium text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 100).map((r) => {
                  const st = RUN_STATUS[r.status]
                  return (
                    <tr key={r.id} className="border-b border-line last:border-0 hover:bg-subtle cursor-pointer" onClick={() => setDetail(r)}>
                      <td className="px-3 py-2">
                        <div className="font-medium truncate max-w-[220px]">{r.lead?.name ?? '—'}</div>
                        {r.lead?.phone && <div className="text-[11px] text-faint">{r.lead.phone}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`${st.cls} px-2 py-0.5 rounded text-[11px] font-medium`}>{st.label}</span>
                      </td>
                      <td className="px-3 py-2 text-faint text-[11px]">{r.connection_instance ?? 'padrão'}</td>
                      <td className="px-3 py-2 text-right">
                        {r.status !== 'done' && (
                          <button
                            onClick={(e) => { e.stopPropagation(); void onRemove(r) }}
                            title="Desenfileirar"
                            className="text-faint hover:text-rose-400 text-lg leading-none"
                          >
                            ×
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {runs.length > 100 && (
              <div className="px-3 py-2 text-[11px] text-faint border-t border-line">
                Exibindo 100 de {runs.length} — use a coluna de status para filtrar.
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end mt-4 gap-2">
          <button onClick={() => void onChanged()} className="px-3 py-2 text-sm bg-subtle hover:bg-subtle-2 rounded-xl">
            Atualizar
          </button>
          <button onClick={onClose} className="px-3 py-2 text-sm bg-accent-600 hover:bg-accent-500 rounded-xl font-medium">
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}

/** Modal de agendamento: escolhe campanha, data/hora e valida conflito. */
function ScheduleModal({
  initial,
  campaigns,
  config,
  connections,
  onClose,
  onSaved,
}: {
  initial: Campaign | null
  campaigns: Campaign[]
  config: CampaignScheduleConfig | null
  connections: WhatsAppConnection[]
  onClose: () => void
  onSaved: () => void
}) {
  const schedulable = useMemo(
    () => campaigns.filter((c) => c.status === 'pronta' || c.status === 'agendada'),
    [campaigns],
  )
  const [campaignId, setCampaignId] = useState<string>(initial?.id ?? '')
  const [local, setLocal] = useState<string>(() => defaultLocal())
  const [info, setInfo] = useState<{ durationMin: number; nextAvailableStart: string } | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const selected = campaigns.find((c) => c.id === campaignId)

  useEffect(() => {
    if (!campaignId) return
    let alive = true
    campaignSchedule
      .next({ campaignId, afterMs: Date.now() })
      .then((r) => {
        if (alive) setInfo({ durationMin: r.durationMin, nextAvailableStart: r.nextAvailableStart })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [campaignId])

  function defaultLocal(): string {
    const d = new Date(Date.now() - 3 * 3600_000)
    const hh = String(d.getUTCHours() + 1).padStart(2, '0')
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${hh}:00`
  }

  function localToIso(value: string): string {
    return new Date(`${value}:00-03:00`).toISOString()
  }

  async function submit() {
    setError('')
    if (!campaignId) {
      setError('Selecione a campanha.')
      return
    }
    if (!local) {
      setError('Informe a data e o horário do início.')
      return
    }
    setSaving(true)
    try {
      const r = await campaignSchedule.schedule(campaignId, localToIso(local))
      if (!r.ok) {
        setError(r.message ?? 'Não foi possível agendar.')
        return
      }
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao agendar.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-line-2 bg-panel p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="font-semibold">
              {initial ? 'Reagendar campanha' : 'Agendar campanha'}
            </div>
            <div className="text-xs text-muted">
              A campanha inicia automaticamente no horário escolhido.
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-fg text-xl leading-none">
            ×
          </button>
        </div>

        <div className="space-y-3">
          <label className="block text-xs text-muted">
            Campanha
            {initial ? (
              <div className="mt-1 text-sm text-fg bg-subtle rounded-xl px-3 py-2">
                {initial.name}
              </div>
            ) : (
              <select
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                className="mt-1 w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500"
              >
                <option value="">Selecione a campanha...</option>
                {schedulable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.status === 'agendada' ? ' (já agendada)' : ''}
                  </option>
                ))}
              </select>
            )}
          </label>

          <label className="block text-xs text-muted">
            Início (America/Sao_Paulo)
            <input
              type="datetime-local"
              value={local}
              onChange={(e) => setLocal(e.target.value)}
              className="mt-1 w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500"
            />
          </label>

          {info && selected && (
            <div className="rounded-xl border border-line bg-subtle-2 px-3 py-2 text-xs text-secondary space-y-1">
              <div>
                Duração estimada da campanha:{' '}
                <span className="text-fg font-medium">{info.durationMin} min</span>
                {' '}({selected.lead_count ?? 0} leads)
              </div>
              <div>
                Próximo início livre:{' '}
                <button
                  onClick={() => setLocal(`${saLocalDay(Date.parse(info.nextAvailableStart))}T${saLocalTime(Date.parse(info.nextAvailableStart))}`)}
                  className="text-accent-300 hover:underline"
                >
                  {humanDateTime(Date.parse(info.nextAvailableStart))}
                </button>
              </div>
              {config && (
                <div className="text-faint">
                  Intervalo mínimo entre campanhas: {config.interval_min} min
                </div>
              )}
              {(() => {
                const sel = (selected.connection_ids ?? []).filter((id) =>
                  connections.some((conn) => conn.id === id && conn.status === 'connected'),
                )
                if (sel.length === 0) {
                  return (
                    <div className="text-amber-300">
                      ⚠️ Nenhuma conexão do WhatsApp conectada nesta campanha. O envio não acontecerá
                      até você selecionar ao menos uma conexão.
                    </div>
                  )
                }
                return <div className="text-faint">Conexões prontas para envio: {sel.length}</div>
              })()}
            </div>
          )}

          {error && (
            <div className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-2 text-sm bg-subtle hover:bg-subtle-2 rounded-xl">
              Cancelar
            </button>
            <button
              onClick={() => void submit()}
              disabled={saving || !campaignId}
              className="px-4 py-2 text-sm bg-accent-600 hover:bg-accent-500 disabled:opacity-50 rounded-xl font-medium"
            >
              {saving ? 'Agendando...' : 'Agendar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const CAMPAIGN_STATUS: Record<Campaign['status'], { label: string; cls: string }> = {
  pronta: { label: 'Pronta', cls: 'bg-subtle text-secondary' },
  agendada: { label: 'Agendada', cls: 'bg-accent-600/20 text-accent-300' },
  em_progresso: { label: 'Em andamento', cls: 'bg-emerald-500/15 text-emerald-300' },
  waiting_connection: { label: 'Aguardando conexão', cls: 'bg-orange-500/15 text-orange-300' },
  pausada: { label: 'Pausada', cls: 'bg-amber-500/15 text-amber-300' },
  finalizada: { label: 'Concluída', cls: 'bg-sky-500/15 text-sky-300' },
  cancelada: { label: 'Cancelada', cls: 'bg-rose-500/15 text-rose-300' },
}

function CampaignStatusBadge({ status }: { status: Campaign['status'] }) {
  const color = status === 'pronta' ? 'green' : status === 'agendada' ? 'accent' : status === 'em_progresso' || status === 'waiting_connection' ? 'amber' : status === 'pausada' ? 'orange' : status === 'finalizada' ? 'sky' : 'gray'
  const label = CAMPAIGN_STATUS[status]?.label ?? status
  return (
    <Badge color={color} size="sm">{label}</Badge>
  )
}

/** Banner de status da campanha (Reflete o estado real vindo do banco). */
function CampaignStatusBanner({ status, scheduledAt }: { status: Campaign['status']; scheduledAt?: string | null }) {
  if (status === 'agendada') {
    return (
      <div className="mb-3 rounded-xl bg-accent-600/10 border border-accent-500/20 px-3 py-2 text-sm text-accent-300 flex items-center gap-2">
        🕐 Campanha agendada para {scheduledAt ? humanDateTime(Date.parse(scheduledAt)) : '—'}.
        O disparo começa automaticamente no horário.
      </div>
    )
  }
  if (status === 'em_progresso') {
    return (
      <div className="mb-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-sm text-emerald-300 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        🟢 Campanha em andamento
      </div>
    )
  }
  if (status === 'waiting_connection') {
    return (
      <div className="mb-3 rounded-xl bg-orange-500/10 border border-orange-500/20 px-3 py-2 text-sm text-orange-300 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
        🟠 Todas as conexões do WhatsApp caíram — fila preservada, aguardando conexão.
        Retoma automaticamente quando alguma conexão voltar.
      </div>
    )
  }
  if (status === 'pausada') {
    return (
      <div className="mb-3 rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-sm text-amber-300 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-amber-400" />
        🟡 Campanha pausada
      </div>
    )
  }
  if (status === 'finalizada') {
    return (
      <div className="mb-3 rounded-xl bg-sky-500/10 border border-sky-500/20 px-3 py-2 text-sm text-sky-300 flex items-center gap-2">
        ✓ Campanha concluída
      </div>
    )
  }
  return null
}

const RUN_STATUS: Record<SendRun['status'], { label: string; cls: string }> = {
  pending: { label: 'Pendente', cls: 'bg-slate-500/15 text-secondary' },
  running: { label: 'Rodando', cls: 'bg-amber-500/15 text-amber-300' },
  done: { label: 'Concluído', cls: 'bg-emerald-500/15 text-emerald-300' },
  failed: { label: 'Falhou', cls: 'bg-rose-500/15 text-rose-300' },
}

const FAIL_REASON_LABEL: Record<string, string> = {
  telefone_fixo: 'Número fixo → Nº p/ ligação',
  numero_invalido: 'Número inválido → Nº p/ ligação',
  sem_telefone: 'Lead sem telefone',
  send_failed: 'Falha de envio (retries esgotados)',
  lead_nao_encontrado: 'Lead não encontrado',
}

const KIND_META: Record<QueueMessage['kind'], { label: string; cls: string }> = {
  text: { label: 'Texto', cls: 'bg-sky-500/15 text-sky-300' },
  audio: { label: 'Áudio', cls: 'bg-amber-500/15 text-amber-300' },
  video: { label: 'Vídeo', cls: 'bg-rose-500/15 text-rose-300' },
  image: { label: 'Imagem', cls: 'bg-emerald-500/15 text-emerald-300' },
  document: { label: 'Doc', cls: 'bg-violet-500/15 text-violet-300' },
}

function KindBadge({ kind }: { kind: QueueMessage['kind'] }) {
  const meta = KIND_META[kind]
  return (
    <span className={`${meta.cls} px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0`}>
      {meta.label}
    </span>
  )
}
