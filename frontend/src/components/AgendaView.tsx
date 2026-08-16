import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { supabase, type Lead } from '../lib/supabase'
import { Button } from './ui'
import { agenda, type AgendaBlock, type AgendaMeeting, type AgendaSettings, type AvailableSlot, type WeeklySlot } from '../lib/agenda'
import { buildMonthCells, monthTitle, addMonths, DAY_SHORT, saLocalDay, saLocalTime, humanDate } from '../lib/month'

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isFinite(h) && Number.isFinite(m)) return h * 60 + m
  return 0
}

function toMinStr(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

function localToIso(local: string): string {
  return new Date(`${local}:00-03:00`).toISOString()
}

function isoToLocal(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  return `${saLocalDay(ms)}T${saLocalTime(ms)}`
}

function meetingTimeLabel(m: AgendaMeeting): string {
  if (!m.meeting_at) return 'Sem horário definido'
  const ms = Date.parse(m.meeting_at)
  if (Number.isNaN(ms)) return 'Sem horário definido'
  return `${saLocalDay(ms).slice(8, 10)}/${saLocalDay(ms).slice(5, 7)} · ${saLocalTime(ms)}`
}

function effectiveStatus(m: AgendaMeeting): string {
  if (m.meeting_outcome === 'realizada') return 'realizada'
  return m.status
}

const STATUS_STYLE: Record<string, string> = {
  reuniao_marcada: 'bg-sky-500/15 text-sky-300',
  reuniao_cancelada: 'bg-rose-500/15 text-rose-300',
  realizada: 'bg-emerald-500/15 text-emerald-300',
}

const STATUS_LABEL: Record<string, string> = {
  reuniao_marcada: 'Marcada',
  reuniao_cancelada: 'Cancelada',
  realizada: 'Realizada',
}

interface MonthAnchor {
  year: number
  month0: number
}

function anchorFromNow(): MonthAnchor {
  const nowMs = Date.now()
  const d = new Date(nowMs + -3 * 3600_000)
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth() }
}

