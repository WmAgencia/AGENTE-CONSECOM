import { useState } from 'react'
import { CalendarClock, RefreshCw, AlarmClock, ChevronDown, ChevronUp } from 'lucide-react'
import type { Lead, ReminderPrefs } from '../lib/types'
import { MEETING_STATUS } from '../core/syncEngine'
import { formatReminder } from '../lib/format'
import { AlarmSoundPicker } from '../components/AlarmSoundPicker'

interface Props {
  leads: Lead[]
  reminder: ReminderPrefs | null
  onLeadReminderChange: (leadId: string, minutes: number) => void
  onClearLeadReminder: (leadId: string) => void
  onSoundChanged: () => void
  onRefresh: () => void
}

const REMINDER_OPTIONS = [5, 10, 15, 30, 60, 120]

export function MeetingsScreen({ leads, reminder, onLeadReminderChange, onClearLeadReminder, onSoundChanged, onRefresh }: Props) {
  const [openSound, setOpenSound] = useState<string | null>(null)
  const meetings = leads
    .filter((l) => l.status === MEETING_STATUS && l.meeting_at)
    .sort((a, b) => (a.meeting_at! < b.meeting_at! ? -1 : 1))

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Reuniões</h1>
          <p className="text-sm text-slate-400">{meetings.length} agendadas</p>
        </div>
        <button
          onClick={onRefresh}
          className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 transition"
          aria-label="Atualizar"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </header>

      {meetings.length === 0 ? (
        <p className="text-sm text-slate-500 text-center py-10">
          Nenhuma reunião agendada. Quando o Alex marcar uma reunião, ela aparece aqui e dispara o
          alarme no celular.
        </p>
      ) : (
        <div className="space-y-3">
          {meetings.map((m) => {
            const reminderMin = reminder?.perLead[m.id] ?? reminder?.defaultMinutes ?? 30
            return (
              <div
                key={m.id}
                className="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">{m.name ?? 'Sem nome'}</div>
                    <div className="flex items-center gap-1.5 text-sm text-slate-300 mt-1">
                      <CalendarClock className="w-4 h-4 text-indigo-300" />
                      {formatMeeting(m.meeting_at!)}
                    </div>
                  </div>
                  <div className="text-right text-[11px] text-slate-500">
                    <span className="inline-flex items-center gap-1">
                      <AlarmClock className="w-3.5 h-3.5" />
                      {formatReminder(reminderMin)} antes
                    </span>
                  </div>
                </div>

                {m.meeting_notes && (
                  <p className="text-xs text-slate-400 mt-2">{m.meeting_notes}</p>
                )}

                <div className="mt-3 flex items-center gap-2">
                  <label className="text-[11px] text-slate-500">Alarme</label>
                  <select
                    value={reminderMin}
                    onChange={(e) => onLeadReminderChange(m.id, Number(e.target.value))}
                    className="bg-black/30 border border-white/10 rounded-lg text-xs px-2 py-1.5 text-slate-200 outline-none focus:border-indigo-500"
                  >
                    {REMINDER_OPTIONS.map((o) => (
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

                {/* Som/volume/vibração da reunião */}
                <button
                  onClick={() => setOpenSound(openSound === m.id ? null : m.id)}
                  className="mt-2 w-full flex items-center justify-between rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-xs text-slate-300 hover:bg-white/[0.06] transition"
                >
                  <span className="flex items-center gap-1.5">
                    <AlarmClock className="w-3.5 h-3.5 text-indigo-300" />
                    Som, volume e vibração
                  </span>
                  {openSound === m.id ? (
                    <ChevronUp className="w-4 h-4" />
                  ) : (
                    <ChevronDown className="w-4 h-4" />
                  )}
                </button>
                {openSound === m.id && (
                  <div className="mt-2 rounded-lg border border-white/5 bg-black/20 p-3">
                    <AlarmSoundPicker
                      leadId={m.id}
                      reminder={reminder}
                      onChanged={onSoundChanged}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function formatMeeting(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
