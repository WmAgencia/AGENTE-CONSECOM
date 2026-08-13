import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { followUpsApi } from '../lib/api'
import type { FollowUp } from '../lib/supabase'

function monthBounds(anchor: Date): { start: string; end: string } {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return { start: fmt(start), end: fmt(end) }
}

export function FollowUpsCalendarPanel() {
  const [anchor, setAnchor] = useState(() => new Date())
  const [rows, setRows] = useState<FollowUp[]>([])
  const bounds = useMemo(() => monthBounds(anchor), [anchor])

  useEffect(() => {
    let alive = true
    void followUpsApi.list(bounds).then((data) => { if (alive) setRows(data) }).catch(() => { if (alive) setRows([]) })
    return () => { alive = false }
  }, [bounds])

  const title = anchor.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
  return (
    <section className="rounded-xl border border-line bg-subtle p-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-secondary">Follow-ups</h2>
          <p className="text-xs text-muted">Agendamentos de mensagens para leads</p>
        </div>
        <button onClick={() => setAnchor((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))} className="p-1.5 rounded-md hover:bg-subtle-2 text-muted"><ChevronLeft className="w-4 h-4" /></button>
        <span className="text-xs text-secondary capitalize min-w-28 text-center">{title}</span>
        <button onClick={() => setAnchor((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))} className="p-1.5 rounded-md hover:bg-subtle-2 text-muted"><ChevronRight className="w-4 h-4" /></button>
      </div>
      {rows.length === 0 ? <div className="text-xs text-faint py-5 text-center">Nenhum follow-up neste mês.</div> : (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.id} className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-3 py-2.5 text-xs flex flex-wrap gap-2 items-center">
              <span className="text-cyan-300 font-medium">{row.scheduled_date} · {row.scheduled_time ?? 'sem horário'}</span>
              <span className="text-fg">{row.lead?.name ?? 'Lead'}</span>
              <span className="text-muted flex-1 min-w-40 truncate">{row.message}</span>
              <span className="text-faint">{row.source === 'ia' ? 'Agendado pela IA' : 'Agendado pelo operador'} · {row.status}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
