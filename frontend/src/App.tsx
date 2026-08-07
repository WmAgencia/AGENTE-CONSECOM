import { useEffect, useState } from 'react'
import { supabase, type Lead, type Campaign } from './lib/supabase'
import { LoginScreen } from './components/LoginScreen'
import { KanbanBoard } from './components/KanbanBoard'
import { CampaignsView } from './components/CampaignsView'
import { LeadsView } from './components/LeadsView'
import { DashboardView } from './components/DashboardView'
import { AgentConfig } from './components/AgentConfig'

type Tab = 'kanban' | 'leads' | 'campanhas' | 'dashboard' | 'agente'

const APP_VERSION = '2.0.0'

export default function App() {
  const [session, setSession] = useState<boolean | null>(null)
  const [tab, setTab] = useState<Tab>('kanban')
  const [leads, setLeads] = useState<Lead[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(!!data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(!!s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (session) {
      loadLeads()
      loadCampaigns()
    }
  }, [session])

  async function loadCampaigns() {
    const { data, error } = await supabase.from('campaigns').select('*').order('created_at')
    if (!error && data) setCampaigns(data)
  }

  async function loadLeads() {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false })
    if (!error && data) setLeads(data)
  }

  useEffect(() => {
    if (!session) return
    const ch = supabase
      .channel('leads')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, loadLeads)
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [session])

  async function markMeeting(id: string, meeting_at: string, notes: string) {
    const { error } = await supabase.rpc('consecom_marcar_reuniao', {
      p_lead_id: id,
      p_meeting_at: meeting_at || null,
      p_notes: notes || null,
    })
    if (!error) {
      setLeads((l) =>
        l.map((x) =>
          x.id === id
            ? { ...x, status: 'reuniao_marcada', meeting_at: meeting_at || x.meeting_at, meeting_notes: notes || x.meeting_notes }
            : x,
        ),
      )
    }
    return !error
  }

  async function closeLead(id: string, closed: boolean, motivo: string) {
    const { error } = await supabase.rpc('consecom_fechar_lead', {
      p_lead_id: id,
      p_fechado: closed,
      p_motivo: motivo || null,
    })
    if (!error) {
      setLeads((l) =>
        l.map((x) =>
          x.id === id
            ? { ...x, status: closed ? 'fechado' : 'nao_fechado', closed_reason: motivo || null, closed_at: new Date().toISOString() }
            : x,
        ),
      )
    }
    return !error
  }

  if (session === null) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-slate-400">Carregando…</div>
      </div>
    )
  }

  if (!session) {
    return <LoginScreen />
  }

  return (
    <div className="flex h-full">
      <aside className="w-64 shrink-0 bg-[#0d0d14] border-r border-white/5 flex flex-col">
        <div className="px-5 py-5 border-b border-white/5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-fuchsia-500 flex items-center justify-center text-sm font-bold">
              C
            </div>
            <div>
              <div className="font-semibold leading-none">Consecom</div>
              <div className="text-[11px] text-slate-500 mt-1">Prospecção</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {(['kanban', 'leads', 'campanhas', 'dashboard', 'agente'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
                  tab === t
                    ? 'bg-white/5 text-white'
                    : 'text-slate-400 hover:bg-white/5 hover:text-white'
                }`}
              >
                {t === 'kanban' ? 'Kanban'
                  : t === 'leads' ? 'Leads'
                  : t === 'campanhas' ? 'Campanhas'
                  : t === 'dashboard' ? 'Dashboard'
                  : 'Config do Agente'}
              </button>
            ))}
        </nav>

        <div className="px-5 py-4 border-t border-white/5 space-y-2">
          <div className="text-[11px] text-slate-500">{leads.length} leads no total</div>
          <div className="text-[11px] text-slate-500">v{APP_VERSION}</div>
          <button
            onClick={() => supabase.auth.signOut()}
            className="text-xs text-slate-400 hover:text-white transition"
          >
            Sair
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-hidden">
        {tab === 'kanban' && (
          <KanbanBoard
            leads={leads}
            campaigns={campaigns}
            onMeeting={markMeeting}
            onClose={closeLead}
          />
        )}
        {tab === 'leads' && (
          <LeadsView leads={leads} />
        )}
        {tab === 'campanhas' && <CampaignsView leads={leads} />}
        {tab === 'dashboard' && <DashboardView leads={leads} />}
        {tab === 'agente' && <AgentConfig />}
      </main>
    </div>
  )
}