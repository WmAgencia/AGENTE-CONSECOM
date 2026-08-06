import { useState } from 'react'
import { type Lead, type LeadStatus } from '../lib/supabase'

const COLUMNS: { status: LeadStatus; label: string; color: string }[] = [
  { status: 'novo', label: 'Novo', color: 'from-slate-500 to-slate-600' },
  { status: 'na_fila', label: 'Na fila', color: 'from-amber-500 to-orange-500' },
  { status: 'mensagem_enviada', label: 'Mensagem enviada', color: 'from-sky-500 to-blue-600' },
  { status: 'respondendo', label: 'Respondendo', color: 'from-violet-500 to-purple-600' },
  { status: 'reuniao_marcada', label: 'Reunião marcada', color: 'from-emerald-500 to-teal-600' },
  { status: 'fechado', label: 'Fechado', color: 'from-green-500 to-green-600' },
  { status: 'perdido', label: 'Perdido', color: 'from-rose-500 to-red-600' },
]

const STATUS_META: Record<LeadStatus, { color: string; label: string }> = Object.fromEntries(
  COLUMNS.map((c) => [c.status, { color: c.color, label: c.label }]),
) as Record<LeadStatus, { color: string; label: string }>

export function KanbanBoard({
  leads,
  onMove,
}: {
  leads: Lead[]
  onMove: (id: string, status: LeadStatus) => Promise<void>
}) {
  const [dragOver, setDragOver] = useState<LeadStatus | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-white/5 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Painel de prospecção</h1>
          <p className="text-sm text-slate-400">Arraste os leads entre as etapas</p>
        </div>
      </div>

      <div className="flex-1 flex gap-4 px-6 py-5 overflow-x-auto">
        {COLUMNS.map((col) => {
          const items = leads.filter((l) => l.status === col.status)
          return (
            <div
              key={col.status}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(col.status)
              }}
              onDragLeave={() => setDragOver((s) => (s === col.status ? null : s))}
              onDrop={(e) => {
                e.preventDefault()
                const id = dragging ?? e.dataTransfer.getData('text/plain')
                if (id) onMove(id, col.status)
                setDragOver(null)
                setDragging(null)
              }}
              className={`w-72 shrink-0 rounded-xl border flex flex-col transition-colors ${
                dragOver === col.status
                  ? 'border-indigo-500/50 bg-indigo-500/5'
                  : 'border-white/5 bg-white/[0.02]'
              }`}
            >
              <div className="px-4 py-3 flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full bg-gradient-to-br ${col.color}`} />
                <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
                  {col.label}
                </span>
                <span className="ml-auto text-xs text-slate-500 bg-white/5 rounded-full px-2 py-0.5">
                  {items.length}
                </span>
              </div>

              <div className="flex-1 px-2 pb-2 space-y-2 overflow-y-auto">
                {items.map((lead) => (
                  <LeadCard
                    key={lead.id}
                    lead={lead}
                    draggable
                    onDragStart={() => setDragging(lead.id)}
                    onDragEnd={() => {
                      setDragging(null)
                      setDragOver(null)
                    }}
                  />
                ))}
                {items.length === 0 && (
                  <div className="text-xs text-slate-600 text-center py-6 border border-dashed border-white/5 rounded-lg">
                    Sem leads
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function LeadCard({
  lead,
  draggable = false,
  onDragStart,
  onDragEnd,
}: {
  lead: Lead
  draggable?: boolean
  onDragStart?: () => void
  onDragEnd?: () => void
}) {
  const meta = STATUS_META[lead.status]
  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="rounded-lg bg-[#16161f] border border-white/5 p-3 cursor-grab active:cursor-grabbing hover:border-white/10 transition"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{lead.name || 'Sem nome'}</div>
          {lead.category && (
            <div className="text-[11px] text-slate-400 truncate">{lead.category}</div>
          )}
        </div>
        <span className={`w-2 h-2 rounded-full shrink-0 mt-1 bg-gradient-to-br ${meta.color}`} />
      </div>

      <div className="mt-2 space-y-1 text-[11px] text-slate-400">
        {lead.city && (
          <div className="flex items-center gap-1.5">
            <Pin className="w-3 h-3" /> {lead.city}
            {lead.state ? `, ${lead.state}` : ''}
          </div>
        )}
        {lead.phone && (
          <div className="flex items-center gap-1.5">
            <Phone className="w-3 h-3" /> {lead.phone}
          </div>
        )}
        {(lead.rating ?? 0) > 0 && (
          <div className="flex items-center gap-1.5">
            <Star className="w-3 h-3 text-amber-400" /> {lead.rating} ({lead.reviews ?? 0})
          </div>
        )}
      </div>

      {lead.niche && (
        <div className="mt-2 inline-block text-[10px] text-indigo-300/80 bg-indigo-500/10 rounded px-1.5 py-0.5">
          {lead.niche}
        </div>
      )}
    </div>
  )
}

function Pin({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11Z" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}
function Phone({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8.1 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.5 2.9.7a2 2 0 0 1 1.6 2Z" stroke="currentColor" strokeWidth="1.8" fill="none" />
    </svg>
  )
}
function Star({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M12 2l2.9 6.2 6.6.9-4.8 4.6 1.2 6.6L12 17.8 6.1 20.3l1.2-6.6L2.5 9.1l6.6-.9L12 2Z" />
    </svg>
  )
}