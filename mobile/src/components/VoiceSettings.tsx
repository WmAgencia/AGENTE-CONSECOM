import { useEffect, useState } from 'react'
import { Volume2 } from 'lucide-react'
import { VOICE_EVENTS } from '../lib/voiceEvents'
import { loadNotifPrefs, saveNotifPrefs, type NotifPrefs } from '../lib/types'

// =====================================================================
// Notificações de voz — toggles por evento (alarme + realtime).
// Persiste em NotifPrefs (Preferences), mesma chave voz_* usada pelo
// serviço de alarmes e pelos eventos realtime.
// =====================================================================

export function VoiceSettings() {
  const [prefs, setPrefs] = useState<NotifPrefs | null>(null)

  useEffect(() => {
    void loadNotifPrefs().then(setPrefs)
  }, [])

  if (!prefs) {
    return (
      <div className="text-xs text-slate-500">
        Carregando configurações de voz…
      </div>
    )
  }

  async function toggle(voiceKey: string, on: boolean) {
    const next = { ...prefs, [`voz_${voiceKey}`]: on } as NotifPrefs
    setPrefs(next)
    await saveNotifPrefs(next)
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-semibold text-slate-300 mb-2">Alarme de reunião (agendado)</h2>
        <div className="rounded-xl border border-white/5 bg-white/[0.03] p-2">
          {VOICE_EVENTS.filter((v) => v.kind === 'alarme').map((v) => (
            <Row
              key={v.key}
              label={v.label}
              on={prefs[`voz_${v.key}` as keyof NotifPrefs] ?? true}
              onChange={(on) => void toggle(v.key, on)}
            />
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-slate-300 mb-2">Eventos (tempo real)</h2>
        <div className="rounded-xl border border-white/5 bg-white/[0.03] p-2">
          {VOICE_EVENTS.filter((v) => v.kind === 'evento').map((v) => (
            <Row
              key={v.key}
              label={v.label}
              on={prefs[`voz_${v.key}` as keyof NotifPrefs] ?? true}
              onChange={(on) => void toggle(v.key, on)}
            />
          ))}
        </div>
      </section>

      <p className="text-[11px] text-slate-500">
        A narração de voz é tocada em vez do som padrão quando a notificação correspondente estiver
        ativada. Alarmes de reunião tocam mesmo com o app fechado; eventos de tempo real exigem o
        app aberto (realtime).
      </p>
    </div>
  )
}

function Row({
  label,
  on,
  onChange,
}: {
  label: string
  on: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-white/5 last:border-0 px-2">
      <div className="flex items-center gap-2">
        <Volume2 className={`w-4 h-4 ${on ? 'text-indigo-300' : 'text-slate-600'}`} />
        <span className={`text-sm ${on ? 'text-slate-200' : 'text-slate-500'}`}>{label}</span>
      </div>
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
  )
}
