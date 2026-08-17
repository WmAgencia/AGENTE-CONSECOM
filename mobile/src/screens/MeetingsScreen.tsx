import { useState } from 'react'
import {
  CalendarClock,
  RefreshCw,
  AlarmClock,
  ChevronDown,
  ChevronUp,
  Plus,
  Search,
  X,
  Trash2,
  CheckCircle2,
} from 'lucide-react'
import type { Lead, ReminderPrefs } from '../lib/types'
import { MEETING_STATUS } from '../core/syncEngine'
import { formatReminder } from '../lib/format'
import { AlarmSoundPicker } from '../components/AlarmSoundPicker'
import {
  searchLeads,
  reserveMeeting as apiReserve,
  rescheduleMeeting as apiReschedule,
  cancelMeeting as apiCancel,
  realizeMeeting as apiRealize,
  type OwnLead,
  type OwnMeeting,
} from '../services/personalApi'

interface Props {
  leads: Lead[]
  reminder: ReminderPrefs | null
  onLeadReminderChange: (leadId: string, minutes: number) => void
  onClearLeadReminder: (leadId: string) => void
  onSoundChanged: () => void
  onRefresh: () => void
}

const REMINDER_OPTIONS = [5, 10, 15, 30, 60, 120]
const DURATION_OPTIONS = [15, 30, 45, 60, 90, 120]

function defaultDateTimeLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  d.setMinutes(0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function MeetingsScreen({ leads, reminder, onLeadReminderChange, onClearLeadReminder, onSoundChanged, onRefresh }: Props) {
  const [openSound, setOpenSound] = useState<string | null>(null)

  // Criação
  const [creating, setCreating] = useState(false)
  const [leadQuery, setLeadQuery] = useState('')
  const [leadResults, setLeadResults] = useState<OwnLead[] | null>(null)
  const [selectedLead, setSelectedLead] = useState<OwnLead | null>(null)
  const [newDateTime, setNewDateTime] = useState(defaultDateTimeLocal)
  const [durationMin, setDurationMin] = useState(30)

  // Reagendamento (por reunião)
  const [rescheduleFor, setRescheduleFor] = useState<string | null>(null)
  const [reschedDateTime, setReschedDateTime] = useState(defaultDateTimeLocal)

  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const meetings = leads
    .filter((l) => l.status === MEETING_STATUS && l.meeting_at)
    .sort((a, b) => (a.meeting_at! < b.meeting_at! ? -1 : 1))

  function flash(kind: 'ok' | 'err', text: string) {
    setNotice({ kind, text })
    window.setTimeout(() => setNotice(null), 6000)
  }

  async function doSearch() {
    const q = leadQuery.trim()
    if (!q) return
    setBusy('search')
    try {
      setLeadResults(await searchLeads(q))
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Falha ao buscar leads')
    } finally {
      setBusy(null)
    }
  }

  async function doCreate() {
    if (!selectedLead || !newDateTime) return
    setBusy('create')
    try {
      const res = await apiReserve(selectedLead.id, new Date(newDateTime).toISOString(), durationMin)
      if (res.ok) {
        flash('ok', `Reunião marcada com ${selectedLead.name ?? 'o contato'}.`)
        setCreating(false)
        setSelectedLead(null)
        setLeadQuery('')
        setLeadResults(null)
        onRefresh()
      } else {
        const alt = res.suggestions && res.suggestions.length > 0 ? ` Horários livres: ${res.suggestions.join('; ')}` : ''
        flash('err', `${res.message ?? 'Não foi possível marcar.'}${alt}`)
      }
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Falha ao marcar reunião')
    } finally {
      setBusy(null)
    }
  }

  async function doReschedule(m: OwnMeeting | Lead) {
    if (!reschedDateTime) return
    setBusy(`resched:${m.id}`)
    try {
      const res = await apiReschedule(m.id, new Date(reschedDateTime).toISOString())
      if (res.ok) {
        flash('ok', `Reunião com ${m.name ?? 'o contato'} reagendada.`)
        setRescheduleFor(null)
        onRefresh()
      } else {
        const alt = res.suggestions && res.suggestions.length > 0 ? ` Horários livres: ${res.suggestions.join('; ')}` : ''
        flash('err', `${res.message ?? 'Não foi possível reagendar.'}${alt}`)
      }
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Falha ao reagendar')
    } finally {
      setBusy(null)
    }
  }

  async function doCancel(m: OwnMeeting | Lead) {
    const name = m.name ?? 'este contato'
    if (!window.confirm(`Cancelar a reunião com ${name}? Esta ação não pode ser desfeita.`)) return
    setBusy(`cancel:${m.id}`)
    try {
      const res = await apiCancel(m.id)
      if (res.ok) {
        flash('ok', `Reunião com ${name} cancelada.`)
        onRefresh()
      } else {
        flash('err', res.message ?? 'Não foi possível cancelar.')
      }
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Falha ao cancelar')
    } finally {
      setBusy(null)
    }
  }

  async function doRealize(m: OwnMeeting | Lead) {
    if (!window.confirm(`Marcar a reunião com ${m.name ?? 'este contato'} como realizada?`)) return
    setBusy(`realize:${m.id}`)
    try {
      const res = await apiRealize(m.id)
      if (res.ok) {
        flash('ok', res.message ?? 'Reunião marcada como realizada.')
        onRefresh()
      } else {
        flash('err', res.message ?? 'Não foi possível concluir.')
      }
    } catch (e) {
      flash('err', e instanceof Error ? e.message : 'Falha ao concluir')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Reuniões</h1>
          <p className="text-sm text-slate-400">{meetings.length} agendadas</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCreating((v) => !v)}
            className="p-2 rounded-lg bg-indigo-500 text-white hover:bg-indigo-400 transition flex items-center gap-1 text-xs font-medium px-3"
          >
            <Plus className="w-4 h-4" />
            Nova
          </button>
          <button
            onClick={onRefresh}
            className="p-2 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 transition"
            aria-label="Atualizar"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </header>

      {notice && (
        <div
          className={`rounded-xl border px-3 py-2.5 text-xs flex items-center gap-2 ${
            notice.kind === 'ok'
              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
          }`}
        >
          {notice.text}
        </div>
      )}

      {/* Criar reunião */}
      {creating && (
        <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/[0.06] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">Nova reunião</h2>
            <button
              onClick={() => setCreating(false)}
              className="text-slate-400 hover:text-slate-200"
              aria-label="Fechar"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <input
              value={leadQuery}
              onChange={(e) => setLeadQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doSearch()
              }}
              placeholder="Buscar lead por nome ou telefone…"
              className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-indigo-500"
            />
            <button
              onClick={() => void doSearch()}
              disabled={busy === 'search'}
              className="p-2 rounded-lg bg-white/5 text-slate-300 hover:bg-white/10 disabled:opacity-50"
              aria-label="Buscar"
            >
              <Search className="w-4 h-4" />
            </button>
          </div>

          {selectedLead && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 flex items-center justify-between">
              <span>
                Selecionado: {selectedLead.name ?? '(sem nome)'} {selectedLead.phone ? `· ${selectedLead.phone}` : ''}
              </span>
              <button
                onClick={() => setSelectedLead(null)}
                className="text-emerald-300 hover:text-white"
                aria-label="Remover seleção"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {leadResults !== null && !selectedLead && (
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {leadResults.length === 0 ? (
                <p className="text-xs text-slate-500">Nenhum lead encontrado.</p>
              ) : (
                leadResults.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => {
                      setSelectedLead(l)
                      setLeadResults(null)
                    }}
                    className="w-full text-left rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 hover:bg-white/[0.06] transition"
                  >
                    <span className="text-sm text-slate-200">{l.name ?? '(sem nome)'}</span>
                    {l.phone && <span className="text-xs text-slate-500 ml-2">{l.phone}</span>}
                    <span className="block text-[11px] text-slate-500">{l.status ?? ''}</span>
                  </button>
                ))
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              type="datetime-local"
              value={newDateTime}
              onChange={(e) => setNewDateTime(e.target.value)}
              className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
            />
            <select
              value={durationMin}
              onChange={(e) => setDurationMin(Number(e.target.value))}
              className="rounded-lg border border-white/10 bg-black/30 px-2 py-2 text-xs text-slate-200 outline-none focus:border-indigo-500"
            >
              {DURATION_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o} min
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => void doCreate()}
            disabled={!selectedLead || busy === 'create'}
            className="w-full rounded-lg bg-indigo-500 text-white py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy === 'create' ? 'Agendando…' : 'Agendar reunião'}
          </button>
        </div>
      )}

      {meetings.length === 0 ? (
        <p className="text-sm text-slate-500 text-center py-10">
          Nenhuma reunião agendada. Toque em "Nova" para marcar uma reunião ou aguarde o Agente IA agendar —
          ela aparece aqui e dispara o alarme no celular.
        </p>
      ) : (
        <div className="space-y-3">
          {meetings.map((m) => {
            const reminderMin = reminder?.perLead[m.id] ?? reminder?.defaultMinutes ?? 30
            const isRescheduling = rescheduleFor === m.id
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

                {isRescheduling && (
                  <div className="mt-3 rounded-lg border border-indigo-500/30 bg-indigo-500/[0.06] p-3 space-y-2">
                    <label className="text-[11px] text-slate-400 block">Novo horário</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="datetime-local"
                        value={reschedDateTime}
                        onChange={(e) => setReschedDateTime(e.target.value)}
                        className="flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
                      />
                      <button
                        onClick={() => void doReschedule(m)}
                        disabled={busy === `resched:${m.id}`}
                        className="rounded-lg bg-indigo-500 text-white px-3 py-2 text-xs font-medium disabled:opacity-50"
                      >
                        {busy === `resched:${m.id}` ? '…' : 'Salvar'}
                      </button>
                      <button
                        onClick={() => setRescheduleFor(null)}
                        className="p-2 rounded-lg bg-white/5 text-slate-400"
                        aria-label="Cancelar reagendamento"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-3 flex items-center gap-2 flex-wrap">
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

                  <span className="mx-1 h-4 w-px bg-white/10" />

                  <button
                    onClick={() => {
                      if (isRescheduling) setRescheduleFor(null)
                      else {
                        setReschedDateTime(defaultDateTimeLocal())
                        setRescheduleFor(m.id)
                      }
                    }}
                    className="text-[11px] px-2 py-1 rounded-md bg-white/5 text-slate-300 hover:bg-white/10"
                  >
                    Reagendar
                  </button>
                  <button
                    onClick={() => void doRealize(m)}
                    disabled={busy === `realize:${m.id}`}
                    className="text-[11px] px-2 py-1 rounded-md bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50"
                  >
                    <span className="inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" />
                      Realizada
                    </span>
                  </button>
                  <button
                    onClick={() => void doCancel(m)}
                    disabled={busy === `cancel:${m.id}`}
                    className="text-[11px] px-2 py-1 rounded-md bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 disabled:opacity-50"
                  >
                    <span className="inline-flex items-center gap-1">
                      <Trash2 className="w-3 h-3" />
                      Cancelar
                    </span>
                  </button>
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
