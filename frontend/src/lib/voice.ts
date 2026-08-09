import { supabase, type Lead } from './supabase'

// =====================================================================
// Notificações de voz (narrações ElevenLabs) no navegador/desktop.
//   - Áudios servidos de /audio/<file> (frontend/public/audio)
//   - Toggles por notificação persistidos em localStorage (chave voz_*,
//     mesma convenção do app mobile, para comportamento consistente).
//   - Eventos realtime (exigem aba aberta) + lembrete de reunião por
//     timer quando o meeting_at estiver próximo.
// =====================================================================

export interface VoiceEvent {
  key: string
  label: string
  file: string
  kind: 'alarme' | 'evento'
}

export const VOICE_EVENTS: VoiceEvent[] = [
  { key: 'reuniao_30min', label: 'Reunião em 30 min', file: 'reuniao_30min.mp3', kind: 'alarme' },
  { key: 'reuniao_15min', label: 'Reunião em 15 min', file: 'reuniao_15min.mp3', kind: 'alarme' },
  { key: 'reuniao_10min', label: 'Reunião em 10 min', file: 'reuniao_10min.mp3', kind: 'alarme' },
  { key: 'reuniao_5min', label: 'Reunião em 5 min', file: 'reuniao_5min.mp3', kind: 'alarme' },
  { key: 'reuniao_1min', label: 'Reunião em 1 min', file: 'reuniao_1min.mp3', kind: 'alarme' },

  { key: 'reuniao_marcada', label: 'Nova reunião agendada', file: 'reuniao_marcada.mp3', kind: 'evento' },
  { key: 'reuniao_cancelada', label: 'Reunião cancelada', file: 'reuniao_cancelada.mp3', kind: 'evento' },
  { key: 'reuniao_reagendada', label: 'Reunião reagendada', file: 'reuniao_reagendada.mp3', kind: 'evento' },
  { key: 'campanha_iniciada', label: 'Campanha iniciada', file: 'campanha_iniciada.mp3', kind: 'evento' },
  { key: 'campanha_concluida', label: 'Campanha concluída', file: 'campanha_concluida.mp3', kind: 'evento' },
  { key: 'campanha_atencao', label: 'Campanha precisa de atenção', file: 'campanha_atencao.mp3', kind: 'evento' },
  { key: 'lead_atencao', label: 'Lead precisa de atenção', file: 'lead_atencao.mp3', kind: 'evento' },
  { key: 'whatsapp_desconectado', label: 'WhatsApp desconectado', file: 'whatsapp_desconectado.mp3', kind: 'evento' },
  { key: 'resumo_diario', label: 'Resumo diário', file: 'resumo_diario.mp3', kind: 'evento' },
]

export const VOICE_MAP: Record<string, VoiceEvent> = Object.fromEntries(
  VOICE_EVENTS.map((v) => [v.key, v]),
)

const STORAGE_KEY = 'vyntra-voice-prefs'

type VoicePrefs = Record<string, boolean>

function loadPrefs(): VoicePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as VoicePrefs
      const out: VoicePrefs = {}
      for (const v of VOICE_EVENTS) {
        out[`voz_${v.key}`] = parsed[`voz_${v.key}`] ?? true
      }
      return out
    }
  } catch {
    /* ignore */
  }
  const out: VoicePrefs = {}
  for (const v of VOICE_EVENTS) out[`voz_${v.key}`] = true
  return out
}

function savePrefs(prefs: VoicePrefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    /* ignore */
  }
}

export function loadVoicePrefs(): VoicePrefs {
  return loadPrefs()
}

export function setVoicePref(key: string, on: boolean): VoicePrefs {
  const prefs = loadPrefs()
  prefs[`voz_${key}`] = on
  savePrefs(prefs)
  return prefs
}

function isVoiceOn(key: string): boolean {
  return loadPrefs()[`voz_${key}`] ?? true
}

/** Toca a narração se o toggle correspondente estiver ativo. */
export function playVoice(key: string): void {
  if (!isVoiceOn(key)) return
  const file = VOICE_MAP[key]?.file
  if (!file) return
  const audio = new Audio(`/audio/${file}`)
  void audio.play().catch(() => {
    /* navegador pode bloquear autoplay sem interação */
  })
}

