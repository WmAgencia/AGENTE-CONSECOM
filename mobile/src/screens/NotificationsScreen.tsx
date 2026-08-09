import { BellRing } from 'lucide-react'
import type { NotifPrefs } from '../lib/types'
import { notifPrefLabel } from '../lib/types'
import { saveNotifPrefs } from '../lib/types'

interface Props {
  prefs: NotifPrefs | null
  onChange: (prefs: NotifPrefs) => void
}

const KEYS: (keyof NotifPrefs)[] = [
  'reuniao_marcada',
  'reuniao_cancelada',
  'reuniao_reagendada',
  'lead_respondeu',
  'campanha_iniciada',
  'campanha_concluida',
  'campanha_erro',
  'whatsapp_desconectado',
  'alex_evento',
]

export function NotificationsScreen({ prefs, onChange }: Props) {
  if (!prefs) {
    return <p className="text-sm text-slate-500 text-center py-10">Carregando preferências…</p>
  }

  async function toggle(key: keyof NotifPrefs) {
    const p = prefs!
    const next = { ...p, [key]: !p[key] }
    await saveNotifPrefs(next)
    onChange(next)
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Notificações</h1>
        <p className="text-sm text-slate-400">Escolha o que deseja receber neste celular.</p>
      </header>

      <div className="rounded-xl border border-white/5 bg-white/[0.03]">
        {KEYS.map((key, i) => (
          <div
            key={key}
            className={`flex items-center justify-between px-4 py-3.5 ${i > 0 ? 'border-t border-white/5' : ''}`}
          >
            <div className="flex items-center gap-3">
              <BellRing className="w-4 h-4 text-indigo-300" />
              <span className="text-sm">{notifPrefLabel(key)}</span>
            </div>
            <button
              onClick={() => void toggle(key)}
              role="switch"
              aria-checked={prefs[key]}
              className={`w-11 h-6 rounded-full transition relative ${
                prefs[key] ? 'bg-indigo-500' : 'bg-white/10'
              }`}
            >
              <span
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                  prefs[key] ? 'left-[22px]' : 'left-0.5'
                }`}
              />
            </button>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-slate-500 px-1">
        As notificações são locais (realtime do painel). O alarme de reunião usa o AlarmManager do
        Android e funciona mesmo com o app fechado ou sem internet.
      </p>
    </div>
  )
}
