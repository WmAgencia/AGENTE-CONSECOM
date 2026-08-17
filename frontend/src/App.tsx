import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Menu, Download, ShieldCheck, ChevronRight } from 'lucide-react'
import { supabase, type Lead, type Campaign } from './lib/supabase'
import { LoginScreen } from './components/LoginScreen'
import { LandingPage } from './components/LandingPage'
import { Button } from './components/ui'
import { KanbanBoard } from './components/KanbanBoard'
import { CampaignsView } from './components/CampaignsView'
import { LeadsView } from './components/LeadsView'
import { ImportedLeadsView } from './components/ImportedLeadsView'
import { DashboardView } from './components/DashboardView'
import { AgentConfig } from './components/AgentConfig'
import { ConnectionsPage } from './components/ConnectionsPage'
import { ExtensionAndAppView } from './components/ExtensionAndAppView'
import { VoiceSettings } from './components/VoiceSettings'
import { AICenter } from './components/AICenter'
import { ContactsView } from './components/ContactsView'
import { CommercialMemory } from './components/CommercialMemory'
import { AgendaView } from './components/AgendaView'
import { FollowUpsCalendarPanel } from './components/FollowUpsCalendarPanel'
import { ThemeToggle } from './components/ThemeToggle'
import { ConnectionQrOverlay } from './components/ConnectionQrOverlay'
import { ManualProspection } from './components/ManualProspection'
import { ContaPage } from './components/ContaPage'
import { PlansPage } from './components/PlansPage'
import { LeadsWidget } from './components/LeadsWidget'
import { MasterPanel } from './components/MasterPanel'
import { downloadPersonalizedExtension } from './lib/extensionDownload'
import { subscribeVoiceNotifications, scheduleMeetingReminders } from './lib/voice'
import { saasApi } from './lib/api'
import { NAV_ITEMS, resolveTabFromPath, type Tab } from './lib/routes'

const APP_VERSION = '2.1.0'

interface ShellProps {
  leads: Lead[]
  activeLeads: Lead[]
  importedLeads: Lead[]
  campaigns: Campaign[]
  onMeeting: (id: string, meeting_at: string, notes: string) => Promise<boolean>
  onCloseLead: (id: string, closed: boolean, motivo: string, valor: number | null) => Promise<boolean>
  onLeadsChanged: () => Promise<void>
}

