import { CalendarClock, Megaphone, MessageSquare, RefreshCw, WifiOff, ArrowRight } from 'lucide-react'
import type { DashboardSnapshot } from '../services/data'
import type { ReminderPrefs } from '../lib/types'
import { MEETING_STATUS } from '../core/syncEngine'
import { formatReminder } from '../lib/format'

interface Props {
  data: DashboardSnapshot | null
  reminder: ReminderPrefs | null
  lastSync: number | null
  syncError: string | null
  onRefresh: () => void
  onOpenTab: (tab: 'reunioes' | 'alarmes' | 'notificacoes') => void
}

export function HomeScreen({ data, reminder, lastSync, syncError, onRefresh, onOpenTab }: Props) {
  const meetings = data?.leads.filter((l) => l.status === MEETING_STATUS && l.meeting_at) ?? []
  const sorted = [...meetings].sort((a, b) => (a.meeting_at! < b.meeting_at! ? -1 : 1))
  const next = sorted[0] ?? null
  const today = new Date()
  const todayMeetings = sorted.filter((m) => {
    const d = new Date(m.meeting_at!)
    return (
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate()
    )
  })

  const activeCampaigns = data?.campaigns.filter((c) => c.status === 'em_progresso') ?? []
  const pendingRuns = data?.leads.filter((l) => l.status === 'na_fila').length ?? 0
  const repliesToday = (data?.replies ?? []).filter(
    (r) => new Date(r.created_at).toDateString() === today.toDateString(),
  ).length
  const connected = (data?.connections ?? []).some((c) => c.status === 'connected')

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Olá 👋</h1>
          <p className="text-sm text-slate-400">
            {today.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })}
          </p>
        </div>
        <button
          onClick={onRefresh}
          className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 transition"
          aria-label="Atualizar"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </header>

      {syncError && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-200 text-xs px-3 py-2.5 flex items-center gap-2">
          <WifiOff className="w-4 h-4 shrink-0" />
          {syncError}
        </div>
      )}

      {/* Próxima reunião */}
      <section
        className="rounded-2xl border border-indigo-500/30 bg-gradient-to-br from-indigo-500/15 to-fuchsia-500/10 p-5"
        onClick={() => onOpenTab('reunioes')}
      >
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] font-semibold tracking-wide text-indigo-300 uppercase">
            Próxima reunião
          </span>
          <ArrowRight className="w-4 h-4 text-slate-500" />
        </div>
        {next ? (
          <>
            <div className="text-lg font-semibold">{next.name ?? 'Sem nome'}</div>
            <div className="flex items-center gap-1.5 text-sm text-slate-300 mt-1">
              <CalendarClock className="w-4 h-4 text-indigo-300" />
              {formatMeeting(next.meeting_at!)}
            </div>
            {next.meeting_notes && (
              <p className="text-xs text-slate-400 mt-1.5 line-clamp-2">{next.meeting_notes}</p>
            )}
            <div className="mt-3 text-[11px] text-slate-400">
              🔔 Alarme {formatReminder(reminder?.defaultMinutes ?? 30)} antes
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-400">Nenhuma reunião agendada ainda.</p>
        )}
      </section>

      {/* Reuniões de hoje */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-slate-300">Reuniões de hoje</h2>
          <button onClick={() => onOpenTab('reunioes')} className="text-xs text-indigo-300">
            Ver todas
          </button>
        </div>
        {todayMeetings.length === 0 ? (
          <p className="text-sm text-slate-500">Nada para hoje. 🎯</p>
        ) : (
          <div className="space-y-2">
            {todayMeetings.map((m) => (
              <div
                key={m.id}
                className="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3"
              >
                <div className="text-sm font-medium">{m.name ?? 'Sem nome'}</div>
                <div className="text-xs text-slate-400 mt-0.5">{formatMeeting(m.meeting_at!)}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Estatísticas rápidas */}
      <section className="grid grid-cols-2 gap-3">
        <div
          className="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3"
          onClick={() => onOpenTab('alarmes')}
        >
          <div className="flex items-center gap-2 text-slate-300 mb-1">
            <CalendarClock className="w-4 h-4 text-indigo-300" />
            <span className="text-[11px] uppercase tracking-wide">Agendadas</span>
          </div>
          <div className="text-2xl font-semibold">{meetings.length}</div>
          <div className="text-[11px] text-slate-500">{todayMeetings.length} hoje</div>
        </div>
        <div
          className="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3"
          onClick={() => onOpenTab('notificacoes')}
        >
          <div className="flex items-center gap-2 text-slate-300 mb-1">
            <MessageSquare className="w-4 h-4 text-fuchsia-300" />
            <span className="text-[11px] uppercase tracking-wide">Respostas</span>
          </div>
          <div className="text-2xl font-semibold">{repliesToday}</div>
          <div className="text-[11px] text-slate-500">hoje</div>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
          <div className="flex items-center gap-2 text-slate-300 mb-1">
            <Megaphone className="w-4 h-4 text-amber-300" />
            <span className="text-[11px] uppercase tracking-wide">Campanhas</span>
          </div>
          <div className="text-2xl font-semibold">{activeCampaigns.length}</div>
          <div className="text-[11px] text-slate-500">{pendingRuns} leads na fila</div>
        </div>
        <div className="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
          <div className="flex items-center gap-2 text-slate-300 mb-1">
            <span className="w-4 h-4 inline-flex items-center justify-center">
              <span className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-rose-400'}`} />
            </span>
            <span className="text-[11px] uppercase tracking-wide">WhatsApp</span>
          </div>
          <div className="text-sm font-medium mt-1.5">{connected ? 'Conectado' : 'Desconectado'}</div>
        </div>
      </section>

      <footer className="text-center text-[11px] text-slate-600 pb-2">
        {lastSync
          ? `Sincronizado às ${new Date(lastSync).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
          : 'Aguardando primeira sincronização…'}
      </footer>
    </div>
  )
}

function formatMeeting(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}
