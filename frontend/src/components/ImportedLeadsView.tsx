import { useEffect, useMemo, useState } from 'react'
import { supabase, type Campaign, type Lead, type WhatsAppConnection } from '../lib/supabase'

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

  useEffect(() => {
    supabase.from('whatsapp_connections').select('*').order('created_at').then(({ data }) => {
      if (data) setConnections(data as WhatsAppConnection[])
    })
  }, [])

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
          <button onClick={() => void distribute()} disabled={busy || selected.size === 0} className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-sm font-medium">
            {busy ? 'Distribuindo...' : `Adicionar à campanha (${selected.size})`}
          </button>
        </div>
        <div className="flex flex-wrap gap-2 items-center text-xs text-muted">
          <span>Conexões round-robin:</span>
          {connections.filter((c) => c.status === 'connected').map((connection) => (
            <label key={connection.id} className="flex items-center gap-1 px-2 py-1 rounded border border-line-2">
              <input type="checkbox" checked={connectionIds.includes(connection.id)} onChange={() => toggleConnection(connection.id)} />
              {connection.whatsapp_name ?? connection.phone_number ?? connection.instance_name}
            </label>
          ))}
          {connections.filter((c) => c.status === 'connected').length === 0 && <span>Nenhuma conexão conectada selecionada.</span>}
        </div>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        {notice && <p className="text-sm text-emerald-400">{notice}</p>}
      </div>
      <div className="flex-1 overflow-auto px-6 py-5">
        {imported.length === 0 ? <p className="text-sm text-faint">Nenhum lead importado pendente.</p> : (
          <div className="rounded-xl border border-line overflow-hidden">
            <div className="px-4 py-3 border-b border-line text-sm font-medium">{imported.length} lead(s) importado(s)</div>
            {imported.map((lead) => (
              <label key={lead.id} className="flex items-center gap-3 px-4 py-3 border-b border-line last:border-0 hover:bg-subtle cursor-pointer">
                <input type="checkbox" checked={selected.has(lead.id)} onChange={() => toggleLead(lead.id)} className="accent-indigo-500" />
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
