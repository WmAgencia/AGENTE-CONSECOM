import { useEffect, useState } from 'react'
import { Volume2 } from 'lucide-react'
import { VOICE_EVENTS, loadVoicePrefs, setVoicePref, playVoice } from '../lib/voice'

// =====================================================================
// Notificações de voz — toggles por evento (funciona no site e no APK).
// Persistência em localStorage (chave voz_*), mesma do app mobile.
// =====================================================================

export function VoiceSettings() {
  const [prefs, setPrefs] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setPrefs(loadVoicePrefs())
  }, [])

  function toggle(key: string, on: boolean) {
    setPrefs(setVoicePref(key, on))
  }

  return (
    <div className="h-full overflow-auto px-6 py-5 max-w-3xl">
      <h1 className="text-lg font-semibold mb-1">Notificações de voz</h1>
      <p className="text-sm text-slate-400 mb-6">
        Cada narração pode ser ativada ou desativada individualmente. Vale para o painel (site)
        e para o app mobile. Toque em "Ouvir" para pré-ouvir o áudio.
      </p>

      <section className="rounded-xl border border-white/5 bg-white/[0.02] p-5 space-y-1">
        <h2 className="text-sm font-semibold text-slate-300 mb-3">Alarme de reunião (agendado)</h2>
        {VOICE_EVENTS.filter((v) => v.kind === 'alarme').map((v) => (
          <Row key={v.key} label={v.label} on={prefs[`voz_${v.key}`] ?? true} onChange={(on) => toggle(v.key, on)} voiceKey={v.key} />
        ))}
      </section>

      <section className="rounded-xl border border-white/5 bg-white/[0.02] p-5 space-y-1 mt-6">
        <h2 className="text-sm font-semibold text-slate-300 mb-3">Eventos (tempo real)</h2>
        {VOICE_EVENTS.filter((v) => v.kind === 'evento').map((v) => (
          <Row key={v.key} label={v.label} on={prefs[`voz_${v.key}`] ?? true} onChange={(on) => toggle(v.key, on)} voiceKey={v.key} />
        ))}
      </section>
    </div>
  )
}

function Row({
  label,
  on,
  onChange,
  voiceKey,
}: {
  label: string
  on: boolean
  onChange: (on: boolean) => void
  voiceKey: string
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-300">{label}</span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={() => playVoice(voiceKey)}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition px-2 py-1 rounded-lg hover:bg-white/5"
        >
          <Volume2 className="w-3.5 h-3.5" />
          Ouvir
        </button>
        <button
          role="switch"
          aria-checked={on}
          onClick={() => onChange(!on)}
          className={`relative w-10 h-6 rounded-full transition-colors ${
            on ? 'bg-indigo-500' : 'bg-white/10'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
              on ? 'translate-x-4' : ''
            }`}
          />
        </button>
      </div>
    </div>
  )
}
