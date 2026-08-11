import { useMemo, useState } from 'react'
import { LogOut, RotateCcw, Info, BellRing, AlarmClock, Clock } from 'lucide-react'
import { supabase } from '../lib/supabase'
import type { ReminderPrefs } from '../lib/types'
import { formatReminder } from '../lib/format'
import { syncAlarms } from '../services/alarms'
import {
  sendTestNotification,
  scheduleTestEvent,
  scheduleTestAlarm,
} from '../services/alarms'
import { isNativeAlarmAvailable } from '../native/vyntraAlarm'
import { AlarmSoundPicker } from '../components/AlarmSoundPicker'
import { VoiceSettings } from '../components/VoiceSettings'

interface Props {
  reminder: ReminderPrefs | null
  onReminderChange: (minutes: number) => void
  onSoundChanged: () => void
  lastSync: number | null
}

const OPTIONS = [5, 10, 15, 30, 60, 120]

export function SettingsScreen({ reminder, onReminderChange, onSoundChanged, lastSync }: Props) {
  const [confirming, setConfirming] = useState(false)
  const [rebuilt, setRebuilt] = useState(false)

  const version = useMemo(() => '1.0.0', [])

  async function rebuild() {
    setRebuilt(false)
    // Pega os dados atuais e reaplica o sync (útil após permissão ser negada/concedida)
    const { data } = await supabase.from('leads').select('*')
    if (data) await syncAlarms(data as never[])
    setRebuilt(true)
    window.setTimeout(() => setRebuilt(false), 2500)
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Ajustes</h1>
      </header>

      {/* Antecedência padrão */}
      <section>
        <h2 className="text-sm font-semibold text-slate-300 mb-2">Antecedência padrão do alarme</h2>
        <div className="rounded-xl border border-white/5 bg-white/[0.03] p-3">
          <div className="grid grid-cols-3 gap-2">
            {OPTIONS.map((o) => {
              const active = reminder?.defaultMinutes === o
              return (
                <button
                  key={o}
                  onClick={() => onReminderChange(o)}
                  className={`rounded-lg px-2 py-2 text-xs font-medium transition ${
                    active ? 'bg-indigo-500 text-white' : 'bg-white/5 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  {formatReminder(o)}
                </button>
              )
            })}
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            Aplica-se a novas reuniões e às que usam o padrão. É possível mudar por reunião na aba
            Reuniões.
          </p>
        </div>
      </section>

      {/* Som/volume/vibração padrão */}
      <section>
        <h2 className="text-sm font-semibold text-slate-300 mb-2">Som do alarme (padrão)</h2>
        <div className="rounded-xl border border-white/5 bg-white/[0.03] p-3">
          <AlarmSoundPicker reminder={reminder} onChanged={onSoundChanged} />
          <p className="text-[11px] text-slate-500 mt-3">
            Vale para novas reuniões e para as que usam o padrão. Dá para personalizar o som de cada
            reunião na aba Reuniões.
          </p>
        </div>
      </section>

      {/* Notificações de voz */}
      <section>
        <h2 className="text-sm font-semibold text-slate-300 mb-2">Notificações de voz</h2>
        <VoiceSettings />
      </section>

      {/* Reconstruir alarmes */}
      <section>
        <h2 className="text-sm font-semibold text-slate-300 mb-2">Alarmes</h2>
        <button
          onClick={() => void rebuild()}
          className="w-full rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 text-sm text-slate-200 flex items-center justify-between hover:bg-white/[0.06] transition"
        >
          <span className="flex items-center gap-2">
            <RotateCcw className="w-4 h-4 text-indigo-300" />
            Reconstruir todos os alarmes
          </span>
          <span className="text-[11px] text-slate-500">{rebuilt ? 'Pronto ✓' : ''}</span>
        </button>
        <p className="text-[11px] text-slate-500 mt-2">
          Use se as notificações foram negadas antes e depois concedidas, ou se suspeitar de alarmes
          faltando após reiniciar o celular.
        </p>
      </section>

      {/* Teste real de notificações */}
      <section>
        <h2 className="text-sm font-semibold text-slate-300 mb-2">Testar notificações</h2>
        <div className="space-y-2">
          <button
            onClick={() => void sendTestNotification()}
            className="w-full rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 text-sm text-slate-200 flex items-center justify-between hover:bg-white/[0.06] transition"
          >
            <span className="flex items-center gap-2">
              <BellRing className="w-4 h-4 text-indigo-300" />
              Enviar notificação agora
            </span>
            <span className="text-[11px] text-slate-500">imediata</span>
          </button>
          <button
            onClick={() => void scheduleTestEvent()}
            className="w-full rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 text-sm text-slate-200 flex items-center justify-between hover:bg-white/[0.06] transition"
          >
            <span className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-indigo-300" />
              Agendar teste em 20s (evento)
            </span>
            <span className="text-[11px] text-slate-500">app em 2º plano</span>
          </button>
          <button
            onClick={() => void scheduleTestAlarm()}
            className="w-full rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 text-sm text-slate-200 flex items-center justify-between hover:bg-white/[0.06] transition"
          >
            <span className="flex items-center gap-2">
              <AlarmClock className="w-4 h-4 text-amber-300" />
              Alarme nativo em 1 min
            </span>
            <span className="text-[11px] text-slate-500">app fechado</span>
          </button>
        </div>
        <p className="text-[11px] text-slate-500 mt-2">
          {isNativeAlarmAvailable()
            ? 'O alarme nativo usa o AlarmManager do Android e toca mesmo com o app fechado (modo Doze). Eventos (realtime) aparecem com o app aberto ou em segundo plano.'
            : 'Alarmes reais usam o alarme nativo do Android (disponível no APK instalado).'}
        </p>
      </section>

      {/* Sair */}
      <section>
        <h2 className="text-sm font-semibold text-slate-300 mb-2">Conta</h2>
        {confirming ? (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 space-y-2">
            <p className="text-xs text-rose-200">
              Desconectar este aparelho? Você pode reconectar depois pelo painel.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  void supabase.auth.signOut()
                  setConfirming(false)
                }}
                className="flex-1 rounded-lg bg-rose-500 text-white text-sm py-2 font-medium"
              >
                Sim, desconectar
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="flex-1 rounded-lg bg-white/5 text-slate-300 text-sm py-2"
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="w-full rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3 text-sm text-rose-300 flex items-center justify-between hover:bg-white/[0.06] transition"
          >
            <span className="flex items-center gap-2">
              <LogOut className="w-4 h-4" />
              Desconectar este aparelho
            </span>
          </button>
        )}
      </section>

      {/* Sobre */}
      <section className="rounded-xl border border-white/5 bg-white/[0.03] px-4 py-3">
        <div className="flex items-center gap-2 text-slate-300 mb-1">
          <Info className="w-4 h-4 text-indigo-300" />
          <span className="text-sm font-medium">Vyntra — app mobile</span>
        </div>
        <div className="text-[11px] text-slate-500">
          v{version}
          {lastSync ? ` · último sync ${new Date(lastSync).toLocaleTimeString('pt-BR')}` : ''}
        </div>
      </section>
    </div>
  )
}
