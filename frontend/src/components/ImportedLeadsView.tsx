import { useEffect, useMemo, useState } from 'react'
import { supabase, type Campaign, type Lead, type WhatsAppConnection } from '../lib/supabase'

function extractDdd(phone?: string | null): string {
  const digits = (phone ?? '').replace(/\D/g, '')
  if (digits.length >= 12) return digits.slice(2, 4)
  if (digits.length >= 10) return digits.slice(0, 2)
  return ''
}

export function ImportedLeadsView({
  leads,
  campaigns,
  onChanged,
}: {
  leads: Lead[]
  campaigns: Campaign[]
  onChanged: () => Promise<void>
}) {
  const imported = useMemo(
    () => leads.filter((lead) => lead.import_state === 'imported')
      .sort((a, b) => (b.imported_at ?? '').localeCompare(a.imported_at ?? '')),
    [leads],
  )
  const blocked = useMemo(() => leads.filter((lead) => lead.import_state === 'blocked'), [leads])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [campaignId, setCampaignId] = useState('')
  const [newCampaign, setNewCampaign] = useState('')
  const [connectionIds, setConnectionIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [connections, setConnections] = useState<WhatsAppConnection[]>([])
  const [dddFilter, setDddFilter] = useState('')
  // Leads que JÁ participaram de alguma campanha (send_runs). "Selecionar
  // novos" seleciona apenas os que NUNCA foram distribuídos.
  const [distributedIds, setDistributedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    supabase.from('whatsapp_connections').select('*').order('created_at').then(({ data }) => {
      if (data) setConnections(data as WhatsAppConnection[])
    })
  }, [])

  const dddAvailable = useMemo(() => {
    const counts = new Map<string, number>()
    for (const lead of imported) {
      const ddd = extractDdd(lead.phone)
      if (ddd) counts.set(ddd, (counts.get(ddd) ?? 0) + 1)
    }
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [imported])

  const filteredLeads = useMemo(() => {
    if (!dddFilter) return imported
    return imported.filter((lead) => extractDdd(lead.phone) === dddFilter)
  }, [imported, dddFilter])

  const selectAll = () => {
    setSelected(new Set(filteredLeads.map((lead) => lead.id)))
  }

  const selectNew = () => {
    setSelected(
      new Set(
        filteredLeads
          .filter((lead) => !distributedIds.has(lead.id))
          .map((lead) => lead.id),
      ),
    )
  }

  useEffect(() => {
    let active = true
    const ids = imported.map((l) => l.id)
    if (ids.length === 0) {
      setDistributedIds(new Set())
      return
    }
    ;(async () => {
      try {
        const { data } = await supabase
          .from('send_runs')
          .select('lead_id')
          .in('lead_id', ids)
        if (!active) return
        const s = new Set<string>()
        for (const r of (data as Array<{ lead_id: string }> | null) ?? []) {
          if (r.lead_id) s.add(r.lead_id)
        }
        setDistributedIds(s)
      } catch {
        // best-effort: sem o índice, "novos" vira "todos"
      }
    })()
    return () => {
      active = false
    }
  }, [imported])

  function toggleLead(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleConnection(id: string) {
    setConnectionIds((current) => current.includes(id) ? current.filter((x) => x !== id) : [...current, id])
  }

  async function distribute() {
    if (selected.size === 0) return setError('Selecione ao menos um lead.')
    setBusy(true)
    setError('')
    setNotice('')
    try {
      let target = campaignId
      if (!target && newCampaign.trim()) {
        const { data: userData } = await supabase.auth.getUser()
        const { data, error: createError } = await supabase
          .from('campaigns')
          .insert({ name: newCampaign.trim(), owner_user_id: userData.user?.id ?? null, connection_ids: connectionIds })
          .select('id')
          .single()
        if (createError || !data) throw new Error(createError?.message ?? 'Não foi possível criar a campanha.')
        target = data.id
      }
      if (!target) return setError('Selecione uma campanha ou informe o nome de uma nova.')
      const { data, error: rpcError } = await supabase.rpc('consecom_distribute_imported_leads', {
        p_lead_ids: Array.from(selected),
        p_campaign_id: target,
        p_connection_ids: connectionIds,
      })
      if (rpcError) throw new Error(rpcError.message)
      const result = data as { accepted?: number; blocked?: number }
      setNotice(`${result.accepted ?? 0} lead(s) distribuído(s). ${result.blocked ?? 0} bloqueado(s) pela regra de 6 meses.`)
      setSelected(new Set())
      setCampaignId('')
      setNewCampaign('')
      setDddFilter('')
      await onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao distribuir leads.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-line space-y-3">
        <div>
          <h1 className="text-lg font-semibold">Importados</h1>
          <p className="text-sm text-muted">Leads recém-chegados da extensão. Distribua-os para uma campanha.</p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <select value={campaignId} onChange={(e) => { setCampaignId(e.target.value); setNewCampaign('') }} className="bg-field border border-line-2 rounded-lg px-3 py-2 text-sm">
            <option value="">Selecionar campanha...</option>
            {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
          </select>
          <input value={newCampaign} onChange={(e) => { setNewCampaign(e.target.value); setCampaignId('') }} placeholder="ou criar nova campanha" className="bg-field border border-line-2 rounded-lg px-3 py-2 text-sm" />
          <button onClick={() => void distribute()} disabled={busy || selected.size === 0} className="px-4 py-2 rounded-lg bg-accent-600 text-white hover:bg-accent-500 disabled:opacity-40 text-sm font-medium">
            {busy ? 'Distribuindo...' : `Adicionar à campanha (${selected.size})`}
          </button>
        </div>
        <div className="flex flex-wrap gap-2 items-center text-xs text-muted">
          <span>Conexões round-robin:</span>
          {connections.filter((c) => c.status === 'connected').map((connection) => (
            <label key={connection.id} className="flex items-center gap-1 px-2 py-1 rounded border border-line-2">
              <input type="checkbox" checked={connectionIds.includes(connection.id)} onChange={() => toggleConnection(connection.id)} />
              {connection.display_name ?? connection.whatsapp_name ?? connection.phone_number ?? connection.instance_name}
            </label>
          ))}
          {connections.filter((c) => c.status === 'connected').length === 0 && <span>Nenhuma conexão conectada selecionada.</span>}
        </div>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        {notice && <p className="text-sm text-emerald-400">{notice}</p>}
      </div>
      <div className="px-6 py-3 border-b border-line flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted">Filtrar por DDD:</span>
        <input
          inputMode="numeric"
          maxLength={2}
          value={dddFilter}
          onChange={(e) => setDddFilter(e.target.value.replace(/\D/g, '').slice(0, 2))}
          placeholder="Ex.: 11"
          className="w-20 bg-field border border-line-2 rounded-lg px-2 py-1.5 text-sm text-center"
        />
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => setDddFilter('')} className={`px-2.5 py-1 rounded-full text-xs border transition ${!dddFilter ? 'border-accent-400 text-accent-300 bg-accent-400/10' : 'border-line-2 text-muted hover:border-line'}`}>Todos</button>
          {dddAvailable.map(([ddd, count]) => (
            <button key={ddd} type="button" onClick={() => setDddFilter(ddd)} className={`px-2.5 py-1 rounded-full text-xs border transition ${dddFilter === ddd ? 'border-accent-400 text-accent-300 bg-accent-400/10' : 'border-line-2 text-muted hover:border-line'}`}>{ddd} <span className="opacity-70">({count})</span></button>
          ))}
        </div>
        {dddFilter && <button type="button" onClick={() => setDddFilter('')} className="text-xs text-muted hover:text-fg">Limpar</button>}
      </div>
      <div className="flex-1 overflow-auto px-6 py-5">
        {filteredLeads.length === 0 ? <p className="text-sm text-faint">{imported.length === 0 ? 'Nenhum lead importado pendente.' : 'Nenhum lead encontrado para o DDD selecionado.'}</p> : (
          <div className="rounded-xl border border-line overflow-hidden">
            <div className="px-4 py-3 border-b border-line text-sm font-medium flex items-center justify-between">
              <span>{filteredLeads.length} lead(s) encontrado(s){dddFilter ? ` · DDD ${dddFilter}` : ` de ${imported.length} importado(s)`}</span>
              <span className="flex items-center gap-2">
                <button type="button" onClick={selectNew} disabled={filteredLeads.length === 0} className="text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-40 disabled:cursor-not-allowed" title="Selecionar apenas leads que nunca foram distribuídos para uma campanha">
                  Selecionar novos ({filteredLeads.filter((l) => !distributedIds.has(l.id)).length})
                </button>
                <button type="button" onClick={selectAll} disabled={filteredLeads.length === 0} className="text-xs text-accent-400 hover:text-accent-300 disabled:opacity-40 disabled:cursor-not-allowed">Selecionar todos ({filteredLeads.length})</button>
                {selected.size > 0 && <button type="button" onClick={() => setSelected(new Set())} className="text-xs text-muted hover:text-faint">Limpar</button>}
              </span>
            </div>
            {filteredLeads.map((lead) => (
              <label key={lead.id} className="flex items-center gap-3 px-4 py-3 border-b border-line last:border-0 hover:bg-subtle cursor-pointer">
                <input type="checkbox" checked={selected.has(lead.id)} onChange={() => toggleLead(lead.id)} className="accent-emerald-600" />
                <span className="flex-1 min-w-0"><span className="block text-sm truncate">{lead.name ?? 'Sem nome'}</span><span className="block text-xs text-faint">{lead.phone ?? 'Sem telefone'} · {lead.city ?? ''}</span></span>
                <span className="text-xs text-muted">{lead.source_detail ?? 'Extensão'}</span>
              </label>
            ))}
          </div>
        )}
        {blocked.length > 0 && <p className="mt-5 text-xs text-amber-400">{blocked.length} lead(s) bloqueado(s): já prospectados nos últimos 6 meses.</p>}
      </div>
    </div>
  )
}