export function AgendaView() {
  const navigate = useNavigate()
  const [anchor, setAnchor] = useState<MonthAnchor>(() => anchorFromNow())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const [settings, setSettings] = useState<AgendaSettings>({
    duration_min: 30,
    gap_min: 15,
    future_days: 7,
    timezone: 'America/Sao_Paulo',
  })
  const [weekly, setWeekly] = useState<WeeklySlot[]>([])
  const [blocks, setBlocks] = useState<AgendaBlock[]>([])
  const [meetings, setMeetings] = useState<AgendaMeeting[]>([])
  const [available, setAvailable] = useState<AvailableSlot[]>([])
  const [leads, setLeads] = useState<Lead[]>([])

  // Formulário de bloqueio
  const [blockStart, setBlockStart] = useState('')
  const [blockEnd, setBlockEnd] = useState('')
  const [blockReason, setBlockReason] = useState('')

  const cells = useMemo(() => buildMonthCells(anchor.year, anchor.month0), [anchor])
  const range = useMemo(() => ({ start: cells[0].key, end: cells[41].key }), [cells])
  const todayKey = useMemo(() => saLocalDay(Date.now()), [])
  const isConfigured = weekly.length > 0

  const [dayModal, setDayModal] = useState<string | null>(null)
  const [meetingModal, setMeetingModal] = useState<
    | { mode: 'create'; dateKey: string }
    | { mode: 'edit'; meeting: AgendaMeeting }
    | null
  >(null)

  const meetingsByDay = useMemo(() => {
    const map = new Map<string, AgendaMeeting[]>()
    for (const m of meetings) {
      if (!m.meeting_at) continue
      const ms = Date.parse(m.meeting_at)
      if (Number.isNaN(ms)) continue
      const key = saLocalDay(ms)
      const arr = map.get(key) ?? []
      arr.push(m)
      map.set(key, arr)
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => Date.parse(a.meeting_at ?? '') - Date.parse(b.meeting_at ?? ''))
    }
    return map
  }, [meetings])

  const undatedMeetings = useMemo(() => meetings.filter((m) => !m.meeting_at), [meetings])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [data, slotsRes] = await Promise.all([
        agenda.getData(range.start, range.end),
        agenda.getSlots({ start: range.start, end: range.end }),
      ])
      setSettings(data.settings)
      setWeekly(data.slots)
      setBlocks(data.blocks)
      setMeetings(data.meetings)
      setAvailable(slotsRes.slots)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao carregar a agenda.')
    } finally {
      setLoading(false)
    }
  }, [range])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let alive = true
    supabase
      .from('leads')
      .select('id,name,phone,status')
      .order('name')
      .limit(1000)
      .then(({ data, error }) => {
        if (alive && !error && data) setLeads(data as Lead[])
      })
    return () => {
      alive = false
    }
  }, [])

  async function saveSettings(patch: Partial<AgendaSettings>) {
    setBusy(true)
    setError('')
    try {
      const r = await agenda.saveSettings(patch)
      setSettings(r.settings)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar configuração.')
    } finally {
      setBusy(false)
    }
  }

  async function saveWeekly() {
    setBusy(true)
    setError('')
    try {
      const r = await agenda.saveSlots(weekly)
      setWeekly(r.slots)
      void load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar a semana.')
    } finally {
      setBusy(false)
    }
  }

  function toggleDay(day: number) {
    setWeekly((prev) => {
      const idx = prev.findIndex((s) => s.day === day)
      if (idx >= 0) return prev.filter((s) => s.day !== day)
      return [...prev, { day, start: 9 * 60, end: 18 * 60 }].sort((a, b) => a.day - b.day)
    })
  }

  function patchDay(day: number, patch: Partial<Pick<WeeklySlot, 'start' | 'end'>>) {
    setWeekly((prev) =>
      prev.map((s) => (s.day === day ? { ...s, ...patch } : s)),
    )
  }

  async function addBlock() {
    if (!blockStart || !blockEnd) {
      setError('Informe início e fim do bloqueio.')
      return
    }
    const startIso = new Date(`${blockStart}T00:00:00-03:00`).toISOString()
    const endIso = new Date(`${blockEnd}T23:59:59-03:00`).toISOString()
    if (new Date(endIso) <= new Date(startIso)) {
      setError('O fim deve ser depois do início.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const r = await agenda.addBlock({
        start_at: startIso,
        end_at: endIso,
        reason: blockReason.trim() || undefined,
      })
      setBlocks((prev) => [...prev, r.block])
      setBlockStart('')
      setBlockEnd('')
      setBlockReason('')
      void load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao criar bloqueio.')
    } finally {
      setBusy(false)
    }
  }

  async function removeBlock(id: string) {
    setBusy(true)
    setError('')
    try {
      await agenda.removeBlock(id)
      setBlocks((prev) => prev.filter((b) => b.id !== id))
      void load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao remover bloqueio.')
    } finally {
      setBusy(false)
    }
  }

  async function cancelMeeting(m: AgendaMeeting) {
    if (!window.confirm(`Cancelar a reunião de ${m.name ?? m.leadId}?`)) return
    setBusy(true)
    setError('')
    try {
      const r = await agenda.cancel(m.leadId)
      if (!r.ok) setError(r.message ?? 'Falha ao cancelar.')
      setDayModal(null)
      setMeetingModal(null)
      void load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao cancelar.')
    } finally {
      setBusy(false)
    }
  }

  async function realized(m: AgendaMeeting) {
    setBusy(true)
    setError('')
    try {
      const r = await agenda.realized(m.leadId)
      if (!r.ok) setError(r.message ?? 'Falha ao atualizar.')
      void load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao atualizar.')
    } finally {
      setBusy(false)
    }
  }

  const panel = 'rounded-xl border border-line-2 bg-subtle p-4'
  const input =
    'bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500'
  const btnPrimary =
    'px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-xl font-medium'

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <CalendarDays className="w-5 h-5 text-indigo-400" />
            <h1 className="text-lg font-semibold">Agenda de reuniões</h1>
          </div>
          <div className="flex items-center gap-1 ml-auto">
            <button
              onClick={() => setAnchor((a) => addMonths(a.year, a.month0, -1))}
              className="p-2 rounded-xl border border-line-2 hover:bg-subtle text-secondary"
              aria-label="Mês anterior"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-3 py-1.5 text-sm text-secondary border border-line-2 rounded-xl min-w-40 text-center">
              {monthTitle(anchor.year, anchor.month0)}
            </span>
            <button
              onClick={() => setAnchor((a) => addMonths(a.year, a.month0, 1))}
              className="p-2 rounded-xl border border-line-2 hover:bg-subtle text-secondary"
              aria-label="Próximo mês"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => setAnchor(anchorFromNow())}
              className="p-2 rounded-xl border border-line-2 hover:bg-subtle text-secondary"
              title="Voltar para este mês"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
            <Button
              onClick={() => setMeetingModal({ mode: 'create', dateKey: todayKey })}
              className="flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              Nova reunião
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300 text-sm px-4 py-3">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Carregando agenda...
          </div>
        ) : (
          <>
            {/* Calendário mensal */}
            <div className={panel}>
              <div className="grid grid-cols-7 gap-px bg-line-2 rounded-xl overflow-hidden border border-line-2">
                {DAY_SHORT.map((d) => (
                  <div
                    key={d}
                    className="bg-subtle px-2 py-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-muted"
                  >
                    {d}
                  </div>
                ))}
                {cells.map((cell) => {
                  const dayMeetings = meetingsByDay.get(cell.key) ?? []
                  const isToday = cell.key === todayKey
                   const count = dayMeetings.length
                  return (
                    <button
                      key={cell.key}
                      onClick={() => setDayModal(cell.key)}
                      className={`min-h-20 p-1.5 text-left align-top transition hover:bg-subtle-2 ${
                        cell.inMonth ? 'bg-subtle' : 'bg-subtle-2/60'
                      }`}
                    >
                      <div className="flex items-center justify-between px-0.5">
                        <span
                          className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs ${
                            isToday
                              ? 'bg-accent-600 text-white font-semibold'
                              : cell.inMonth
                                ? 'text-fg'
                                : 'text-faint'
                          }`}
                        >
                          {cell.day}
                        </span>
                        {isToday && (
                          <span className="text-[9px] font-semibold text-accent-300">Hoje</span>
                        )}
                      </div>
                      <div
                        className={`mt-1 px-1 text-[10px] leading-tight ${
                          count > 0 ? 'text-accent-300 font-medium' : 'text-faint'
                        }`}
                      >
                        {count > 0 ? `${count} reunião${count > 1 ? 'ões' : ''}` : 'Nenhuma reunião'}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Reuniões sem horário definido */}
            {undatedMeetings.length > 0 && (
              <div className={panel}>
                <div className="text-sm font-medium mb-3">
                  Reuniões sem horário definido ({undatedMeetings.length})
                </div>
                <ul className="space-y-2">
                  {undatedMeetings.map((m) => (
                    <li key={m.leadId} className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-sm">
                      <span className="text-fg flex-1 min-w-40">
                        {m.name ?? 'Lead ' + m.leadId}
                        {m.phone && <span className="text-faint ml-2 text-xs">{m.phone}</span>}
                      </span>
                      <span className="text-xs text-amber-300">Sem horário definido</span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setMeetingModal({ mode: 'edit', meeting: m })}
                          className="text-[11px] px-2 py-1 rounded-md border border-line text-secondary hover:bg-subtle-2"
                        >
                          Definir horário
                        </button>
                        <button
                          onClick={() => cancelMeeting(m)}
                          className="text-[11px] px-2 py-1 rounded-md border border-rose-500/30 text-rose-300 hover:bg-rose-500/10"
                        >
                          Cancelar
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Configuração global */}
            <div className={panel}>
              <div className="flex items-center gap-2 mb-3">
                <Clock className="w-4 h-4 text-indigo-400" />
                <div className="text-sm font-medium">Configuração</div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="text-xs text-muted">
                  Duração (min)
                  <input
                    type="number"
                    min={10}
                    step={5}
                    value={settings.duration_min}
                    onChange={(e) => saveSettings({ duration_min: Number(e.target.value) || settings.duration_min })}
                    className={`${input} w-full mt-1`}
                  />
                </label>
                <label className="text-xs text-muted">
                  Intervalo entre reuniões (min)
                  <input
                    type="number"
                    min={0}
                    step={5}
                    value={settings.gap_min}
                    onChange={(e) => saveSettings({ gap_min: Number(e.target.value) || 0 })}
                    className={`${input} w-full mt-1`}
                  />
                </label>
                <label className="text-xs text-muted">
                  Dias consultados à frente
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={settings.future_days}
                    onChange={(e) => saveSettings({ future_days: Number(e.target.value) || 1 })}
                    className={`${input} w-full mt-1`}
                  />
                </label>
              </div>
              <p className="text-[11px] text-faint mt-2">
                A IA só oferece horários dentro das janelas abaixo e respeitando estes parâmetros.
              </p>
            </div>

            {/* Janelas semanais */}
            <div className={panel}>
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-medium">Disponibilidade semanal</div>
                <button onClick={saveWeekly} disabled={busy} className={btnPrimary}>
                  {busy ? 'Salvando...' : 'Salvar semana'}
                </button>
              </div>
              <div className="space-y-1.5">
                {['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'].map((label, day) => {
                  const slot = weekly.find((s) => s.day === day)
                  return (
                    <div
                      key={day}
                      className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-3 py-2"
                    >
                      <button
                        onClick={() => toggleDay(day)}
                        className={`w-5 h-5 rounded-md border flex items-center justify-center transition ${
                          slot
                            ? 'bg-indigo-600 border-indigo-500 text-white'
                            : 'border-line-strong text-transparent hover:border-indigo-400'
                        }`}
                        aria-label={slot ? `Desativar ${label}` : `Ativar ${label}`}
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <span className={`text-sm w-20 ${slot ? 'text-fg' : 'text-faint'}`}>{label}</span>
                      {slot ? (
                        <>
                          <input
                            type="time"
                            value={toMinStr(slot.start)}
                            onChange={(e) => patchDay(day, { start: toMin(e.target.value) })}
                            className={`${input} w-32`}
                          />
                          <span className="text-faint text-sm">até</span>
                          <input
                            type="time"
                            value={toMinStr(slot.end)}
                            onChange={(e) => patchDay(day, { end: toMin(e.target.value) })}
                            className={`${input} w-32`}
                          />
                        </>
                      ) : (
                        <span className="text-xs text-slate-600">Indisponível</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Bloqueios */}
            <div className={panel}>
              <div className="text-sm font-medium mb-3">Bloqueios (feriados, ausências)</div>
              <div className="grid grid-cols-1 sm:grid-cols-[auto_auto_1fr_auto] gap-2 items-center mb-3">
                <label className="text-xs text-muted">
                  De
                  <input type="date" value={blockStart} onChange={(e) => setBlockStart(e.target.value)} className={`${input} w-40 ml-1`} />
                </label>
                <label className="text-xs text-muted">
                  Até
                  <input type="date" value={blockEnd} onChange={(e) => setBlockEnd(e.target.value)} className={`${input} w-40 ml-1`} />
                </label>
                <input
                  value={blockReason}
                  onChange={(e) => setBlockReason(e.target.value)}
                  placeholder="Motivo (opcional)"
                  className={`${input} w-full`}
                />
                <button onClick={addBlock} disabled={busy} className={`${btnPrimary} flex items-center gap-1.5`}>
                  <Plus className="w-4 h-4" />
                  Bloquear
                </button>
              </div>
              {blocks.length === 0 ? (
                <p className="text-xs text-slate-600">Nenhum bloqueio ativo.</p>
              ) : (
                <ul className="space-y-1.5">
                  {blocks.map((b) => (
                    <li key={b.id} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2 text-sm">
                      <span className="text-secondary">
                        {humanDate(b.start_at.slice(0, 10))} – {humanDate(b.end_at.slice(0, 10))}
                      </span>
                      {b.reason && <span className="text-faint">{b.reason}</span>}
                      <button
                        onClick={() => removeBlock(b.id)}
                        className="ml-auto text-faint hover:text-rose-400"
                        aria-label="Remover bloqueio"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Horários disponíveis no mês */}
            <div className={panel}>
              <div className="text-sm font-medium mb-3">
                Horários disponíveis ({available.length} no período)
              </div>
              {!isConfigured ? (
                <p className="text-xs text-amber-400">
                  Configure ao menos um dia na disponibilidade semanal para gerar horários.
                </p>
              ) : available.length === 0 ? (
                <p className="text-xs text-slate-600">Nenhum horário livre na janela consultada.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
                  {available.slice(0, 24).map((s) => (
                    <div
                      key={s.start}
                      className="rounded-xl border border-line bg-subtle-2 px-2 py-1.5 text-xs text-secondary"
                    >
                      <span className="text-muted">{humanDate(s.day)}</span> ·{' '}
                      <span className="text-accent-300">{s.time}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {dayModal && (
        <DayModal
          dateKey={dayModal}
          meetings={meetingsByDay.get(dayModal) ?? []}
          onClose={() => setDayModal(null)}
          onCreate={() => setMeetingModal({ mode: 'create', dateKey: dayModal })}
          onEdit={(m) => setMeetingModal({ mode: 'edit', meeting: m })}
          onRealized={realized}
          onCancel={cancelMeeting}
          onOpenLead={(leadId) => navigate(`/leads?focus=${encodeURIComponent(leadId)}`)}
        />
      )}

      {meetingModal && (
        <MeetingModal
          mode={meetingModal.mode}
          dateKey={meetingModal.mode === 'create' ? meetingModal.dateKey : undefined}
          meeting={meetingModal.mode === 'edit' ? meetingModal.meeting : undefined}
          leads={leads}
          busy={busy}
          onClose={() => setMeetingModal(null)}
          onSaved={() => {
            setMeetingModal(null)
            setDayModal(null)
            void load()
          }}
        />
      )}
    </div>
  )
}

function DayModal({
  dateKey,
  meetings,
  onClose,
  onCreate,
  onEdit,
  onRealized,
  onCancel,
  onOpenLead,
}: {
  dateKey: string
  meetings: AgendaMeeting[]
  onClose: () => void
  onCreate: () => void
  onEdit: (m: AgendaMeeting) => void
  onRealized: (m: AgendaMeeting) => void
  onCancel: (m: AgendaMeeting) => void
  onOpenLead: (leadId: string) => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-line-2 bg-panel p-5 shadow-2xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="font-semibold">{humanDate(dateKey)}</div>
            <div className="text-xs text-muted">
              {meetings.length > 0
                ? `${meetings.length} reunião${meetings.length > 1 ? 'ões' : ''}`
                : 'Nenhuma reunião'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={onCreate}
              size="sm"
              className="inline-flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Nova
            </Button>
            <button onClick={onClose} className="text-muted hover:text-fg text-xl leading-none">
              ×
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2">
          {meetings.length === 0 && (
            <p className="text-sm text-faint border border-dashed border-line-2 rounded-xl px-4 py-8 text-center">
              Nenhuma reunião neste dia. Clique em "Nova" para agendar.
            </p>
          )}
          {meetings.map((m) => {
            const st = effectiveStatus(m)
            return (
              <div key={m.leadId} className="rounded-xl border border-line px-3 py-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-fg">{m.name ?? 'Lead ' + m.leadId}</span>
                  {m.phone && <span className="text-xs text-faint">{m.phone}</span>}
                  <span className={`ml-auto px-2 py-0.5 rounded text-[11px] font-medium ${STATUS_STYLE[st] ?? STATUS_STYLE.reuniao_marcada}`}>
                    {STATUS_LABEL[st] ?? m.status}
                  </span>
                </div>
                <div className="text-xs text-muted mt-1">{meetingTimeLabel(m)}</div>
                {m.meeting_notes && <div className="text-xs text-faint mt-1">{m.meeting_notes}</div>}
                {m.meeting_outcome === 'realizada' && m.meeting_outcome && (
                  <div className="text-[11px] text-emerald-300 mt-1">✓ Reunião realizada</div>
                )}
                <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                  <Button variant="secondary" size="sm" onClick={() => onOpenLead(m.leadId)}>
                    <ExternalLink className="w-3 h-3" />
                    Abrir lead
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => onEdit(m)}>
                    <Pencil className="w-3 h-3" />
                    Editar
                  </Button>
                  {st === 'reuniao_marcada' && (
                    <>
                      <Button size="sm" onClick={() => onRealized(m)}>
                        Realizada
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => onCancel(m)}>
                        Cancelar
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function MeetingModal({
  mode,
  dateKey,
  meeting,
  leads,
  busy,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit'
  dateKey?: string
  meeting?: AgendaMeeting
  leads: Lead[]
  busy: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [leadId, setLeadId] = useState<string>(meeting?.leadId ?? '')
  const [local, setLocal] = useState<string>(() =>
    meeting?.meeting_at ? isoToLocal(meeting.meeting_at) : `${dateKey}T09:00`,
  )
  const [durationMin, setDurationMin] = useState<number>(meeting?.durationMin ?? 30)
  const [notes, setNotes] = useState<string>(meeting?.meeting_notes ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit() {
    setError('')
    if (!leadId) {
      setError('Selecione o lead da reunião.')
      return
    }
    if (!local) {
      setError('Informe a data e o horário.')
      return
    }
    const startIso = localToIso(local)
    setSaving(true)
    try {
      if (mode === 'edit' && meeting && meeting.meeting_at && isoToLocal(meeting.meeting_at) === local) {
        // Só notas/duração: não revalida disponibilidade (mesmo horário).
        const r = await agenda.edit({ leadId, notes, durationMin })
        if (!r.ok) {
          setError(r.message ?? 'Falha ao atualizar.')
          setSaving(false)
          return
        }
      } else {
        const r = await agenda.reserve({ leadId, startIso, notes, durationMin })
        if (!r.ok) {
          const suggestions = (r.suggestions ?? []).join(', ')
          setError(r.message + (suggestions ? ` Horários alternativos: ${suggestions}.` : ''))
          setSaving(false)
          return
        }
      }
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Falha ao salvar a reunião.')
    } finally {
      setSaving(false)
    }
  }

  const todayLocal = `${saLocalDay(Date.now())}T00:00`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-line-2 bg-panel p-5 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <div className="font-semibold">
            {mode === 'create' ? 'Nova reunião' : 'Editar reunião'}
          </div>
          <button onClick={onClose} className="text-muted hover:text-fg text-xl leading-none">
            ×
          </button>
        </div>

        <div className="space-y-3">
          <label className="block text-xs text-muted">
            Lead
            <select
              value={leadId}
              onChange={(e) => setLeadId(e.target.value)}
              className="mt-1 w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500"
            >
              <option value="">Selecione o lead...</option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name || 'Sem nome'}
                  {l.phone ? ` — ${l.phone}` : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs text-muted">
            Data e horário (America/Sao_Paulo)
            <input
              type="datetime-local"
              value={local}
              min={todayLocal}
              onChange={(e) => setLocal(e.target.value)}
              className="mt-1 w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500"
            />
          </label>

          <label className="block text-xs text-muted">
            Duração (min)
            <input
              type="number"
              min={10}
              step={5}
              value={durationMin}
              onChange={(e) => setDurationMin(Number(e.target.value) || 30)}
              className="mt-1 w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500"
            />
          </label>

          <label className="block text-xs text-muted">
            Observações
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Assunto da reunião, contato, etc."
              className="mt-1 w-full bg-field border border-line-2 rounded-xl px-3 py-2 text-sm outline-none focus:border-accent-500 resize-y"
            />
          </label>

          {error && (
            <div className="text-sm text-rose-300 bg-rose-500/10 border border-rose-500/20 rounded-xl px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={saving || busy}
              loading={saving}
            >
              {saving ? 'Salvando...' : mode === 'create' ? 'Agendar' : 'Salvar'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