type Row = Record<string, unknown>
type Handler = (payload: {
  eventType: string
  new: Row | null
  old: Row | null
}) => void

function eventKey(payload: {
  eventType: string
  new: Row | null
  old: Row | null
}): string | null {
  const { eventType: type, old: oldRow, new: newRow } = payload
  const next = newRow ?? {}
  const prev = oldRow ?? {}

  if (type === 'INSERT' || type === 'UPDATE') {
    const status = String(next.status ?? '')
    const prevStatus = String(prev.status ?? '')
    const nextMeeting = String(next.meeting_at ?? '')
    const prevMeeting = String(prev.meeting_at ?? '')

    if (status === 'reuniao_marcada' && prevStatus !== 'reuniao_marcada') return 'reuniao_marcada'
    if (status === 'reuniao_cancelada') return 'reuniao_cancelada'
    if (
      status === 'reuniao_marcada' &&
      prevStatus === 'reuniao_marcada' &&
      nextMeeting &&
      nextMeeting !== prevMeeting
    ) {
      return 'reuniao_reagendada'
    }
  }

  if (type === 'INSERT') {
    const role = String(next.role ?? '')
    if (role === 'user') return 'lead_atencao'
  }

  return null
}

function listen(
  table: string,
  channelName: string,
  handler: Handler,
): () => void {
  const ch = supabase
    .channel(channelName)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table },
      (payload) => {
        handler({
          eventType: payload.eventType,
          new: (payload.new as Row | null) ?? null,
          old: (payload.old as Row | null) ?? null,
        })
      },
    )
    .subscribe()
  return () => {
    supabase.removeChannel(ch)
  }
}

/** Ativa o reprodutor de voz no navegador. Retorna o cleanup. */
export function subscribeVoiceNotifications(): () => void {
  const cleanups: Array<() => void> = []

  cleanups.push(
    listen('leads', 'voice-leads', (p) => {
      const key = eventKey(p)
      if (key) playVoice(key)
    }),
  )

  cleanups.push(
    listen('consecom_conversations', 'voice-conversations', (p) => {
      const key = eventKey(p)
      if (key) playVoice(key)
    }),
  )

  cleanups.push(
    listen('campaigns', 'voice-campaigns', (p) => {
      const status = String(p.new?.status ?? '')
      const prev = String(p.old?.status ?? '')
      if (status === 'em_progresso' && prev !== 'em_progresso') playVoice('campanha_iniciada')
      else if (status === 'finalizada' && prev !== 'finalizada') playVoice('campanha_concluida')
    }),
  )

  cleanups.push(
    listen('whatsapp_connections', 'voice-connections', (p) => {
      const status = String(p.new?.status ?? '')
      const prev = String(p.old?.status ?? '')
      if (status !== 'connected' && prev === 'connected') playVoice('whatsapp_desconectado')
    }),
  )

  return () => {
    cleanups.forEach((fn) => fn())
  }
}

// =====================================================================
// Lembrete de reunião no navegador (timer): toca a narração X min antes.
// =====================================================================

const REMINDER_MINUTES = 5
const REMINDER_VOICE: Record<number, string> = {
  30: 'reuniao_30min',
  15: 'reuniao_15min',
  10: 'reuniao_10min',
  5: 'reuniao_5min',
  1: 'reuniao_1min',
}

let reminderTimers: Array<ReturnType<typeof setTimeout>> = []

/** Agendado timers de lembrete para os meetings futuros (enquanto a aba estiver aberta). */
export function scheduleMeetingReminders(leads: Lead[]): void {
  reminderTimers.forEach(clearTimeout)
  reminderTimers = []

  const now = Date.now()
  for (const lead of leads) {
    if (lead.status !== 'reuniao_marcada' || !lead.meeting_at) continue
    const meetingAt = new Date(lead.meeting_at).getTime()
    if (!Number.isFinite(meetingAt)) continue

    const fireAt = meetingAt - REMINDER_MINUTES * 60_000
    if (fireAt <= now || fireAt - now > 24 * 60 * 60_000) continue

    const voiceKey = REMINDER_VOICE[REMINDER_MINUTES]
    if (!voiceKey) continue

    const timer = setTimeout(() => {
      playVoice(voiceKey)
    }, fireAt - now)
    reminderTimers.push(timer)
  }
}
