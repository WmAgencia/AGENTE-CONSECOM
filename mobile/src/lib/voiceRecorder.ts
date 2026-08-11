// =====================================================================
// Máquina de estados pura do gravador de voz (press-and-hold, slide-up
// para travar, cancelar). Sem dependências de plataforma — testável.
// =====================================================================

export type VoicePhase =
  | 'idle'
  | 'recording'
  | 'locked'
  | 'finished'
  | 'cancelled'

export interface VoiceState {
  phase: VoicePhase
  startMs: number
  elapsedMs: number
  slideLocked: boolean
  cancelZone: boolean
  transcript: string
  error?: string
}

export const IDLE_VOICE_STATE: VoiceState = {
  phase: 'idle',
  startMs: 0,
  elapsedMs: 0,
  slideLocked: false,
  cancelZone: false,
  transcript: '',
}

export type VoiceAction =
  | { type: 'press'; now: number }
  | { type: 'release'; now: number }
  | { type: 'slide'; locked: boolean; cancelZone: boolean }
  | { type: 'lock' }
  | { type: 'send' }
  | { type: 'cancel' }
  | { type: 'tick'; now: number }
  | { type: 'transcript'; text: string }
  | { type: 'error'; message: string }

/** Toque rápido (< 250ms) é descartado como toque acidental. */
export const MIN_HOLD_TO_RECORD = 250

export function voiceReducer(state: VoiceState, action: VoiceAction): VoiceState {
  switch (action.type) {
    case 'press':
      return {
        phase: 'recording',
        startMs: action.now,
        elapsedMs: 0,
        slideLocked: false,
        cancelZone: false,
        transcript: '',
        error: undefined,
      }

    case 'tick': {
      if (state.phase !== 'recording' && state.phase !== 'locked') return state
      return { ...state, elapsedMs: Math.max(0, action.now - state.startMs) }
    }

    case 'slide':
      if (state.phase !== 'recording') return state
      return { ...state, slideLocked: action.locked, cancelZone: action.cancelZone }

    case 'lock':
      if (state.phase === 'recording' && state.slideLocked) {
        return { ...state, phase: 'locked' }
      }
      return state

    case 'transcript':
      return { ...state, transcript: action.text }

    case 'error':
      return { ...state, error: action.message }

    case 'release': {
      if (state.phase !== 'recording') return state
      // Já travado: soltar mantém travado (enviar/cancelar explícitos).
      if (state.slideLocked) return { ...state, phase: 'locked' }
      // Arrastou para o lado (zona de cancelar): descarta.
      if (state.cancelZone) return { ...IDLE_VOICE_STATE, phase: 'cancelled' }
      // Toque acidental / gravação menor que o mínimo.
      if (action.now - state.startMs < MIN_HOLD_TO_RECORD) {
        return { ...IDLE_VOICE_STATE, phase: 'cancelled' }
      }
      // Soltou normal: envia.
      return { ...state, phase: 'finished' }
    }

    case 'send':
      if (state.phase === 'locked') return { ...state, phase: 'finished' }
      return state

    case 'cancel':
      return { ...IDLE_VOICE_STATE, phase: 'cancelled' }
  }
}

export type VoiceOutcome = { kind: 'send' } | { kind: 'cancel' } | { kind: 'none' }

export function voiceOutcome(state: VoiceState): VoiceOutcome {
  switch (state.phase) {
    case 'finished':
      return { kind: 'send' }
    case 'cancelled':
      return { kind: 'cancel' }
    default:
      return { kind: 'none' }
  }
}

/** Formata milissegundos como m:ss para o timer de gravação. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