function Shell({ leads, activeLeads, importedLeads, campaigns, onMeeting, onCloseLead, onLeadsChanged }: ShellProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [extStatus, setExtStatus] = useState('')
  const [isMaster, setIsMaster] = useState(false)
  const activeTab: Tab | null = resolveTabFromPath(location.pathname)

  useEffect(() => {
    saasApi.me().then((m) => setIsMaster(m.user.role === 'MASTER')).catch(() => setIsMaster(false))
  }, [])

  function navigateTab(t: Tab) {
    const item = NAV_ITEMS.find((i) => i.key === t)
    if (item) navigate(item.path)
    setSidebarOpen(false)
  }

  // Painel Master = modo de gestão em tela cheia (sem a sidebar do app).
  if (location.pathname.startsWith('/master')) {
    return (
      <div className="h-full">
        <MasterPanel onBack={() => navigate('/kanban')} />
        <ConnectionQrOverlay />
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <div className="md:hidden fixed top-0 inset-x-0 z-40 flex items-center gap-3 h-14 px-4 bg-sidebar/95 backdrop-blur border-b border-line">
        <button
          onClick={() => setSidebarOpen(true)}
          className="p-2 -ml-2 rounded-lg text-secondary hover:bg-subtle hover:text-fg transition"
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
        <div className="ml-auto">
          <ThemeToggle />
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
        className={`fixed inset-y-0 left-0 z-50 w-64 shrink-0 bg-sidebar border-r border-line flex flex-col transition-transform duration-200 ease-out md:static md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ boxShadow: 'var(--shadow-2)' }}
      >
         <div className="px-5 py-5 border-b border-line"
           style={{ background: 'linear-gradient(180deg, var(--c-subtle-2), transparent)' }}>
           <div className="flex items-center gap-3">
             <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-accent-500 to-accent-700 flex items-center justify-center text-sm font-extrabold text-white shadow-2 shrink-0">V</div>
             <div className="min-w-0">
               <div className="font-semibold text-sm leading-none truncate">Vyntra</div>
               <div className="text-[11px] text-faint mt-1 truncate">Agente IA · Prospecção</div>
             </div>
           </div>
         </div>

        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = activeTab === item.key
            return (
              <button
                key={item.key}
                onClick={() => navigateTab(item.key)}
                aria-current={active ? 'page' : undefined}
                className={`relative w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all duration-200 ${
                  active
                    ? 'bg-accent-500/12 text-fg shadow-sm'
                    : 'text-muted hover:bg-subtle hover:text-fg'
                }`}
                style={active ? { boxShadow: 'inset 0 0 0 1px var(--c-accent-200)' } : undefined}
              >
                {active && (
                  <span className="absolute -left-3 top-1/2 -translate-y-1/2 w-1 h-5 rounded-r-full bg-accent-500 shadow-[0_0_8px_var(--c-accent-400)]" />
                )}
                <Icon
                  className={`w-[18px] h-[18px] shrink-0 transition-colors duration-200 ${
                    active ? 'text-accent-400' : 'text-faint group-hover:text-secondary'
                  }`}
                />
                <span className="truncate font-medium">{item.label}</span>
                {active && <ChevronRight className="w-3 h-3 ml-auto text-accent-400" />}
              </button>
            )
          })}
          {isMaster && (
            <button
              onClick={() => { navigate('/master'); setSidebarOpen(false) }}
              className={`relative w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors duration-150 ${
                location.pathname.startsWith('/master')
                  ? 'bg-accent-500/15 text-fg'
                  : 'text-muted hover:bg-subtle hover:text-fg'
              }`}
            >
              <ShieldCheck className="w-[18px] h-[18px] shrink-0 text-faint" />
              <span className="truncate">Painel Master</span>
            </button>
          )}
        </nav>

        <div className="px-5 py-4 border-t border-line space-y-3">
          <LeadsWidget compact onBuy={() => navigate('/planos')} />
          <div className="flex items-center justify-between text-[11px] text-faint">
            <span>{leads.length} leads no total</span>
            <span className="font-mono opacity-70">v{APP_VERSION}</span>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              void downloadPersonalizedExtension().then((r) => setExtStatus(r.message))
            }}
            icon={<Download size={14} />}
            className="w-full"
          >
            Baixar extensão
          </Button>
          {extStatus && (
            <div className="text-[11px] text-faint animate-fade-in px-1">{extStatus}</div>
          )}
          <ThemeToggle />
        </div>
      </aside>

      <main className="flex-1 overflow-hidden pt-14 md:pt-0">
        <Routes>
          <Route path="/" element={<Navigate to="/kanban" replace />} />
          <Route path="/kanban" element={<KanbanBoard leads={leads} campaigns={campaigns} onMeeting={onMeeting} onClose={onCloseLead} />} />
          <Route path="/leads" element={<LeadsView leads={activeLeads} campaigns={campaigns} />} />
          <Route path="/prospeccao-manual" element={<ManualProspection />} />
          <Route path="/importados" element={<ImportedLeadsView leads={importedLeads} campaigns={campaigns} onChanged={onLeadsChanged} />} />
          <Route path="/campanhas" element={<CampaignsView />} />
          <Route path="/agenda" element={<div className="h-full overflow-auto"><AgendaView /><div className="max-w-6xl mx-auto px-4 pb-6"><FollowUpsCalendarPanel /></div></div>} />
          <Route path="/dashboard" element={<DashboardView leads={leads} />} />
          <Route path="/agente" element={<AgentConfig />} />
          <Route path="/voz" element={<VoiceSettings />} />
          <Route path="/conexoes" element={<ConnectionsPage />} />
          <Route path="/extensao" element={<ExtensionAndAppView />} />
          <Route path="/app-mobile" element={<Navigate to="/extensao" replace />} />
          <Route path="/contatos" element={<ContactsView />} />
          <Route path="/conta" element={<ContaPage />} />
          <Route path="/planos" element={<PlansPage />} />
          <Route path="/master" element={<MasterPanel />} />
          <Route path="/central-ia" element={<AICenter />} />
          <Route path="/central-ia/memoria" element={<CommercialMemory />} />
          <Route path="/central-ia/memoria/lotes" element={<CommercialMemory />} />
          <Route path="/central-ia/memoria/conversas" element={<CommercialMemory />} />
          <Route path="/central-ia/memoria/aprendizados" element={<CommercialMemory />} />
          <Route path="*" element={<Navigate to="/kanban" replace />} />
        </Routes>
      </main>

      <ConnectionQrOverlay />
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState<boolean | null>(null)
  const [booted, setBooted] = useState(false)
  const [leads, setLeads] = useState<Lead[]>([])
  const [campaigns, setCampaigns] = useState<Campaign[]>([])

  // Leads ativos na prospecção (/leads). Leads arquivados ("limpar lista")
  // seguem no estado `leads` (total) para dashboard/Kanban da campanha.
  const activeLeads = leads.filter((l) => l.is_active_in_prospecting !== false)
  const importedLeads = activeLeads.filter((l) => l.import_state === 'imported')
  const permanentLeads = activeLeads.filter((l) => l.import_state !== 'imported')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(!!data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(!!s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (session) {
      setBooted(false)
      Promise.all([loadLeads(), loadCampaigns()]).finally(() => setBooted(true))
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

  useEffect(() => {
    if (!session) return
    const stop = subscribeVoiceNotifications()
    return stop
  }, [session])

  useEffect(() => {
    scheduleMeetingReminders(leads)
  }, [leads])

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

  async function closeLead(id: string, closed: boolean, motivo: string, valor: number | null) {
    const { error } = await supabase.rpc('consecom_fechar_lead', {
      p_lead_id: id,
      p_fechado: closed,
      p_motivo: motivo || null,
      p_valor: closed && valor != null && valor > 0 ? valor : null,
    })
    if (!error) {
      setLeads((l) =>
        l.map((x) =>
          x.id === id
            ? {
                ...x,
                status: closed ? 'fechado' : 'nao_fechado',
                closed_reason: motivo || null,
                closed_at: new Date().toISOString(),
                sale_value: closed && valor != null && valor > 0 ? valor : null,
              }
            : x,
        ),
      )
    }
    return !error
  }

  if (session === null) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-muted">Carregando…</div>
      </div>
    )
  }

  if (!session) {
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    )
  }

  if (!booted) {
    return (
      <div className="h-full flex items-center justify-center bg-app">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent-500 to-accent-700 flex items-center justify-center text-xl font-extrabold text-white shadow-2 animate-pulse-soft">
            V
          </div>
          <div className="text-sm text-muted">Carregando painel…</div>
        </div>
      </div>
    )
  }

  return <Shell leads={leads} activeLeads={permanentLeads} importedLeads={importedLeads} campaigns={campaigns} onMeeting={markMeeting} onCloseLead={closeLead} onLeadsChanged={loadLeads} />
}
