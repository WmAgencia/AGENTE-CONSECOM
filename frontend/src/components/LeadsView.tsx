import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase, type Lead, type LeadStatus, type Campaign } from '../lib/supabase'

const STATUS_LABEL: Record<LeadStatus, string> = {
  novo: 'Novo',
  na_fila: 'Na fila',
  enviado: 'Enviado',
  ia: 'IA',
  necessita_humano: 'Necessita de humano',
  conversando: 'Conversando',
  sem_interesse: 'Sem interesse',
  remarketing: 'Remarketing',
  reuniao_marcada: 'Reunião marcada',
  reuniao_cancelada: 'Reunião cancelada',
  fechado: 'Fechado',
  nao_fechado: 'Não fechado',
  para_ligacao: 'Nº p/ ligação',
  responder_depois: 'Responder depois',
}

const STATUS_COLOR: Record<LeadStatus, string> = {
  novo: 'bg-slate-500/15 text-secondary',
  na_fila: 'bg-amber-500/15 text-amber-300',
  enviado: 'bg-sky-500/15 text-sky-300',
  ia: 'bg-fuchsia-500/15 text-fuchsia-300',
  necessita_humano: 'bg-red-500/15 text-red-300',
  conversando: 'bg-violet-500/15 text-violet-300',
  sem_interesse: 'bg-rose-500/15 text-rose-300',
  remarketing: 'bg-amber-500/15 text-amber-300',
  reuniao_marcada: 'bg-emerald-500/15 text-emerald-300',
  reuniao_cancelada: 'bg-orange-500/15 text-orange-300',
  fechado: 'bg-green-500/15 text-green-300',
  nao_fechado: 'bg-rose-500/15 text-rose-300',
  para_ligacao: 'bg-cyan-400/15 text-cyan-300',
  responder_depois: 'bg-cyan-500/15 text-cyan-300',
}

const COMPAIGN_NONE = '__none__'

interface RunInfo {
  status: string
  last_sent_at: string | null
  fail_reason: string | null
  connection_instance: string | null
}

const RUN_LABEL: Record<string, string> = {
  pending: 'Pendente',
  running: 'Em processamento',
  done: 'Enviado',
  failed: 'Falhou',
}

const RUN_COLOR: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-300',
  running: 'bg-sky-500/15 text-sky-300',
  done: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-rose-500/15 text-rose-300',
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return '—'
  }
}

