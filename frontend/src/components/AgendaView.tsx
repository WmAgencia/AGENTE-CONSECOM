import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { agenda, type AgendaBlock, type AgendaMeeting, type AgendaSettings, type AvailableSlot, type WeeklySlot } from '../lib/agenda'

const DAY_LABELS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
const DAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

function fmtDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${dd}`
}

function weekRange(anchor: Date): { start: string; end: string } {
  const dow = anchor.getDay()
  const monday = new Date(anchor)
  monday.setDate(anchor.getDate() - ((dow + 6) % 7))
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  return { start: fmtDate(monday), end: fmtDate(sunday) }
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isFinite(h) && Number.isFinite(m)) return h * 60 + m
  return 0
}

function toMinStr(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

function humanDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return iso
  return `${d} ${MONTHS[m - 1]} ${y}`
}

function meetingLabel(m: AgendaMeeting): string {
  if (m.meeting_at) {
    const dt = new Date(m.meeting_at)
    const day = DAY_SHORT[dt.getDay()]
    const hh = String(dt.getHours()).padStart(2, '0')
    const mm = String(dt.getMinutes()).padStart(2, '0')
    return `${day}, ${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')} ${hh}:${mm}`
  }
  return 'Sem horário definido'
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

export function AgendaView() {
  const [anchor, setAnchor] = useState<Date>(() => new Date())
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

  // Formulário de bloqueio
  const [blockStart, setBlockStart] = useState('')
  const [blockEnd, setBlockEnd] = useState('')
  const [blockReason, setBlockReason] = useState('')

  const range = useMemo(() => weekRange(anchor), [anchor])
  const isConfigured = weekly.length > 0

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

  const panel = 'rounded-xl border border-white/10 bg-white/[0.02] p-4'
  const input =
    'bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500'
  const btnPrimary =
    'px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg font-medium'

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <CalendarDays className="w-5 h-5 text-indigo-400" />
            <h1 className="text-lg font-semibold">Agenda de reuniões</h1>
          </div>
          <div className="flex items-center gap-1 ml-auto">
            <button
              onClick={() => setAnchor((a) => new Date(a.getFullYear(), a.getMonth(), a.getDate() - 7))}
              className="p-2 rounded-lg border border-white/10 hover:bg-white/5 text-slate-300"
              aria-label="Semana anterior"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-3 py-1.5 text-sm text-slate-300 border border-white/10 rounded-lg">
              {humanDate(range.start)} – {humanDate(range.end)}
            </span>
            <button
              onClick={() => setAnchor((a) => new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7))}
              className="p-2 rounded-lg border border-white/10 hover:bg-white/5 text-slate-300"
              aria-label="Próxima semana"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
            <button
              onClick={() => setAnchor(new Date())}
              className="p-2 rounded-lg border border-white/10 hover:bg-white/5 text-slate-300"
              title="Voltar para esta semana"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-300 text-sm px-4 py-3">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16 text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Carregando agenda...
          </div>
        ) : (
          <>
            {/* Configuração global */}
            <div className={panel}>
              <div className="flex items-center gap-2 mb-3">
                <Clock className="w-4 h-4 text-indigo-400" />
                <div className="text-sm font-medium">Configuração</div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="text-xs text-slate-400">
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
                <label className="text-xs text-slate-400">
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
                <label className="text-xs text-slate-400">
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
              <p className="text-[11px] text-slate-500 mt-2">
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
                {DAY_LABELS.map((label, day) => {
                  const slot = weekly.find((s) => s.day === day)
                  return (
                    <div
                      key={day}
                      className="flex flex-wrap items-center gap-3 rounded-lg border border-white/5 px-3 py-2"
                    >
                      <button
                        onClick={() => toggleDay(day)}
                        className={`w-5 h-5 rounded-md border flex items-center justify-center transition ${
                          slot
                            ? 'bg-indigo-600 border-indigo-500 text-white'
                            : 'border-white/20 text-transparent hover:border-indigo-400'
                        }`}
                        aria-label={slot ? `Desativar ${label}` : `Ativar ${label}`}
                      >
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <span className={`text-sm w-20 ${slot ? 'text-slate-200' : 'text-slate-500'}`}>{label}</span>
                      {slot ? (
                        <>
                          <input
                            type="time"
                            value={toMinStr(slot.start)}
                            onChange={(e) => patchDay(day, { start: toMin(e.target.value) })}
                            className={`${input} w-32`}
                          />
                          <span className="text-slate-500 text-sm">até</span>
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
                <label className="text-xs text-slate-400">
                  De
                  <input type="date" value={blockStart} onChange={(e) => setBlockStart(e.target.value)} className={`${input} w-40 ml-1`} />
                </label>
                <label className="text-xs text-slate-400">
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
                    <li key={b.id} className="flex items-center gap-3 rounded-lg border border-white/5 px-3 py-2 text-sm">
                      <span className="text-slate-300">
                        {humanDate(b.start_at.slice(0, 10))} – {humanDate(b.end_at.slice(0, 10))}
                      </span>
                      {b.reason && <span className="text-slate-500">{b.reason}</span>}
                      <button
                        onClick={() => removeBlock(b.id)}
                        className="ml-auto text-slate-500 hover:text-rose-400"
                        aria-label="Remover bloqueio"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Reuniões da semana */}
            <div className={panel}>
              <div className="text-sm font-medium mb-3">Reuniões ({meetings.length})</div>
              {meetings.length === 0 ? (
                <p className="text-xs text-slate-600">Nenhuma reunião nesta semana.</p>
              ) : (
                <ul className="space-y-2">
                  {meetings.map((m) => {
                    const st = STATUS_STYLE[m.status] ?? STATUS_STYLE.reuniao_marcada
                    return (
                      <li key={m.leadId} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/5 px-3 py-2.5">
                        <span className="text-sm text-slate-200 flex-1 min-w-40">
                          {m.name ?? 'Lead ' + m.leadId}
                          {m.phone && <span className="text-slate-500 ml-2 text-xs">{m.phone}</span>}
                        </span>
                        <span className="text-xs text-slate-400">{meetingLabel(m)}</span>
                        <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${st}`}>
                          {STATUS_LABEL[m.status] ?? m.status}
                        </span>
                        {m.status === 'reuniao_marcada' && (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => realized(m)}
                              disabled={busy}
                              className="text-[11px] px-2 py-1 rounded-md border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
                            >
                              Realizada
                            </button>
                            <button
                              onClick={() => cancelMeeting(m)}
                              disabled={busy}
                              className="text-[11px] px-2 py-1 rounded-md border border-rose-500/30 text-rose-300 hover:bg-rose-500/10"
                            >
                              Cancelar
                            </button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            {/* Horários disponíveis */}
            <div className={panel}>
              <div className="text-sm font-medium mb-3">
                Horários disponíveis nesta semana ({available.length})
              </div>
              {!isConfigured ? (
                <p className="text-xs text-amber-400">
                  Configure ao menos um dia na disponibilidade semanal para gerar horários.
                </p>
              ) : available.length === 0 ? (
                <p className="text-xs text-slate-600">Nenhum horário livre na janela consultada.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
                  {available.map((s) => (
                    <div
                      key={s.start}
                      className="rounded-lg border border-white/5 bg-black/20 px-2 py-1.5 text-xs text-slate-300"
                    >
                      <span className="text-slate-400">{humanDate(s.day)}</span> ·{' '}
                      <span className="text-indigo-300">{s.time}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
