import { useEffect, useState } from 'react'
import { type LucideIcon, LayoutDashboard, SquareKanban, Megaphone, Users, Plug, Settings, Menu, Smartphone, Puzzle } from 'lucide-react'
import { supabase, type Lead, type Campaign } from './lib/supabase'
import { LoginScreen } from './components/LoginScreen'
import { KanbanBoard } from './components/KanbanBoard'
import { CampaignsView } from './components/CampaignsView'
import { LeadsView } from './components/LeadsView'
import { DashboardView } from './components/DashboardView'
import { AgentConfig } from './components/AgentConfig'
import { ConnectionsPage } from './components/ConnectionsPage'
import { MobileAppView } from './components/MobileAppView'
import { ExtensionView } from './components/ExtensionView'

type Tab = 'dashboard' | 'kanban' | 'campanhas' | 'leads' | 'conexoes' | 'agente' | 'extensao' | 'app-mobile'

const NAV_ITEMS: { key: Tab; label: string; icon: LucideIcon }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'kanban', label: 'Kanban', icon: SquareKanban },
  { key: 'campanhas', label: 'Campanhas', icon: Megaphone },
  { key: 'leads', label: 'Leads', icon: Users },
  { key: 'conexoes', label: 'Conexões', icon: Plug },
  { key: 'agente', label: 'Config. do Agente', icon: Settings },
  { key: 'extensao', label: 'Extensão', icon: Puzzle },
  { key: 'app-mobile', label: 'App mobile', icon: Smartphone },
]

const APP_VERSION = '2.0.0'

export default function App() {
  const [session, setSession] = useState<boolean | null>(null)
  const [tab, setTab] = useState<Tab>('kanban')
  const [sidebarOpen, setSidebarOpen] = useState(false)
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

  useEffect(() => {
    if (!session) return
    const ch = supabase
      .channel('campaigns')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'campaigns' }, loadCampaigns)
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

  function navigate(t: Tab) {
    setTab(t)
    setSidebarOpen(false)
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
      <div className="md:hidden fixed top-0 inset-x-0 z-40 flex items-center gap-3 h-14 px-4 bg-[#0d0d14]/95 backdrop-blur border-b border-white/5">
        <button
          onClick={() => setSidebarOpen(true)}
          className="p-2 -ml-2 rounded-lg text-slate-300 hover:bg-white/5 hover:text-white transition"
          aria-label="Abrir menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2.5">
          <img
            src="/vyntra-logo.png"
            alt="Vyntra"
            className="w-7 h-7 rounded-lg object-contain bg-white"
          />
          <div className="font-semibold text-sm leading-none">Vyntra</div>
        </div>
      </div>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 shrink-0 bg-[#0d0d14] border-r border-white/5 flex flex-col transition-transform duration-200 ease-out md:static md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="px-5 py-5 border-b border-white/5">
          <div className="flex items-center gap-2.5">
            <img
              src="/vyntra-logo.png"
              alt="Vyntra"
              className="w-8 h-8 rounded-lg object-contain bg-white"
            />
            <div>
              <div className="font-semibold leading-none">Vyntra</div>
              <div className="text-[11px] text-slate-500 mt-1">Alex · Prospecção</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = tab === item.key
            return (
              <button
                key={item.key}
                onClick={() => navigate(item.key)}
                aria-current={active ? 'page' : undefined}
                className={`relative w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors duration-150 ${
                  active
                    ? 'bg-indigo-500/15 text-white'
                    : 'text-slate-400 hover:bg-white/5 hover:text-white'
                }`}
              >
                {active && (
                  <span className="absolute -left-3 top-1/2 -translate-y-1/2 w-1 h-5 rounded-r-full bg-indigo-400" />
                )}
                <Icon
                  className={`w-[18px] h-[18px] shrink-0 ${
                    active ? 'text-indigo-300' : 'text-slate-500 group-hover:text-slate-300'
                  }`}
                />
                <span className="truncate">{item.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="px-5 py-4 border-t border-white/5 space-y-2">
          <div className="text-[11px] text-slate-500">{leads.length} leads no total</div>
          <div className="text-[11px] text-slate-500">v{APP_VERSION}</div>
          <button
            onClick={() => {
              setSidebarOpen(false)
              void supabase.auth.signOut()
            }}
            className="text-xs text-slate-400 hover:text-white transition"
          >
            Sair
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-hidden pt-14 md:pt-0">
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
        {tab === 'conexoes' && <ConnectionsPage />}
        {tab === 'extensao' && <ExtensionView />}
        {tab === 'app-mobile' && <MobileAppView />}
      </main>
    </div>
  )
}
