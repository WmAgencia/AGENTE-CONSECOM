import { describe, it, expect } from 'vitest'
import {
  voiceReducer,
  voiceOutcome,
  formatClock,
  MIN_HOLD_TO_RECORD,
  IDLE_VOICE_STATE,
  type VoiceState,
} from '../src/lib/voiceRecorder'

const T0 = 1_000_000

describe('voiceReducer', () => {
  it('press inicia a gravação (phase=recording)', () => {
    const s = voiceReducer(IDLE_VOICE_STATE, { type: 'press', now: T0 })
    expect(s.phase).toBe('recording')
    expect(s.startMs).toBe(T0)
    expect(s.elapsedMs).toBe(0)
    expect(s.transcript).toBe('')
  })

  it('tick atualiza a duração enquanto grava', () => {
    let s = voiceReducer(IDLE_VOICE_STATE, { type: 'press', now: T0 })
    s = voiceReducer(s, { type: 'tick', now: T0 + 6500 })
    expect(s.elapsedMs).toBe(6500)
  })

  it('tick não avança no estado idle', () => {
    const s = voiceReducer(IDLE_VOICE_STATE, { type: 'tick', now: T0 + 100 })
    expect(s.elapsedMs).toBe(0)
  })

  it('release sem travar e com tempo suficiente envia', () => {
    let s = voiceReducer(IDLE_VOICE_STATE, { type: 'press', now: T0 })
    s = voiceReducer(s, { type: 'release', now: T0 + 3000 })
    expect(s.phase).toBe('finished')
    expect(voiceOutcome(s).kind).toBe('send')
  })

  it('toque rápido (< mínimo) é descartado', () => {
    let s = voiceReducer(IDLE_VOICE_STATE, { type: 'press', now: T0 })
    s = voiceReducer(s, { type: 'release', now: T0 + MIN_HOLD_TO_RECORD - 10 })
    expect(s.phase).toBe('cancelled')
    expect(voiceOutcome(s).kind).toBe('cancel')
  })

  it('arrastar para cima trava a gravação', () => {
    let s = voiceReducer(IDLE_VOICE_STATE, { type: 'press', now: T0 })
    s = voiceReducer(s, { type: 'slide', locked: true, cancelZone: false })
    expect(s.slideLocked).toBe(true)
    s = voiceReducer(s, { type: 'lock' })
    expect(s.phase).toBe('locked')
  })

  it('soltar já travado mantém travado', () => {
    let s = voiceReducer(IDLE_VOICE_STATE, { type: 'press', now: T0 })
    s = voiceReducer(s, { type: 'slide', locked: true, cancelZone: false })
    s = voiceReducer(s, { type: 'lock' })
    s = voiceReducer(s, { type: 'release', now: T0 + 5000 })
    expect(s.phase).toBe('locked')
  })

  it('no modo travado, send finaliza com envio', () => {
    let s = voiceReducer(IDLE_VOICE_STATE, { type: 'press', now: T0 })
    s = voiceReducer(s, { type: 'slide', locked: true, cancelZone: false })
    s = voiceReducer(s, { type: 'lock' })
    s = voiceReducer(s, { type: 'send' })
    expect(s.phase).toBe('finished')
    expect(voiceOutcome(s).kind).toBe('send')
  })

  it('no modo travado, cancelar descarta', () => {
    let s = voiceReducer(IDLE_VOICE_STATE, { type: 'press', now: T0 })
    s = voiceReducer(s, { type: 'slide', locked: true, cancelZone: false })
    s = voiceReducer(s, { type: 'lock' })
    s = voiceReducer(s, { type: 'cancel' })
    expect(s.phase).toBe('cancelled')
    expect(voiceOutcome(s).kind).toBe('cancel')
  })

  it('arrastar para o lado (zona cancelar) e soltar descarta', () => {
    let s = voiceReducer(IDLE_VOICE_STATE, { type: 'press', now: T0 })
    s = voiceReducer(s, { type: 'slide', locked: false, cancelZone: true })
    s = voiceReducer(s, { type: 'release', now: T0 + 3000 })
    expect(s.phase).toBe('cancelled')
    expect(voiceOutcome(s).kind).toBe('cancel')
  })

  it('transcript atualiza o texto reconhecido', () => {
    let s = voiceReducer(IDLE_VOICE_STATE, { type: 'press', now: T0 })
    s = voiceReducer(s, { type: 'transcript', text: 'olá tudo bem' })
    expect(s.transcript).toBe('olá tudo bem')
  })

  it('erro não interrompe a gravação', () => {
    let s = voiceReducer(IDLE_VOICE_STATE, { type: 'press', now: T0 })
    s = voiceReducer(s, { type: 'error', message: 'sem conexão' })
    expect(s.phase).toBe('recording')
    expect(s.error).toBe('sem conexão')
  })

  it('press depois de um estado limpa erro e transcript', () => {
    let s: VoiceState = {
      ...IDLE_VOICE_STATE,
      phase: 'finished',
      transcript: 'abc',
      error: 'x',
    }
    s = voiceReducer(s, { type: 'press', now: T0 })
    expect(s.transcript).toBe('')
    expect(s.error).toBeUndefined()
  })
})

describe('formatClock', () => {
  it('formata segundos como m:ss', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(7_000)).toBe('0:07')
    expect(formatClock(83_000)).toBe('1:23')
    expect(formatClock(3_600_000)).toBe('60:00')
  })
})
