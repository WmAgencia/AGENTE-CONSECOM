import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { supabase, type Campaign, type QueueMessage, type Lead, type SendRun, type WhatsAppConnection } from '../lib/supabase'
import { SequenceEditor } from './SequenceEditor'

export function CampaignsView({ leads }: { leads: Lead[] }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [messagesByCampaign, setMessagesByCampaign] = useState<Record<string, QueueMessage[]>>({})
  const [runs, setRuns] = useState<SendRun[]>([])
  const [enqueueOpen, setEnqueueOpen] = useState<Campaign | null>(null)
  const [connections, setConnections] = useState<WhatsAppConnection[]>([])

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

  async function setCampaignInstance(c: Campaign, instanceName: string | null) {
    const { error } = await supabase
      .from('campaigns')
      .update({ whatsapp_instance: instanceName })
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
    const rows = leads.map((lead) => ({
      campaign_id: c.id,
      lead_id: lead.id,
      status: 'pending',
      current_position: 0,
      next_send_at: new Date().toISOString(),
    }))
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

  async function finishCampaign(c: Campaign) {
    const { error } = await supabase.from('campaigns').update({ status: 'finalizada', finished_at: new Date().toISOString() }).eq('id', c.id)
    if (!error) await load()
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

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Campanhas &amp; fila de envio</h1>
          <p className="text-sm text-slate-400">
            Monte a sequência, enfileire leads e acompanhe o envio (WhatsApp)
          </p>
        </div>
        <button onClick={load}
          className="px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 rounded-lg transition">
          Atualizar
        </button>
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
                onEnqueue={() => setEnqueueOpen(c)}
                onAutoEnqueue={() => void autoEnqueue(c)}
                onFire={() => void fireCampaign(c)}
                onFinish={() => void finishCampaign(c)}
                onDelete={() => void deleteCampaign(c)}
              />
            ))}
            {campaigns.length === 0 && (
              <p className="col-span-full text-sm text-slate-500">
                Nenhuma campanha criada ainda.
              </p>
            )}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              Fila de envio ({runs.filter((r) => r.status !== 'done').length} ativos)
            </h2>
          </div>
          <RunsTable runs={runs} onRemove={removeRun} />
        </section>
      </div>

      {enqueueOpen && (
        <EnqueueModal
          campaign={enqueueOpen}
          leads={leads}
          onClose={() => setEnqueueOpen(null)}
          onEnrolled={() => {
            setEnqueueOpen(null)
            void loadRuns()
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
            className="flex-1 max-w-xs bg-black/30 border border-white/10 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-indigo-500"
          />
          <button type="submit"
            className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 rounded-lg transition">
            Criar
          </button>
          <button type="button" onClick={() => setOpen(false)}
            className="px-3 py-1.5 text-sm bg-white/5 hover:bg-white/10 rounded-lg">
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
  onEnqueue,
  onAutoEnqueue,
  onFire,
  onFinish,
  onDelete,
}: {
  campaign: Campaign
  messages: QueueMessage[]
  connections: WhatsAppConnection[]
  onChanged: () => void
  onSetInstance: (instanceName: string | null) => void
  onEnqueue: () => void
  onAutoEnqueue: () => void
  onFire: () => void
  onFinish: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  const activeConnections = connections.filter((c) => c.status === 'connected')
  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-medium">{campaign.name}</div>
          <div className="text-[11px] text-slate-400">
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
            className="text-[11px] px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10"
          >
            {open ? 'Fechar' : 'Montar sequência'}
          </button>
          <button
            onClick={onDelete}
            title="Excluir campanha"
            className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/5 text-slate-300">{campaign.lead_count} leads</span>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300">{campaign.success_count} sucessos</span>
        <span className="text-[11px] px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300">{campaign.fail_count} falhas</span>
      </div>

      <div className="flex items-center gap-2 mb-3">
        <label className="text-[11px] text-slate-400 shrink-0">
          Enviar por WhatsApp:
        </label>
        <select
          value={campaign.whatsapp_instance ?? ''}
          onChange={(e) => onSetInstance(e.target.value || null)}
          disabled={activeConnections.length === 0}
          className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded-lg px-2 py-1 text-xs text-slate-200 outline-none focus:border-indigo-500"
        >
          <option value="">Padrão (configuração do backend)</option>
          {activeConnections.map((c) => (
            <option key={c.id} value={c.instance_name}>
              {c.whatsapp_name ?? c.phone_number ?? c.instance_name}
            </option>
          ))}
        </select>
        {activeConnections.length === 0 && (
          <span className="text-[11px] text-amber-400/80 shrink-0">
            Nenhum WhatsApp conectado
          </span>
        )}
      </div>

      {campaign.status === 'pronta' && (
        <button onClick={onFire} className="w-full mb-3 text-sm py-2 bg-emerald-600/80 hover:bg-emerald-500 rounded-lg font-medium">
          ▶ Disparar campanha
        </button>
      )}
      {campaign.status === 'em_progresso' && (
        <button onClick={onFinish} className="w-full mb-3 text-xs py-2 bg-amber-600/70 hover:bg-amber-500 rounded-lg font-medium">
          Encerrar manualmente
        </button>
      )}

      {!open ? (
        <ol className="space-y-1.5">
          {messages.map((m, i) => (
            <li key={m.id} className="text-xs flex items-center gap-2 text-slate-300">
              <span className="w-5 h-5 shrink-0 rounded-full bg-white/5 flex items-center justify-center text-[10px] text-slate-400">
                {i + 1}
              </span>
              <KindBadge kind={m.kind} />
              <span className="truncate flex-1">{m.text || (m.media_url ? 'Mídia' : '...')}</span>
              {m.delay_seconds > 0 && (
                <span className="text-[10px] text-slate-500 shrink-0">+{m.delay_seconds}s</span>
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
  onClose,
  onEnrolled,
}: {
  campaign: Campaign
  leads: Lead[]
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
    const rows = Array.from(selected).map((lead_id) => ({
      campaign_id: campaign.id,
      lead_id,
      status: 'pending',
      current_position: 0,
      next_send_at: new Date().toISOString(),
    }))
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
      <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-[#16161f] p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="font-semibold">Enfileirar leads</div>
            <div className="text-xs text-slate-400">Campanha: {campaign.name}</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">
            ×
          </button>
        </div>

        <div className="max-h-72 overflow-y-auto space-y-1.5 mb-4">
          {leads.length === 0 && (
            <p className="text-sm text-slate-500">Nenhum lead cadastrado ainda.</p>
          )}
          {leads.map((lead) => (
            <label
              key={lead.id}
              className="flex items-center gap-3 rounded-lg border border-white/5 px-3 py-2 cursor-pointer hover:bg-white/5"
            >
              <input
                type="checkbox"
                checked={selected.has(lead.id)}
                onChange={() => toggle(lead.id)}
                className="accent-indigo-500"
              />
              <span className="flex-1 min-w-0">
                <span className="block text-sm truncate">{lead.name || 'Sem nome'}</span>
                {lead.phone && <span className="block text-[11px] text-slate-500">{lead.phone}</span>}
              </span>
              <span className="text-[10px] text-slate-500 shrink-0">{lead.status}</span>
            </label>
          ))}
        </div>

        {error && <p className="text-sm text-rose-400 mb-2">{error}</p>}

        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-400">{selected.size} selecionado(s)</span>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-3 py-2 text-sm bg-white/5 hover:bg-white/10 rounded-lg">
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

const CAMPAIGN_STATUS: Record<Campaign['status'], { label: string; cls: string }> = {
  pronta: { label: 'Pronta', cls: 'bg-white/5 text-slate-300' },
  em_progresso: { label: 'Em progresso', cls: 'bg-amber-500/15 text-amber-300' },
  finalizada: { label: 'Finalizada', cls: 'bg-emerald-500/15 text-emerald-300' },
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

const RUN_STATUS: Record<SendRun['status'], { label: string; cls: string }> = {
  pending: { label: 'Pendente', cls: 'bg-slate-500/15 text-slate-300' },
  running: { label: 'Rodando', cls: 'bg-amber-500/15 text-amber-300' },
  done: { label: 'Concluído', cls: 'bg-emerald-500/15 text-emerald-300' },
  failed: { label: 'Falhou', cls: 'bg-rose-500/15 text-rose-300' },
}

const FAIL_REASON_LABEL: Record<string, string> = {
  telefone_fixo: 'Número fixo → Nº p/ ligação',
  numero_invalido: 'Número inválido → Nº p/ ligação',
  sem_telefone: 'Lead sem telefone',
}

function RunsTable({ runs, onRemove }: { runs: SendRun[]; onRemove: (r: SendRun) => void }) {
  if (runs.length === 0) {
    return (
      <p className="text-sm text-slate-500 border border-dashed border-white/10 rounded-lg px-4 py-6 text-center">
        Nenhuma execução de envio ainda. Enfileire leads em uma campanha para começar.
      </p>
    )
  }
  return (
    <div className="rounded-xl border border-white/5 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-white/5">
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
              <tr key={r.id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
                <td className="px-4 py-2.5">
                  <div className="font-medium truncate max-w-[200px]">{r.lead?.name ?? '—'}</div>
                  {r.lead?.phone && <div className="text-[11px] text-slate-500">{r.lead.phone}</div>}
                </td>
                <td className="px-4 py-2.5 text-slate-300">{r.campaign?.name ?? '—'}</td>
                <td className="px-4 py-2.5 text-slate-400">#{(r.current_position ?? 0) + 1}</td>
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
                <td className="px-4 py-2.5 text-slate-500">
                  {r.next_send_at ? new Date(r.next_send_at).toLocaleString('pt-BR') : '—'}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {r.status !== 'done' && (
                    <button
                      onClick={() => onRemove(r)}
                      title="Desenfileirar"
                      className="text-slate-500 hover:text-rose-400 text-lg leading-none"
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