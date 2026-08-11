import { useEffect, useMemo, useState } from 'react'
import { supabase, type Lead, type LeadStatus, type Campaign, type CaptureSession } from '../lib/supabase'
import { leadsApi, ApiRequestError } from '../lib/api'

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
  para_ligacao: 'Nº p/ ligação',
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
  para_ligacao: 'bg-cyan-400/15 text-cyan-300',
}

export function LeadsView({ leads }: { leads: Lead[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sessions, setSessions] = useState<CaptureSession[]>([])
  const [clearOpen, setClearOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [participating, setParticipating] = useState<Set<string>>(new Set())

  useEffect(() => {
    loadSessions()
    loadParticipation()
  }, [])

  // Indicador "já participou de campanha" (send_runs = participação real da
  // campanha, preservada mesmo após limpar a lista ativa).
  useEffect(() => {
    const ch = supabase
      .channel('leads-participation')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'send_runs' }, () => void loadParticipation())
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [])

  async function loadSessions() {
    const { data, error } = await supabase.from('capture_sessions').select('*').order('created_at', { ascending: false })
    if (!error && data) setSessions(data)
  }

  async function loadParticipation() {
    const { data, error } = await supabase.from('send_runs').select('lead_id')
    if (error || !data) return
    setParticipating(new Set(data.map((r) => r.lead_id)))
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

  function errMsg(e: unknown): string {
    if (e instanceof ApiRequestError) return e.detail?.message ?? e.message
    return e instanceof Error ? e.message : 'Erro inesperado.'
  }

  /** "Limpar lista ativa": marca is_active_in_prospecting=false. Preserva histórico. */
  async function doClearList() {
    if (selected.size === 0) return
    setBusy(true)
    setError('')
    try {
      await leadsApi.clearList(Array.from(selected))
      setSelected(new Set())
      setClearOpen(false)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  /** "Excluir histórico": exclusão DEFINITIVA via backend (senha validada lá). */
  async function doPermanentDelete(password: string) {
    if (selected.size === 0) return
    setBusy(true)
    setError('')
    try {
      await leadsApi.permanentDelete(Array.from(selected), password)
      setSelected(new Set())
      setDeleteOpen(false)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
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
              Prospecção ativa — empresas capturadas pela extensão. O histórico de cada campanha fica preservado no Kanban.
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
          <button
            onClick={() => setClearOpen(true)}
            disabled={selected.size === 0}
            title="Marca os selecionados como processados. O histórico, as campanhas e o Kanban continuam preservados."
            className="flex items-center gap-2 px-3 py-2 text-sm bg-amber-600/70 hover:bg-amber-500 disabled:opacity-40 rounded-lg font-medium">
            Limpar lista ({selected.size})
          </button>
          <button
            onClick={() => setDeleteOpen(true)}
            disabled={selected.size === 0}
            title="Exclusão definitiva (com senha): apaga o lead, conversas, reuniões e participações em todas as campanhas."
            className="flex items-center gap-2 px-3 py-2 text-sm bg-rose-600/70 hover:bg-rose-500 disabled:opacity-40 rounded-lg font-medium">
            Excluir histórico ({selected.size})
          </button>
        </div>

        {error && (
          <div className="text-sm text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
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
                          {participating.has(lead.id) && (
                            <div className="text-[10px] text-emerald-300/90 mt-0.5" title="Este lead já esteve/está em uma campanha">
                              ✓ Já participou de campanha
                            </div>
                          )}
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

      {clearOpen && (
        <ClearListModal
          count={selected.size}
          busy={busy}
          onClose={() => setClearOpen(false)}
          onConfirm={() => void doClearList()}
        />
      )}
      {deleteOpen && (
        <PasswordDeleteModal
          count={selected.size}
          busy={busy}
          onClose={() => setDeleteOpen(false)}
          onConfirm={(password) => void doPermanentDelete(password)}
        />
      )}

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
function ClearListModal({ count, busy, onClose, onConfirm }: {
  count: number
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#16161f] p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold">Limpar lista ativa</div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">×</button>
        </div>
        <p className="text-sm text-slate-300 mb-2">
          Remover <span className="font-semibold text-amber-300">{count} lead(s)</span> da prospecção ativa?
        </p>
        <p className="text-xs text-slate-500 mb-4 leading-relaxed">
          Isso apenas marca os leads como processados (sai da lista de trabalho).
          <span className="text-emerald-300/90"> Nada é apagado</span>: histórico, conversas, reuniões, campanhas e Kanban
          continuam preservados. Sem senha.
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-sm bg-white/5 hover:bg-white/10 rounded-lg">Cancelar</button>
          <button onClick={onConfirm} disabled={busy}
            className="px-4 py-2 text-sm bg-amber-600 hover:bg-amber-500 disabled:opacity-50 rounded-lg font-medium">
            {busy ? 'Limpando...' : 'Limpar lista'}
          </button>
        </div>
      </div>
    </div>
  )
}

function PasswordDeleteModal({ count, busy, onClose, onConfirm }: {
  count: number
  busy: boolean
  onClose: () => void
  onConfirm: (password: string) => void
}) {
  const [password, setPassword] = useState('')
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#16161f] p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-3">
          <div className="font-semibold text-rose-300">Exclusão definitiva</div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">×</button>
        </div>
        <div className="text-sm text-slate-300 mb-2">
          Excluir <span className="font-semibold text-rose-300">{count} lead(s)</span> e todo o histórico?
        </div>
        <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-2 mb-3 text-xs text-slate-400 leading-relaxed">
          Apaga <span className="text-slate-200">definitivamente</span>: conversas, reuniões, histórico de status e
          a participação destes leads em <span className="text-slate-200">todas as campanhas</span>. Ação irreversível.
        </div>
        <label className="block text-xs text-slate-400 mb-3">
          Senha da sua conta (a mesma do login)
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoFocus
            className="mt-1 w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-rose-500" />
        </label>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-sm bg-white/5 hover:bg-white/10 rounded-lg">Cancelar</button>
          <button onClick={() => onConfirm(password)} disabled={busy || !password.trim()}
            className="px-4 py-2 text-sm bg-rose-600 hover:bg-rose-500 disabled:opacity-50 rounded-lg font-medium">
            {busy ? 'Excluindo...' : 'Excluir definitivamente'}
          </button>
        </div>
      </div>
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