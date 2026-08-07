import { useEffect, useMemo, useState } from 'react'
import { supabase, type Lead, type LeadStatus, type Campaign, type CaptureSession } from '../lib/supabase'

const STATUS_LABEL: Record<LeadStatus, string> = {
  novo: 'Novo',
  na_fila: 'Na fila',
  enviado: 'Enviado',
  conversando: 'Conversando',
  sem_interesse: 'Sem interesse',
  remarketing: 'Remarketing',
  reuniao_marcada: 'Reunião marcada',
  reuniao_cancelada: 'Reunião cancelada',
  fechado: 'Fechado',
  nao_fechado: 'Não fechado',
}

const STATUS_COLOR: Record<LeadStatus, string> = {
  novo: 'bg-slate-500/15 text-slate-300',
  na_fila: 'bg-amber-500/15 text-amber-300',
  enviado: 'bg-sky-500/15 text-sky-300',
  conversando: 'bg-violet-500/15 text-violet-300',
  sem_interesse: 'bg-rose-500/15 text-rose-300',
  remarketing: 'bg-amber-500/15 text-amber-300',
  reuniao_marcada: 'bg-emerald-500/15 text-emerald-300',
  reuniao_cancelada: 'bg-orange-500/15 text-orange-300',
  fechado: 'bg-green-500/15 text-green-300',
  nao_fechado: 'bg-rose-500/15 text-rose-300',
}

