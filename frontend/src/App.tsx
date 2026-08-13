import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Menu, Download } from 'lucide-react'
import { supabase, type Lead, type Campaign } from './lib/supabase'
import { LoginScreen } from './components/LoginScreen'
import { KanbanBoard } from './components/KanbanBoard'
import { CampaignsView } from './components/CampaignsView'
import { LeadsView } from './components/LeadsView'
import { ImportedLeadsView } from './components/ImportedLeadsView'
import { DashboardView } from './components/DashboardView'
import { AgentConfig } from './components/AgentConfig'
import { ConnectionsPage } from './components/ConnectionsPage'
import { MobileAppView } from './components/MobileAppView'
import { ExtensionView } from './components/ExtensionView'
import { VoiceSettings } from './components/VoiceSettings'
import { AICenter } from './components/AICenter'
import { ContactsView } from './components/ContactsView'
import { CommercialMemory } from './components/CommercialMemory'
import { AgendaView } from './components/AgendaView'
import { ThemeToggle } from './components/ThemeToggle'
import { subscribeVoiceNotifications, scheduleMeetingReminders } from './lib/voice'
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
  const activeTab: Tab | null = resolveTabFromPath(location.pathname)

  function navigateTab(t: Tab) {
    const item = NAV_ITEMS.find((i) => i.key === t)
    if (item) navigate(item.path)
    setSidebarOpen(false)
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
      >
        <div className="px-5 py-5 border-b border-line">
          <div className="flex items-center gap-2.5">
            <img
              src="/vyntra-logo.png"
              alt="Vyntra"
              className="w-8 h-8 rounded-lg object-contain bg-white"
            />
            <div>
              <div className="font-semibold leading-none">Vyntra</div>
              <div className="text-[11px] text-faint mt-1">Alex · Prospecção</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const active = activeTab === item.key
            return (
              <button
                key={item.key}
                onClick={() => navigateTab(item.key)}
                aria-current={active ? 'page' : undefined}
                className={`relative w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors duration-150 ${
                  active
                    ? 'bg-indigo-500/15 text-fg'
                    : 'text-muted hover:bg-subtle hover:text-fg'
                }`}
              >
                {active && (
                  <span className="absolute -left-3 top-1/2 -translate-y-1/2 w-1 h-5 rounded-r-full bg-indigo-400" />
                )}
                <Icon
                  className={`w-[18px] h-[18px] shrink-0 ${
                    active ? 'text-indigo-300' : 'text-faint group-hover:text-secondary'
                  }`}
                />
                <span className="truncate">{item.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="px-5 py-4 border-t border-line space-y-2">
          <div className="text-[11px] text-faint">{leads.length} leads no total</div>
          <div className="text-[11px] text-faint">v{APP_VERSION}</div>

          {/* Atalho rápido — download da extensão (fonte estática versionada no repo) */}
          <a
            href="/downloads/consecom-extension.zip"
            download="consecom-extension.zip"
            className="flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-500 transition focus:ring-2 focus:ring-indigo-400 focus:outline-none"
            title="Baixar extensão Chrome (.zip)"
          >
            <Download className="w-3.5 h-3.5" />
            Baixar extensão (.zip)
          </a>

          <button
            onClick={() => {
              setSidebarOpen(false)
              void supabase.auth.signOut()
            }}
            className="text-xs text-muted hover:text-fg transition"
          >
            Sair
          </button>

          <ThemeToggle className="-ml-2" />
        </div>
      </aside>

      <main className="flex-1 overflow-hidden pt-14 md:pt-0">
        <Routes>
          <Route path="/" element={<Navigate to="/kanban" replace />} />
          <Route path="/kanban" element={<KanbanBoard leads={leads} campaigns={campaigns} onMeeting={onMeeting} onClose={onCloseLead} />} />
          <Route path="/leads" element={<LeadsView leads={activeLeads} campaigns={campaigns} />} />
          <Route path="/importados" element={<ImportedLeadsView leads={importedLeads} campaigns={campaigns} onChanged={onLeadsChanged} />} />
          <Route path="/campanhas" element={<CampaignsView />} />
          <Route path="/agenda" element={<AgendaView />} />
          <Route path="/dashboard" element={<DashboardView leads={leads} />} />
          <Route path="/agente" element={<AgentConfig />} />
          <Route path="/voz" element={<VoiceSettings />} />
          <Route path="/conexoes" element={<ConnectionsPage />} />
          <Route path="/extensao" element={<ExtensionView />} />
          <Route path="/app-mobile" element={<MobileAppView />} />
          <Route path="/contatos" element={<ContactsView />} />
          <Route path="/central-ia" element={<AICenter />} />
          <Route path="/central-ia/memoria" element={<CommercialMemory />} />
          <Route path="/central-ia/memoria/lotes" element={<CommercialMemory />} />
          <Route path="/central-ia/memoria/conversas" element={<CommercialMemory />} />
          <Route path="/central-ia/memoria/aprendizados" element={<CommercialMemory />} />
          <Route path="*" element={<Navigate to="/kanban" replace />} />
        </Routes>
      </main>
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState<boolean | null>(null)
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
    return <LoginScreen />
  }

  return <Shell leads={leads} activeLeads={permanentLeads} importedLeads={importedLeads} campaigns={campaigns} onMeeting={markMeeting} onCloseLead={closeLead} onLeadsChanged={loadLeads} />
}
