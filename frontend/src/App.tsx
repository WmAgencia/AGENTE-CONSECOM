import { useEffect, useState } from 'react'
import { supabase, type Lead, type LeadStatus } from './lib/supabase'
import { KanbanBoard } from './components/KanbanBoard'
import { CampaignsView } from './components/CampaignsView'
import { LeadsView } from './components/LeadsView'

type Tab = 'kanban' | 'leads' | 'campanhas'

export default function App() {
  const [tab, setTab] = useState<Tab>('kanban')
  const [leads, setLeads] = useState<Lead[]>([])

  async function loadLeads() {
    const { data, error } = await supabase
      .from('leads')
      .select('*')
      .order('created_at', { ascending: false })
    if (!error && data) setLeads(data)
  }

  useEffect(() => {
    loadLeads()
    const ch = supabase
      .channel('leads')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, loadLeads)
      .subscribe()
    return () => {
      supabase.removeChannel(ch)
    }
  }, [])

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
          <button onClick={() => setTab('kanban')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
              tab === 'kanban' ? 'bg-white/5 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-white'
            }`}>
            <Dot className="w-4 h-4" /> Kanban
          </button>
          <button onClick={() => setTab('leads')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
              tab === 'leads' ? 'bg-white/5 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-white'
            }`}>
            <Dot className="w-4 h-4" /> Leads
          </button>
          <button onClick={() => setTab('campanhas')}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
              tab === 'campanhas' ? 'bg-white/5 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-white'
            }`}>
            <Dot className="w-4 h-4" /> Campanhas &amp; fila
          </button>
        </nav>

        <div className="px-5 py-4 border-t border-white/5 text-[11px] text-slate-500">
          {leads.length} leads no total
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

function Dot({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}