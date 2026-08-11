import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Mic, Send, Trash2, Lock } from 'lucide-react'
import { VyntraMic, isMicNativeAvailable, type MicRecordingResult } from '../native/vyntraMic'
import {
  voiceReducer,
  formatClock,
  IDLE_VOICE_STATE,
  MIN_HOLD_TO_RECORD,
} from '../lib/voiceRecorder'

export interface VoiceAudio {
  uri: string
  durationMs: number
  size: number
}

interface Props {
  onSendMessage: (text: string, audio?: VoiceAudio) => void
  disabled?: boolean
}

// Limiar (px) de arrasto para cima para travar a gravação.
const LOCK_THRESHOLD = 70
// Limiar (px) de arrasto para a esquerda para cancelar.
const CANCEL_THRESHOLD = 90

export function VoiceInput({ onSendMessage, disabled }: Props) {
  const [state, dispatch] = useReducer(voiceReducer, IDLE_VOICE_STATE)
  const [permissionDenied, setPermissionDenied] = useState(false)
  const [nativeAvailable] = useState(isMicNativeAvailable())
  const [busy, setBusy] = useState(false)

  const touchRef = useRef<{ x: number; y: number } | null>(null)
  // Estado do gesto atual (imune a stale closures do reducer no touchend).
  const gestureRef = useRef<{ locked: boolean; cancelZone: boolean; pressAt: number } | null>(null)
  const busyRef = useRef(false)
  busyRef.current = busy

  // Timer de duração enquanto grava / travado
  useEffect(() => {
    if (state.phase !== 'recording' && state.phase !== 'locked') return
    const t = window.setInterval(() => {
      dispatch({ type: 'tick', now: Date.now() })
    }, 250)
    return () => window.clearInterval(t)
  }, [state.phase])

  // Texto reconhecido ao vivo (SpeechRecognizer nativo)
  useEffect(() => {
    if (!nativeAvailable) return
    const sub = VyntraMic.addListener('transcript', ({ text }) => {
      dispatch({ type: 'transcript', text })
    })
    const subErr = VyntraMic.addListener('micerror', ({ message }) => {
      dispatch({ type: 'error', message })
    })
    return () => {
      void sub.then((h) => h.remove())
      void subErr.then((h) => h.remove())
    }
  }, [nativeAvailable])

  async function ensurePermission(): Promise<boolean> {
    if (!nativeAvailable) return false
    const perm = await VyntraMic.checkPermissions()
    if (perm.granted) return true
    const req = await VyntraMic.requestPermissions()
    setPermissionDenied(!req.granted)
    return req.granted
  }

  async function startRecording() {
    if (!nativeAvailable) {
      dispatch({ type: 'error', message: 'Gravação de voz disponível no app Android' })
      return
    }
    const ok = await ensurePermission()
    if (!ok) return
    setPermissionDenied(false)
    await VyntraMic.startRecording()
  }

  const stopAndSend = useCallback(async () => {
    if (!nativeAvailable) {
      dispatch({ type: 'cancel' })
      return
    }
    if (busyRef.current) return
    setBusy(true)
    try {
      const res: MicRecordingResult = await VyntraMic.stopRecording()
      if (res.tooShort) {
        // Toque sem áudio útil — descarta silenciosamente.
        dispatch({ type: 'cancel' })
        return
      }
      if (!res.text && res.uri) {
        // Áudio gravado, mas sem transcrição — vira mensagem de voz sem texto.
        dispatch({ type: 'cancel' })
        onSendMessage('', {
          uri: res.uri,
          durationMs: res.durationMs,
          size: res.size,
        })
        return
      }
      onSendMessage(res.text, {
        uri: res.uri,
        durationMs: res.durationMs,
        size: res.size,
      })
    } catch (e) {
      dispatch({
        type: 'error',
        message: e instanceof Error ? e.message : 'Falha ao enviar áudio',
      })
    } finally {
      setBusy(false)
      dispatch({ type: 'cancel' })
    }
  }, [nativeAvailable, onSendMessage])

  const cancelCurrent = useCallback(async () => {
    if (nativeAvailable) {
      try {
        await VyntraMic.cancelRecording()
      } catch {
        /* ignore */
      }
    }
    dispatch({ type: 'cancel' })
  }, [nativeAvailable])

  // ---- Gestos ----
  async function handleTouchStart(e: React.TouchEvent) {
    if (state.phase !== 'idle' || disabled) return
    e.preventDefault()
    const ok = await ensurePermission()
    if (!ok) return
    if (state.phase !== 'idle') return
    const t = e.touches[0]
    touchRef.current = { x: t.clientX, y: t.clientY }
    gestureRef.current = { locked: false, cancelZone: false, pressAt: Date.now() }
    dispatch({ type: 'press', now: Date.now() })
    void startRecording()
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (state.phase !== 'recording') return
    const start = touchRef.current
    const gesture = gestureRef.current
    if (!start || !gesture) return
    const t = e.touches[0]
    const dy = t.clientY - start.y
    const dx = t.clientX - start.x
    gesture.locked = dy < -LOCK_THRESHOLD
    gesture.cancelZone = dx < -CANCEL_THRESHOLD
    dispatch({
      type: 'slide',
      locked: gesture.locked,
      cancelZone: gesture.cancelZone,
    })
    if (gesture.locked) dispatch({ type: 'lock' })
  }

  function handleTouchEnd() {
    const gesture = gestureRef.current
    if (!gesture) return
    gestureRef.current = null
    touchRef.current = null
    if (gesture.cancelZone) {
      void cancelCurrent()
      return
    }
    if (gesture.locked) {
      // Soltou com a gravação travada: aguarda toque em enviar/cancelar.
      dispatch({ type: 'lock' })
      return
    }
    if (Date.now() - gesture.pressAt < MIN_HOLD_TO_RECORD) {
      void cancelCurrent()
      return
    }
    void stopAndSend()
  }

  function handleTouchCancel() {
    gestureRef.current = null
    touchRef.current = null
    void cancelCurrent()
  }

  const locked = state.phase === 'locked'

  return (
    <div className="relative">
      {permissionDenied && (
        <p className="text-[11px] text-rose-300 px-1 pb-1.5">
          Permissão de microfone negada. Habilite nas configurações do Android.
        </p>
      )}
      {state.error && (
        <p className="text-[11px] text-amber-300 px-1 pb-1.5">{state.error}</p>
      )}

      {/* Barra de gravação travada */}
      {locked ? (
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-2.5">
          <button
            onClick={() => void cancelCurrent()}
            className="flex items-center gap-1.5 text-rose-300 text-xs font-medium"
            aria-label="Cancelar gravação"
          >
            <Trash2 className="w-4 h-4" />
            Cancelar
          </button>
          <div className="flex-1 flex items-center justify-center gap-2 text-sm">
            <span className="flex items-center gap-1 text-rose-300">
              <span className="w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
              <Lock className="w-3.5 h-3.5" />
              {formatClock(state.elapsedMs)}
            </span>
            <span className="text-xs text-slate-400 truncate max-w-[45%]">
              {state.transcript || 'Gravando…'}
            </span>
          </div>
          <button
            onClick={() => void stopAndSend()}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-full bg-indigo-500 text-white text-xs font-semibold px-4 py-2"
            aria-label="Enviar gravação"
          >
            <Send className="w-3.5 h-3.5" />
            {busy ? '…' : 'Enviar'}
          </button>
        </div>
      ) : (
        /* Estado idle / segurando */
        <div className="relative flex items-center justify-center">
          {state.phase === 'recording' && (
            <div className="absolute -top-12 left-0 right-0 flex items-center justify-center gap-2 rounded-full bg-black/50 backdrop-blur px-3 py-1.5 text-xs text-rose-200">
              <span className="w-2 h-2 rounded-full bg-rose-400 animate-pulse" />
              {formatClock(state.elapsedMs)}
              <span className="text-slate-400">{state.transcript || 'Fale agora…'}</span>
              <span className="text-slate-500 text-[10px]">↑ travar</span>
            </div>
          )}
          <button
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchCancel}
            disabled={disabled}
            aria-label="Gravar mensagem de voz"
            className={`relative w-11 h-11 rounded-full flex items-center justify-center transition touch-none select-none ${
              state.phase === 'recording'
                ? 'bg-rose-500 text-white scale-110 shadow-lg shadow-rose-500/30'
                : 'bg-white/[0.06] text-slate-300 hover:bg-white/10'
            } ${disabled ? 'opacity-40' : ''}`}
          >
            <Mic className="w-5 h-5" />
          </button>
        </div>
      )}
    </div>
  )
}
