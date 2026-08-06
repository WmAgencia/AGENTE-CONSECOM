import { useEffect, useState } from 'react'
import { supabase, type Lead, type LeadStatus, type Campaign } from '../lib/supabase'

const STATUS_LABEL: Record<LeadStatus, string> = {
  novo: 'Novo',
  na_fila: 'Na fila',
  mensagem_enviada: 'Mensagem enviada',
  respondendo: 'Respondendo',
  reuniao_marcada: 'Reunião marcada',
  fechado: 'Fechado',
  perdido: 'Perdido',
}

export function LeadsView({ leads }: { leads: Lead[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [campaignId, setCampaignId] = useState('')
  const [dispatching, setDispatching] = useState(false)
  const [notice, setNotice] = useState<string>('')

  useEffect(() => {
    loadCampaigns()
  }, [])

  async function loadCampaigns() {
    const { data, error } = await supabase.from('campaigns').select('*')
    if (!error && data) {
      setCampaigns(data)
      if (!campaignId && data.length > 0) setCampaignId(data[0].id)
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function dispatch() {
    setNotice('')
    if (selected.size === 0) {
      setNotice('Selecione ao menos um lead.')
      return
    }
    if (!campaignId) {
      setNotice('Crie uma campanha de mensagens antes de disparar.')
      return
    }
    setDispatching(true)
    const rows = Array.from(selected).map((leadId) => ({
      campaign_id: campaignId,
      lead_id: leadId,
      status: 'pending',
      current_position: 0,
    }))
    const { error } = await supabase.from('send_runs').upsert(rows, {
      onConflict: 'campaign_id,lead_id',
      ignoreDuplicates: false,
    })
    setDispatching(false)
    if (error) {
      setNotice(`Erro ao iniciar o disparo: ${error.message}`)
      return
    }
    await supabase
      .from('leads')
      .update({ status: 'na_fila', updated_at: new Date().toISOString() })
      .in('id', Array.from(selected))
    setSelected(new Set())
    setNotice(`Disparo iniciado para ${rows.length} lead(s).`)
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-white/5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Leads</h1>
            <p className="text-sm text-slate-400">
              Empresas capturadas pela extensão ({leads.length})
            </p>
          </div>
          {selected.size > 0 && (
            <span className="text-xs text-indigo-300 bg-indigo-600/15 px-2.5 py-1 rounded-full">
              {selected.size} selecionado(s)
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-400">
            Campanha de mensagens
            <select
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              className="block mt-1 w-56 bg-black/30 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-white outline-none focus:border-indigo-500"
            >
              {campaigns.length === 0 && <option value="">Nenhuma campanha</option>}
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => dispatch()}
            disabled={dispatching}
            className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg font-medium"
          >
            {dispatching ? 'Iniciando...' : `Iniciar disparo (${selected.size})`}
          </button>
          {selected.size > 0 && (
            <button
              onClick={() => setSelected(new Set())}
              className="px-3 py-2 text-sm bg-white/5 hover:bg-white/10 rounded-lg"
            >
              Limpar seleção
            </button>
          )}
          {notice && <span className="text-xs text-rose-300">{notice}</span>}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="pb-3 pr-4">
                <input
                  type="checkbox"
                  onChange={(e) => {
                    if (e.target.checked) setSelected(new Set(leads.map((l) => l.id)))
                    else setSelected(new Set())
                  }}
                  checked={selected.size === leads.length && leads.length > 0}
                  className="accent-indigo-500"
                />
              </th>
              <th className="pb-3 pr-4">Empresa</th>
              <th className="pb-3 pr-4">Categoria</th>
              <th className="pb-3 pr-4">Cidade</th>
              <th className="pb-3 pr-4">Telefone</th>
              <th className="pb-3 pr-4">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {leads.map((lead) => (
              <tr key={lead.id} className="hover:bg-white/[0.02]">
                <td className="py-3 pr-4">
                  <input
                    type="checkbox"
                    checked={selected.has(lead.id)}
                    onChange={() => toggle(lead.id)}
                    className="accent-indigo-500"
                  />
                </td>
                <td className="py-3 pr-4">
                  <div className="font-medium">{lead.name || '—'}</div>
                  {lead.niche && (
                    <div className="text-[11px] text-indigo-300/80">{lead.niche}</div>
                  )}
                </td>
                <td className="py-3 pr-4 text-slate-400">{lead.category || '—'}</td>
                <td className="py-3 pr-4 text-slate-400">
                  {lead.city ? `${lead.city}${lead.state ? ', ' + lead.state : ''}` : '—'}
                </td>
                <td className="py-3 pr-4 text-slate-400">{lead.phone || '—'}</td>
                <td className="py-3 pr-4">
                  <span className="inline-block text-[11px] px-2 py-1 rounded-full bg-white/5 text-slate-300">
                    {STATUS_LABEL[lead.status]}
                  </span>
                </td>
              </tr>
            ))}
            {leads.length === 0 && (
              <tr>
                <td colSpan={6} className="py-10 text-center text-slate-500">
                  Nenhum lead ainda. Use a extensão para capturar empresas.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}