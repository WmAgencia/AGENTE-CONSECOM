import { useEffect, useState } from 'react'
import { LocalNotifications, type LocalNotificationSchema } from '@capacitor/local-notifications'
import { Bell, BellOff, RefreshCw, Clock } from 'lucide-react'
import type { Lead, ReminderPrefs } from '../lib/types'
import { MEETING_STATUS, alarmIdFor } from '../core/syncEngine'
import { formatReminder } from '../lib/format'

interface Props {
  leads: Lead[]
  reminder: ReminderPrefs | null
  lastSync: number | null
  onLeadReminderChange: (leadId: string, minutes: number) => void
  onClearLeadReminder: (leadId: string) => void
}

export function AlarmsScreen({ leads, reminder, lastSync, onLeadReminderChange, onClearLeadReminder }: Props) {
  const [pending, setPending] = useState<LocalNotificationSchema[] | null>(null)

  useEffect(() => {
    void LocalNotifications.getPending().then(({ notifications }) =>
      setPending(notifications ?? []),
    )
  }, [lastSync])

  const meetings = leads.filter((l) => l.status === MEETING_STATUS && l.meeting_at)
  const scheduledIds = new Map((pending ?? []).map((n) => [n.id, n]))

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Meus alarmes</h1>
        <p className="text-sm text-slate-400">
          {pending === null ? 'Consultando…' : `${pending.length} alarme(s) ativos no sistema`}
        </p>
      </header>

      {pending !== null && pending.length === 0 && (
        <p className="text-sm text-slate-500 text-center py-8">
          Nenhum alarme agendado. As reuniões criam alarmes automaticamente.
        </p>
      )}

      <div className="space-y-3">
        {meetings.map((m) => {
          const id = alarmIdFor(m.id)
          const isScheduled = scheduledIds.has(id)
          const fireAt = scheduledIds.get(id)?.schedule?.at
          const reminderMin = reminder?.perLead[m.id] ?? reminder?.defaultMinutes ?? 30
          return (
            <div
              key={m.id}
              className={`rounded-xl border px-4 py-3.5 ${
                isScheduled ? 'border-white/5 bg-white/[0.03]' : 'border-amber-500/20 bg-amber-500/5'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {isScheduled ? (
                    <Bell className="w-4 h-4 text-indigo-300" />
                  ) : (
                    <BellOff className="w-4 h-4 text-amber-300" />
                  )}
                  <span className="font-medium text-sm">{m.name ?? 'Sem nome'}</span>
                </div>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full ${
                    isScheduled ? 'bg-indigo-500/20 text-indigo-200' : 'bg-amber-500/20 text-amber-200'
                  }`}
                >
                  {isScheduled ? 'Ativo' : 'Sem alarme'}
                </span>
              </div>

              <div className="mt-2 space-y-1">
                <div className="text-xs text-slate-300 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-slate-500" />
                  Reunião: {formatMeeting(m.meeting_at!)}
                </div>
                {fireAt && (
                  <div className="text-xs text-slate-400 flex items-center gap-1.5">
                    <Bell className="w-3.5 h-3.5 text-slate-500" />
                    Dispara: {new Date(fireAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </div>
                )}
              </div>

              <div className="mt-3 flex items-center gap-2">
                <label className="text-[11px] text-slate-500">Antecedência</label>
                <select
                  value={reminderMin}
                  onChange={(e) => onLeadReminderChange(m.id, Number(e.target.value))}
                  className="bg-black/30 border border-white/10 rounded-lg text-xs px-2 py-1.5 text-slate-200 outline-none focus:border-indigo-500"
                >
                  {[5, 10, 15, 30, 60, 120].map((o) => (
                    <option key={o} value={o}>
                      {formatReminder(o)} antes
                    </option>
                  ))}
                </select>
                {reminder?.perLead[m.id] != null && (
                  <button
                    onClick={() => onClearLeadReminder(m.id)}
                    className="text-[11px] text-indigo-300"
                  >
                    usar padrão
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="text-center text-[11px] text-slate-600 flex items-center justify-center gap-1.5">
        <RefreshCw className="w-3 h-3" />
        {lastSync
          ? `Sincronizado às ${new Date(lastSync).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
          : 'Aguardando sincronização…'}
      </div>
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
