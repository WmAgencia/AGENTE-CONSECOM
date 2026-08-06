import { useEffect, useState } from 'react'
import { supabase, type Lead, type LeadStatus } from './lib/supabase'
import { LoginScreen } from './components/LoginScreen'
import { KanbanBoard } from './components/KanbanBoard'
import { CampaignsView } from './components/CampaignsView'
import { LeadsView } from './components/LeadsView'

type Tab = 'kanban' | 'leads' | 'campanhas'

export default function App() {
  const [session, setSession] = useState<boolean | null>(null)
  const [tab, setTab] = useState<Tab>('kanban')
  const [leads, setLeads] = useState<Lead[]>([])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(!!data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(!!s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (session) loadLeads()
  }, [session])

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

  async function moveLead(id: string, status: LeadStatus) {
    const prev = leads
    setLeads((l) => l.map((x) => (x.id === id ? { ...x, status } : x)))
    const { error } = await supabase
      .from('leads')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) {
      setLeads(prev)
      return
    }
    await supabase.from('lead_status_history').insert({ lead_id: id, status })
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
          {(['kanban', 'leads', 'campanhas'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
                tab === t
                  ? 'bg-white/5 text-white'
                  : 'text-slate-400 hover:bg-white/5 hover:text-white'
              }`}
            >
              {t === 'kanban' ? 'Kanban' : t === 'leads' ? 'Leads' : 'Campanhas & fila'}
            </button>
          ))}
        </nav>

        <div className="px-5 py-4 border-t border-white/5 space-y-2">
          <div className="text-[11px] text-slate-500">{leads.length} leads no total</div>
          <button
            onClick={() => supabase.auth.signOut()}
            className="text-xs text-slate-400 hover:text-white transition"
          >
            Sair
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-hidden">
        {tab === 'kanban' && <KanbanBoard leads={leads} onMove={moveLead} />}
        {tab === 'leads' && <LeadsView leads={leads} />}
        {tab === 'campanhas' && <CampaignsView />}
      </main>
    </div>
  )
}