export function LeadsView({ leads }: { leads: Lead[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sessions, setSessions] = useState<CaptureSession[]>([])
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)

  useEffect(() => {
    loadSessions()
  }, [])

  async function loadSessions() {
    const { data, error } = await supabase.from('capture_sessions').select('*').order('created_at', { ascending: false })
    if (!error && data) setSessions(data)
  }

  const bySession = useMemo(() => {
    const map = new Map<string, Lead[]>()
    for (const l of leads) {
      const key = l.session_id ?? '__none__'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(l)
    }
    return Array.from(map.entries())
  }, [leads])

  const sessionDate = (id: string | null): CaptureSession | undefined =>
    sessions.find((s) => s.id === id)

  function toggle(id: string) {
    setSelected((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  function selectAll() {
    setSelected(new Set(leads.map((l) => l.id)))
  }

  async function doDelete() {
    if (selected.size === 0) return
    const ids = Array.from(selected)
    await supabase.from('lead_contacts').delete().in('lead_id', ids)
    const { error } = await supabase.from('leads').delete().in('id', ids)
    if (!error) {
      setSelected(new Set())
    }
  }

  async function handleSent() {
    setSendOpen(false)
    setSelected(new Set())
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-white/5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Leads</h1>
            <p className="text-sm text-slate-400">
              Empresas capturadas pela extensão, separadas por sessão de importação
            </p>
          </div>
          {selected.size > 0 && (
            <span className="text-xs text-indigo-300 bg-indigo-600/15 px-2.5 py-1 rounded-full">
              {selected.size} selecionado(s)
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button onClick={selectAll}
            className="px-3 py-2 text-sm bg-white/5 hover:bg-white/10 rounded-lg">
            Selecionar todos ({leads.length})
          </button>
          <button
            onClick={() => setSendOpen(true)}
            disabled={selected.size === 0}
            className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg font-medium"
          >
            Enviar ({selected.size})
          </button>
          <div className="relative">
            <button onClick={() => setDeleteOpen((v) => !v)}
              disabled={selected.size === 0}
              className="flex items-center gap-2 px-3 py-2 text-sm bg-rose-600/70 hover:bg-rose-500 disabled:opacity-40 rounded-lg font-medium">
              Excluir ({selected.size})
            </button>
            {deleteOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setDeleteOpen(false)} />
                <div className="absolute right-0 top-full mt-2 z-20 w-64 rounded-xl border border-white/10 bg-[#16161f] p-3 shadow-xl">
                  <div className="text-xs text-slate-400 mb-1">
                    Excluir <span className="text-rose-300 font-semibold">{selected.size} lead(s)</span> definitivamente?
                    <div className="text-[10px] text-slate-500 mt-1">Também remove os contatos vinculados.</div>
                  </div>
                  <button
                    onClick={() => { setDeleteOpen(false); void doDelete() }}
                    className="w-full mt-1 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg px-3 py-2">
                    Excluir selecionados
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5 space-y-8">
        {bySession.map(([sid, list]) => {
          const session = sessionDate(sid)
          const allSelected = list.every((l) => selected.has(l.id))
          return (
            <section key={sid}>
              <div className="flex items-center gap-3 mb-3">
                <h2 className="text-sm font-semibold text-slate-300">
                  {session ? new Date(session.created_at).toLocaleString('pt-BR') : 'Sem sessão'}
                </h2>
                <span className="text-xs text-slate-500 bg-white/5 rounded-full px-2 py-0.5">{list.length}</span>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => {
                      if (allSelected) setSelected((s) => { const n = new Set(s); list.forEach((l) => n.delete(l.id)); return n })
                      else setSelected((s) => { const n = new Set(s); list.forEach((l) => n.add(l.id)); return n })
                    }}
                    className="text-xs text-indigo-300 hover:underline"
                  >
                    {allSelected ? 'Desmarcar' : 'Marcar'} sessão
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-white/5 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b border-white/5">
                      <th className="px-3 py-2.5 font-medium w-8">
                        <input type="checkbox" checked={allSelected && list.length > 0}
                          onChange={() => {
                            if (allSelected) setSelected((s) => { const n = new Set(s); list.forEach((l) => n.delete(l.id)); return n })
                            else setSelected((s) => { const n = new Set(s); list.forEach((l) => n.add(l.id)); return n })
                          }}
                          className="accent-indigo-500" />
                      </th>
                      <th className="px-3 py-2.5 font-medium">Empresa</th>
                      <th className="px-3 py-2.5 font-medium">Categoria</th>
                      <th className="px-3 py-2.5 font-medium">Cidade</th>
                      <th className="px-3 py-2.5 font-medium">Telefone</th>
                      <th className="px-3 py-2.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {list.map((lead) => (
                      <tr key={lead.id} className="hover:bg-white/[0.02]">
                        <td className="px-3 py-2.5">
                          <input type="checkbox" checked={selected.has(lead.id)} onChange={() => toggle(lead.id)} className="accent-indigo-500" />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium">{lead.name || '—'}</div>
                          {lead.niche && <div className="text-[11px] text-indigo-300/80">{lead.niche}</div>}
                        </td>
                        <td className="px-3 py-2.5 text-slate-400">{lead.category || '—'}</td>
                        <td className="px-3 py-2.5 text-slate-400">{lead.city ? `${lead.city}${lead.state ? ', ' + lead.state : ''}` : '—'}</td>
                        <td className="px-3 py-2.5 text-slate-400">{lead.phone || '—'}</td>
                        <td className="px-3 py-2.5">
                          <span className={`inline-block text-[11px] px-2 py-1 rounded-full ${STATUS_COLOR[lead.status]}`}>
                            {STATUS_LABEL[lead.status]}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )
        })}

        {leads.length === 0 && (
          <p className="text-sm text-slate-500 border border-dashed border-white/10 rounded-lg px-4 py-8 text-center">
            Nenhum lead ainda. Use a extensão do Google Maps para capturar empresas.
          </p>
        )}
      </div>

      {sendOpen && (
        <SendModal
          leads={leads}
          selected={selected}
          onClose={() => setSendOpen(false)}
          onSent={handleSent}
        />
      )}
    </div>
  )
}
function SendModal({ leads, selected, onClose, onSent }: {
  leads: Lead[]
  selected: Set<string>
  onClose: () => void
  onSent: () => Promise<void>
}) {
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [newName, setNewName] = useState('')
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignId, setCampaignId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase.from('campaigns').select('*').order('created_at').then(({ data, error }) => {
      if (!error && data) {
        setCampaigns(data)
        if (data[0]) setCampaignId(data[0].id)
      }
    })
  }, [])

  const leadIds = useMemo(() => leads.filter((l) => selected.has(l.id) && l.status === 'novo').map((l) => l.id), [leads, selected])

  async function submit() {
    setError('')
    if (leadIds.length === 0) { setError('Selecione ao menos um lead no estado "Novo".'); return }
    setBusy(true)
    let targetId = campaignId
    if (mode === 'new') {
      if (!newName.trim()) { setError('Dê um nome à nova campanha.'); setBusy(false); return }
      const { data, error } = await supabase.from('campaigns').insert({ name: newName.trim() }).select('id').single()
      if (error || !data) { setError('Erro ao criar campanha: ' + (error?.message ?? '')); setBusy(false); return }
      targetId = data.id
    } else if (!targetId) {
      setError('Escolha uma campanha existente.'); setBusy(false); return
    }
    const { error } = await supabase.rpc('consecom_associar_campanha', { p_lead_ids: leadIds, p_campaign_id: targetId })
    setBusy(false)
    if (error) { setError('Erro ao enviar para a campanha: ' + error.message); return }
    await onSent()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#16161d] p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="font-semibold">Enviar leads para campanha</div>
            <div className="text-xs text-slate-400">{leadIds.length} lead(s) vou para esta campanha</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="space-y-2 mb-4">
          <div className="flex gap-2">
            <button onClick={() => setMode('new')} className={`flex-1 px-3 py-2 text-sm rounded-lg border ${mode === 'new' ? 'border-indigo-500 bg-indigo-600/20 text-white' : 'border-white/10 bg-white/5 text-slate-300'}`}>
              Nova campanha
            </button>
            <button onClick={() => setMode('existing')} className={`flex-1 px-3 py-2 text-sm rounded-lg border ${mode === 'existing' ? 'border-indigo-500 bg-indigo-600/20 text-white' : 'border-white/10 bg-white/5 text-slate-300'}`}>
              Campanha existente
            </button>
          </div>

          {mode === 'new' ? (
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nome da nova campanha"
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500" />
          ) : (
            <select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500">
              {campaigns.length === 0 && <option value="">Nenhuma campanha criada</option>}
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
        </div>

        {error && <p className="text-sm text-rose-400 mb-2">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-sm bg-white/5 hover:bg-white/10 rounded-lg">Cancelar</button>
          <button onClick={() => void submit()} disabled={busy} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg font-medium">
            {busy ? 'Enviando...' : 'Enviar para campanha'}
          </button>
        </div>
      </div>
    </div>
  )
}