export function LeadsView({ leads, campaigns }: { leads: Lead[]; campaigns?: Campaign[] }) {
  const [searchParams] = useSearchParams()
  const focusId = searchParams.get('focus')
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [openCampaign, setOpenCampaign] = useState<string | null>(null)
  const [runsByLead, setRunsByLead] = useState<Record<string, RunInfo>>({})

  useEffect(() => {
    if (!focusId) return
    const el = document.getElementById(`lead-row-${focusId}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlighted(focusId)
    const t = window.setTimeout(() => setHighlighted(null), 3000)
    return () => window.clearTimeout(t)
  }, [focusId])

  // Carrega status/resultado dos envios (send_runs) por lead.
  useEffect(() => {
    void loadRuns()
    const ch = supabase
      .channel('leads-history-runs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'send_runs' }, () => void loadRuns())
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [])

  async function loadRuns() {
    const { data } = await supabase
      .from('send_runs')
      .select('lead_id,status,last_sent_at,fail_reason,connection_instance')
    if (!data) return
    const map: Record<string, RunInfo> = {}
    for (const r of data as RunInfo[] & { lead_id: string }[]) {
      const existing = map[r.lead_id]
      // prioriza o run mais recente com last_sent_at, depois qualquer run.
      if (!existing || (r.last_sent_at && !existing.last_sent_at)) {
        map[r.lead_id] = {
          status: r.status,
          last_sent_at: r.last_sent_at,
          fail_reason: r.fail_reason,
          connection_instance: r.connection_instance,
        }
      }
    }
    setRunsByLead(map)
  }

  const byCampaign = useMemo(() => {
    const map = new Map<string, Lead[]>()
    for (const l of leads) {
      const key = l.campaign_id ?? COMPAIGN_NONE
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(l)
    }
    // ordena: campanhas com leads primeiro, "Sem campanha" por último
    const entries = Array.from(map.entries())
    entries.sort((a, b) => (a[0] === COMPAIGN_NONE ? 1 : b[0] === COMPAIGN_NONE ? -1 : 0))
    return entries
  }, [leads])

  const campaignName = (id: string | null): string => {
    if (!id) return 'Sem campanha'
    return campaigns?.find((c) => c.id === id)?.name ?? 'Campanha removida'
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-line">
        <div>
          <h1 className="text-lg font-semibold">Histórico de Leads</h1>
          <p className="text-sm text-muted">
            Histórico permanente de prospecções, organizado por campanha. Clique em uma campanha para ver os leads e o resultado do envio.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 py-5 space-y-3">
        {byCampaign.map(([cid, list]) => {
          const isOpen = openCampaign === cid
          const name = campaignName(cid === COMPAIGN_NONE ? null : cid)
          return (
            <section key={cid} className="rounded-xl border border-line overflow-hidden">
              <button
                onClick={() => setOpenCampaign(isOpen ? null : cid)}
                className="w-full flex items-center gap-3 px-4 py-3 bg-subtle hover:bg-subtle-2 transition text-left"
              >
                <span className={`text-xs transition-transform ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                <h2 className="text-sm font-semibold text-secondary flex-1">{name}</h2>
                <span className="text-xs text-faint bg-subtle rounded-full px-2 py-0.5">{list.length} leads</span>
              </button>

              {isOpen && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide text-faint border-b border-line bg-subtle-2/50">
                        <th className="px-3 py-2.5 font-medium">Empresa</th>
                        <th className="px-3 py-2.5 font-medium">Telefone</th>
                        <th className="px-3 py-2.5 font-medium">Cidade</th>
                        <th className="px-3 py-2.5 font-medium">Status lead</th>
                        <th className="px-3 py-2.5 font-medium">Resultado envio</th>
                        <th className="px-3 py-2.5 font-medium">Data envio</th>
                        <th className="px-3 py-2.5 font-medium">Conexão</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {list.map((lead) => {
                        const run = runsByLead[lead.id]
                        return (
                          <tr key={lead.id} id={`lead-row-${lead.id}`} className={`hover:bg-subtle ${highlighted === lead.id ? 'bg-accent-500/10' : ''}`}>
                            <td className="px-3 py-2.5">
                              <div className="font-medium">{lead.name || '—'}</div>
                              {lead.niche && <div className="text-[11px] text-accent-300/80">{lead.niche}</div>}
                            </td>
                            <td className="px-3 py-2.5 text-muted">{lead.phone || '—'}</td>
                            <td className="px-3 py-2.5 text-muted">{lead.city ? `${lead.city}${lead.state ? ', ' + lead.state : ''}` : '—'}</td>
                            <td className="px-3 py-2.5">
                              <span className={`inline-block text-[11px] px-2 py-1 rounded-full ${STATUS_COLOR[lead.status]}`}>
                                {STATUS_LABEL[lead.status]}
                              </span>
                            </td>
                            <td className="px-3 py-2.5">
                              {run ? (
                                <span className={`inline-block text-[11px] px-2 py-1 rounded-full ${RUN_COLOR[run.status] ?? 'bg-subtle text-secondary'}`}>
                                  {RUN_LABEL[run.status] ?? run.status}
                                  {run.status === 'failed' && run.fail_reason ? ` (${run.fail_reason})` : ''}
                                </span>
                              ) : (
                                <span className="text-[11px] text-faint">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-muted">{run ? fmtDate(run.last_sent_at) : '—'}</td>
                            <td className="px-3 py-2.5 text-muted text-xs">{run?.connection_instance ?? '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )
        })}

        {leads.length === 0 && (
          <p className="text-sm text-faint border border-dashed border-line-2 rounded-xl px-4 py-8 text-center">
            Nenhum lead no histórico ainda. Use a aba <span className="text-fg">Importados</span> para distribuir leads da extensão para campanhas.
          </p>
        )}
      </div>
    </div>
  )
}
