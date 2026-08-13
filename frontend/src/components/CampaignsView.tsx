import { useEffect, useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { supabase, type Campaign, type QueueMessage, type Lead, type SendRun, type WhatsAppConnection } from '../lib/supabase'
import { SequenceEditor } from './SequenceEditor'
import { campaignSchedule, type CampaignCalendarItem, type CampaignScheduleConfig } from '../lib/campaigns'
import { buildMonthCells, monthTitle, addMonths, DAY_SHORT, saLocalDay, saLocalTime, humanDateTime } from '../lib/month'
import { subscribeConnectionAlerts } from '../lib/connectionAlerts'

export function CampaignsView({ leads }: { leads: Lead[] }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [messagesByCampaign, setMessagesByCampaign] = useState<Record<string, QueueMessage[]>>({})
  const [runs, setRuns] = useState<SendRun[]>([])
  const [enqueueOpen, setEnqueueOpen] = useState<Campaign | null>(null)
  const [connections, setConnections] = useState<WhatsAppConnection[]>([])
  const [scheduleFor, setScheduleFor] = useState<Campaign | null>(null)
  const [schedulePicker, setSchedulePicker] = useState(false)
  const [scheduleConfig, setScheduleConfig] = useState<CampaignScheduleConfig | null>(null)
  const [calAnchor, setCalAnchor] = useState(() => {
    const d = new Date(Date.now() - 3 * 3600_000)
    return { year: d.getUTCFullYear(), month0: d.getUTCMonth() }
  })
  const [calItems, setCalItems] = useState<CampaignCalendarItem[]>([])

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
    const { data, error } = await supabase.from('campaigns').select('*').order('created_at')
    if (error || !data) return
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

  async function setCampaignInstance(c: Campaign, instanceName: string | null) {
    const { error } = await supabase
      .from('campaigns')
      .update({ whatsapp_instance: instanceName })
      .eq('id', c.id)
    if (!error) await load()
  }

  async function setCampaignConnections(c: Campaign, ids: string[]) {
    const { error } = await supabase
      .from('campaigns')
      .update({ connection_ids: ids })
      .eq('id', c.id)
    if (!error) await load()
  }

async function loadRuns() {
    const { data, error } = await supabase
      .from('send_runs')
      .select('*, campaign:campaigns(name), lead:leads(id,name,phone,status)')
      .order('created_at', { ascending: false })
      .limit(200)
    if (!error && data) setRuns(data)
  }

  async function removeRun(r: SendRun) {
    if (!window.confirm(`Desenfileirar "${r.lead?.name ?? 'este lead'}" da campanha "${r.campaign?.name ?? ''}"?`)) return
    const { error } = await supabase.from('send_runs').delete().eq('id', r.id)
    if (!error) setRuns((rs) => rs.filter((x) => x.id !== r.id))
  }

  /** Enfileira TODOS os leads de uma vez (fluxo atual de send_runs, sem modal). */
  async function autoEnqueue(c: Campaign) {
    if (leads.length === 0) {
      window.alert('Nenhum lead cadastrado para enfileirar.')
      return
    }
    if (!window.confirm(`Enfileirar todos os ${leads.length} leads na campanha "${c.name}"?`)) return
    const selectedConnections = c.connection_ids ?? []
    const rows = leads.map((lead, index) => {
      const connectionId = selectedConnections.length > 0 ? selectedConnections[index % selectedConnections.length] : null
      return {
        campaign_id: c.id,
        lead_id: lead.id,
        status: 'pending',
        current_position: 0,
        next_send_at: new Date().toISOString(),
        connection_id: connectionId,
        connection_instance: connections.find((connection) => connection.id === connectionId)?.instance_name ?? null,
      }
    })
    const { error } = await supabase.from('send_runs').upsert(rows, {
      onConflict: 'campaign_id,lead_id',
      ignoreDuplicates: true,
    })
    if (error) {
      window.alert(`Não foi possível enfileirar: ${error.message}`)
      return
    }
    await load()
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
    const active = runs.filter((r) => r.campaign_id === c.id && r.status !== 'done').length
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
          <h1 className="text-lg font-semibold">Campanhas &amp; fila de envio</h1>
          <p className="text-sm text-muted">
            Monte a sequência, enfileire leads e acompanhe o envio (WhatsApp)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSchedulePicker(true)}
            className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 rounded-lg transition"
          >
            📅 Agendar campanha
          </button>
          <button onClick={load}
            className="px-3 py-1.5 text-xs bg-subtle hover:bg-subtle-2 rounded-lg transition">
            Atualizar
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5 space-y-8">
        <section>
          <CampaignButton onCreated={load} />
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3 mt-5">
            {campaigns.map((c) => (
              <CampaignCard
                key={c.id}
                campaign={c}
                messages={messagesByCampaign[c.id] ?? []}
                connections={connections}
                onChanged={load}
                onSetInstance={(n) => void setCampaignInstance(c, n)}
                onSetConnections={(ids) => void setCampaignConnections(c, ids)}
                onEnqueue={() => setEnqueueOpen(c)}
                onAutoEnqueue={() => void autoEnqueue(c)}
                onFire={() => void fireCampaign(c)}
                onPause={() => void pauseCampaign(c)}
                onResume={() => void resumeCampaign(c)}
                onSchedule={() => setScheduleFor(c)}
                onCancelSchedule={() => void cancelScheduleCampaign(c)}
                onDelete={() => void deleteCampaign(c)}
              />
            ))}
            {campaigns.length === 0 && (
              <p className="col-span-full text-sm text-faint">
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
                className="p-1.5 rounded-lg border border-line-2 hover:bg-subtle text-secondary text-xs"
              >
                ←
              </button>
              <span className="px-2 py-1 text-xs text-secondary border border-line-2 rounded-lg min-w-28 text-center">
                {monthTitle(calAnchor.year, calAnchor.month0)}
              </span>
              <button
                onClick={() => setCalAnchor((a) => addMonths(a.year, a.month0, 1))}
                className="p-1.5 rounded-lg border border-line-2 hover:bg-subtle text-secondary text-xs"
              >
                →
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-px bg-line-2 rounded-lg overflow-hidden border border-line-2">
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
                  <div className={`text-[11px] px-1 ${cell.inMonth ? 'text-fg' : 'text-faint'}`}>{cell.day}</div>
                  <div className="mt-0.5 space-y-0.5">
                    {dayItems.slice(0, 2).map((it) => (
                      <div
                        key={it.campaignId}
                        title={`${it.name} · ${humanDateTime(Date.parse(it.startIso))} até ${humanDateTime(Date.parse(it.endIso))}`}
                        className={`truncate rounded px-1 py-0.5 text-[9px] leading-tight ${
                          it.status === 'em_progresso'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : it.status === 'pausada'
                              ? 'bg-amber-500/20 text-amber-300'
                              : 'bg-indigo-500/20 text-indigo-300'
                        }`}
                      >
                        {saLocalTime(Date.parse(it.startIso))} {it.name}
                      </div>
                    ))}
                    {dayItems.length > 2 && (
                      <div className="px-1 text-[9px] text-faint">+{dayItems.length - 2}</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          {scheduleConfig && (
            <p className="text-[11px] text-faint mt-2">
              Intervalo mínimo entre campanhas: {scheduleConfig.interval_min} min. A campanha seguinte
              só pode começar depois do fim + intervalo da anterior.
            </p>
          )}
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Fila de envio ({runs.filter((r) => r.status === 'pending' || r.status === 'running').length} ativos)
            </h2>
          </div>
          <RunsTable runs={runs} onRemove={removeRun} />
        </section>
      </div>

      {enqueueOpen && (
        <EnqueueModal
          campaign={enqueueOpen}
          leads={leads}
          connections={connections}
          onClose={() => setEnqueueOpen(null)}
          onEnrolled={() => {
            setEnqueueOpen(null)
            void loadRuns()
          }}
        />
      )}

      {scheduleFor && (
        <ScheduleModal
          initial={scheduleFor}
          campaigns={campaigns}
          config={scheduleConfig}
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
            className="flex-1 max-w-xs bg-field border border-line-2 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
          />
          <button type="submit"
            className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg transition">
            Criar
          </button>
          <button type="button" onClick={() => setOpen(false)}
            className="px-3 py-1.5 text-sm bg-subtle hover:bg-subtle-2 rounded-lg">
            Cancelar
          </button>
        </form>
      ) : (
        <button onClick={() => setOpen(true)}
          className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg transition font-medium">
          + Nova campanha
        </button>
      )}
    </div>
  )
}

function CampaignCard({
  campaign,
  messages,
  connections,
  onChanged,
  onSetInstance,
  onSetConnections,
  onEnqueue,
  onAutoEnqueue,
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
  onChanged: () => void
  onSetInstance: (instanceName: string | null) => void
  onSetConnections: (ids: string[]) => void
  onEnqueue: () => void
  onAutoEnqueue: () => void
  onFire: () => void
  onPause: () => void
  onResume: () => void
  onSchedule: () => void
  onCancelSchedule: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const activeConnections = connections.filter((c) => c.status === 'connected')
  return (
    <div className="rounded-xl border border-line bg-subtle p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-medium">{campaign.name}</div>
          <div className="text-[11px] text-muted">
            {messages.length} mensagens na sequência
          </div>
        </div>
        <div className="flex items-center gap-2">
          <CampaignStatusBadge status={campaign.status} />
          <button
            onClick={onEnqueue}
            className="text-[11px] px-2 py-1 rounded-lg bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30"
          >
            Enfileirar leads
          </button>
          <button
            onClick={onAutoEnqueue}
            title="Enfileirar todos os leads de uma vez"
            className="text-[11px] px-2 py-1 rounded-lg bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30"
          >
            ⚡ Enfileirar automaticamente
          </button>
          <button
            onClick={() => setOpen((o) => !o)}
            className="text-[11px] px-2 py-1 rounded-lg bg-subtle hover:bg-subtle-2"
          >
            {open ? 'Fechar' : 'Montar sequência'}
          </button>
          <button
            onClick={onDelete}
            title="Excluir campanha"
            className="p-1.5 rounded-lg text-faint hover:text-rose-400 hover:bg-rose-500/10 transition"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-subtle text-secondary">{campaign.lead_count} leads</span>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">{campaign.success_count} sucessos</span>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300">{campaign.fail_count} falhas</span>
      </div>

      <div className="mb-3 space-y-2">
        <label className="text-[11px] text-muted block">Conexões WhatsApp (round-robin por lead):</label>
        <div className="flex flex-wrap gap-2">
          {activeConnections.map((connection) => {
            const checked = (campaign.connection_ids ?? []).includes(connection.id)
            return (
              <label key={connection.id} className="flex items-center gap-1.5 rounded border border-line-2 px-2 py-1 text-[11px] text-secondary">
                <input type="checkbox" checked={checked} onChange={() => onSetConnections(checked ? (campaign.connection_ids ?? []).filter((id) => id !== connection.id) : [...(campaign.connection_ids ?? []), connection.id])} />
                {connection.whatsapp_name ?? connection.phone_number ?? connection.instance_name}
              </label>
            )
          })}
        </div>
        <select
          value={campaign.whatsapp_instance ?? ''}
          onChange={(e) => onSetInstance(e.target.value || null)}
          disabled={activeConnections.length === 0}
          className="w-full bg-field border border-line-2 rounded-lg px-2 py-1 text-xs text-fg outline-none focus:border-indigo-500"
        >
          <option value="">Fallback legado (conexão padrão)</option>
          {activeConnections.map((c) => <option key={c.id} value={c.instance_name}>{c.whatsapp_name ?? c.phone_number ?? c.instance_name}</option>)}
        </select>
        {activeConnections.length === 0 && (
          <span className="text-[11px] text-amber-400/80 shrink-0">
            Nenhum WhatsApp conectado
          </span>
        )}
      </div>

      <CampaignStatusBanner status={campaign.status} scheduledAt={campaign.scheduled_at} />

      {campaign.status === 'pronta' && (
        <div className="space-y-2 mb-3">
          <button onClick={onFire} className="w-full text-sm py-2 bg-emerald-600/80 hover:bg-emerald-500 rounded-lg font-medium">
            ▶ Iniciar campanha agora
          </button>
          <button onClick={onSchedule} className="w-full text-sm py-2 bg-indigo-600/70 hover:bg-indigo-500 rounded-lg font-medium">
            📅 Agendar início
          </button>
        </div>
      )}
      {campaign.status === 'agendada' && (
        <div className="space-y-2 mb-3">
          <button onClick={onSchedule} className="w-full text-sm py-2 bg-indigo-600/70 hover:bg-indigo-500 rounded-lg font-medium">
            📅 Reagendar início
          </button>
          <button onClick={onCancelSchedule} className="w-full text-sm py-2 bg-rose-600/60 hover:bg-rose-500 rounded-lg font-medium">
            ✕ Cancelar agendamento
          </button>
        </div>
      )}
      {campaign.status === 'em_progresso' && (
        <button onClick={onPause} className="w-full mb-3 text-sm py-2 bg-amber-600/70 hover:bg-amber-500 rounded-lg font-medium">
          ⏸ Pausar campanha
        </button>
      )}
      {campaign.status === 'pausada' && (
        <button onClick={onResume} className="w-full mb-3 text-sm py-2 bg-emerald-600/80 hover:bg-emerald-500 rounded-lg font-medium">
          ▶ Retomar campanha
        </button>
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

function EnqueueModal({
  campaign,
  leads,
  connections,
  onClose,
  onEnrolled,
}: {
  campaign: Campaign
  leads: Lead[]
  connections: WhatsAppConnection[]
  onClose: () => void
  onEnrolled: () => void
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  async function submit() {
    if (selected.size === 0) {
      setError('Selecione ao menos um lead.')
      return
    }
    setBusy(true)
    setError('')
    const selectedConnections = campaign.connection_ids ?? []
    const rows = Array.from(selected).map((lead_id, index) => {
      const connectionId = selectedConnections.length > 0 ? selectedConnections[index % selectedConnections.length] : null
      return {
        campaign_id: campaign.id,
        lead_id,
        status: 'pending',
        current_position: 0,
        next_send_at: new Date().toISOString(),
        connection_id: connectionId,
        connection_instance: connections.find((connection) => connection.id === connectionId)?.instance_name ?? null,
      }
    })
    const { error: err } = await supabase.from('send_runs').upsert(rows, {
      onConflict: 'campaign_id,lead_id',
      ignoreDuplicates: true,
    })
    setBusy(false)
    if (err) {
      setError(err.message)
      return
    }
    onEnrolled()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-line-2 bg-panel p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="font-semibold">Enfileirar leads</div>
            <div className="text-xs text-muted">Campanha: {campaign.name}</div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-fg text-xl leading-none">
            ×
          </button>
        </div>

        <div className="max-h-72 overflow-y-auto space-y-1.5 mb-4">
          {leads.length === 0 && (
            <p className="text-sm text-faint">Nenhum lead cadastrado ainda.</p>
          )}
          {leads.map((lead) => (
            <label
              key={lead.id}
              className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 cursor-pointer hover:bg-subtle"
            >
              <input
                type="checkbox"
                checked={selected.has(lead.id)}
                onChange={() => toggle(lead.id)}
                className="accent-indigo-500"
              />
              <span className="flex-1 min-w-0">
                <span className="block text-sm truncate">{lead.name || 'Sem nome'}</span>
                {lead.phone && <span className="block text-[11px] text-faint">{lead.phone}</span>}
              </span>
              <span className="text-[10px] text-faint shrink-0">{lead.status}</span>
            </label>
          ))}
        </div>

        {error && <p className="text-sm text-rose-400 mb-2">{error}</p>}

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">{selected.size} selecionado(s)</span>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-3 py-2 text-sm bg-subtle hover:bg-subtle-2 rounded-lg">
              Cancelar
            </button>
            <button onClick={() => void submit()} disabled={busy}
              className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg font-medium">
              {busy ? 'Enfileirando...' : 'Enfileirar'}
            </button>
          </div>
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
  onClose,
  onSaved,
}: {
  initial: Campaign | null
  campaigns: Campaign[]
  config: CampaignScheduleConfig | null
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
              <div className="mt-1 text-sm text-fg bg-subtle rounded-lg px-3 py-2">
                {initial.name}
              </div>
            ) : (
              <select
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                className="mt-1 w-full bg-field border border-line-2 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
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
              className="mt-1 w-full bg-field border border-line-2 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
          </label>

          {info && selected && (
            <div className="rounded-lg border border-line bg-subtle-2 px-3 py-2 text-xs text-secondary space-y-1">
              <div>
                Duração estimada da campanha:{' '}
                <span className="text-fg font-medium">{info.durationMin} min</span>
                {' '}({selected.lead_count ?? 0} leads)
              </div>
              <div>
                Próximo início livre:{' '}
                <button
                  onClick={() => setLocal(`${saLocalDay(Date.parse(info.nextAvailableStart))}T${saLocalTime(Date.parse(info.nextAvailableStart))}`)}
                  className="text-indigo-300 hover:underline"
                >
                  {humanDateTime(Date.parse(info.nextAvailableStart))}
                </button>
              </div>
              {config && (
                <div className="text-faint">
                  Intervalo mínimo entre campanhas: {config.interval_min} min
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-2 text-sm bg-subtle hover:bg-subtle-2 rounded-lg">
              Cancelar
            </button>
            <button
              onClick={() => void submit()}
              disabled={saving || !campaignId}
              className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg font-medium"
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
  agendada: { label: 'Agendada', cls: 'bg-indigo-500/15 text-indigo-300' },
  em_progresso: { label: 'Em andamento', cls: 'bg-emerald-500/15 text-emerald-300' },
  pausada: { label: 'Pausada', cls: 'bg-amber-500/15 text-amber-300' },
  finalizada: { label: 'Concluída', cls: 'bg-sky-500/15 text-sky-300' },
  cancelada: { label: 'Cancelada', cls: 'bg-rose-500/15 text-rose-300' },
}

function CampaignStatusBadge({ status }: { status: Campaign['status'] }) {
  const meta = CAMPAIGN_STATUS[status]
  return (
    <span className={`text-[11px] px-2 py-1 rounded-full ${meta.cls}`}>
      {meta.label}
    </span>
  )
}

/** Banner de status da campanha (Reflete o estado real vindo do banco). */
function CampaignStatusBanner({ status, scheduledAt }: { status: Campaign['status']; scheduledAt?: string | null }) {
  if (status === 'agendada') {
    return (
      <div className="mb-3 rounded-lg bg-indigo-500/10 border border-indigo-500/20 px-3 py-2 text-sm text-indigo-300 flex items-center gap-2">
        🕐 Campanha agendada para {scheduledAt ? humanDateTime(Date.parse(scheduledAt)) : '—'}.
        O disparo começa automaticamente no horário.
      </div>
    )
  }
  if (status === 'em_progresso') {
    return (
      <div className="mb-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-sm text-emerald-300 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        🟢 Campanha em andamento
      </div>
    )
  }
  if (status === 'pausada') {
    return (
      <div className="mb-3 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2 text-sm text-amber-300 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-amber-400" />
        🟡 Campanha pausada
      </div>
    )
  }
  if (status === 'finalizada') {
    return (
      <div className="mb-3 rounded-lg bg-sky-500/10 border border-sky-500/20 px-3 py-2 text-sm text-sky-300 flex items-center gap-2">
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

function RunsTable({ runs, onRemove }: { runs: SendRun[]; onRemove: (r: SendRun) => void }) {
  if (runs.length === 0) {
    return (
      <p className="text-sm text-faint border border-dashed border-line-2 rounded-lg px-4 py-6 text-center">
        Nenhuma execução de envio ainda. Enfileire leads em uma campanha para começar.
      </p>
    )
  }
  return (
    <div className="rounded-xl border border-line overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-faint border-b border-line">
            <th className="px-4 py-2.5 font-medium">Lead</th>
            <th className="px-4 py-2.5 font-medium">Campanha</th>
            <th className="px-4 py-2.5 font-medium">Etapa</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Próximo envio</th>
            <th className="px-4 py-2.5 font-medium text-right">Ações</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const st = RUN_STATUS[r.status]
            return (
              <tr key={r.id} className="border-b border-line last:border-0 hover:bg-subtle">
                <td className="px-4 py-2.5">
                  <div className="font-medium truncate max-w-[200px]">{r.lead?.name ?? '—'}</div>
                  {r.lead?.phone && <div className="text-[11px] text-faint">{r.lead.phone}</div>}
                </td>
                <td className="px-4 py-2.5 text-secondary">{r.campaign?.name ?? '—'}</td>
                <td className="px-4 py-2.5 text-muted">#{(r.current_position ?? 0) + 1}</td>
                <td className="px-4 py-2.5">
                  <span className={`${st.cls} px-2 py-0.5 rounded text-[11px] font-medium`}>
                    {st.label}
                  </span>
                  {r.status === 'failed' && r.fail_reason && (
                    <div className="text-[11px] text-rose-300/80 mt-1 max-w-[220px] leading-tight">
                      {FAIL_REASON_LABEL[r.fail_reason] ?? r.fail_reason}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5 text-faint">
                  {r.next_send_at ? new Date(r.next_send_at).toLocaleString('pt-BR') : '—'}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {r.status !== 'done' && (
                    <button
                      onClick={() => onRemove(r)}
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
    </div>
  )
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
