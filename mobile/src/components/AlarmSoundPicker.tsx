import { useEffect, useRef, useState } from 'react'
import { Volume2, Vibrate, Music, ShieldAlert } from 'lucide-react'
import type { ReminderPrefs } from '../lib/types'
import { loadReminderPrefs, saveReminderPrefs } from '../lib/types'
import {
  listAlarmSounds,
  importAlarmSound,
  isExactAlarmAllowed,
  requestExactAlarmPermission,
  getMeetingSoundPrefs,
  setMeetingSoundPrefs,
  type MeetingSoundPrefs,
} from '../services/alarms'

// =====================================================================
// Configurador de alarme de reunião: som, volume e vibração.
// Usado nos ajustes (padrão) e por reunião (override).
// =====================================================================

interface SoundOption {
  name: string
  uri: string
}

interface Props {
  /** null = usa leadId para config de uma reunião; '' = configuração padrão */
  leadId?: string
  reminder: ReminderPrefs | null
  /** callback após salvar (para avisar "precisa resync" e sincronizar) */
  onChanged?: () => void
}

export function AlarmSoundPicker({ leadId, reminder, onChanged }: Props) {
  const [sounds, setSounds] = useState<SoundOption[]>([])
  const [soundUri, setSoundUri] = useState<string>('')
  const [volume, setVolume] = useState(80)
  const [vibrate, setVibrate] = useState(true)
  const [exactAllowed, setExactAllowed] = useState(true)
  const [importing, setImporting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const isDefault = !leadId

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const prefs = reminder
      if (prefs) {
        const p = isDefault
          ? {
              soundUri: prefs.defaultSoundUri ?? '',
              volume: prefs.defaultVolume ?? 80,
              vibrate: prefs.defaultVibrate ?? true,
            }
          : getMeetingSoundPrefs(prefs, leadId!)
        if (!cancelled) {
          setSoundUri(p.soundUri ?? '')
          setVolume(p.volume)
          setVibrate(p.vibrate)
        }
      }
      const [list, { allowed }] = await Promise.all([
        listAlarmSounds(),
        isExactAlarmAllowed().then((a) => ({ allowed: a })),
      ])
      if (!cancelled) {
        setSounds(list)
        setExactAllowed(allowed)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [leadId, reminder])

  async function persist(p: Partial<MeetingSoundPrefs>) {
    const next: MeetingSoundPrefs = {
      soundUri: p.soundUri ?? soundUri,
      volume: p.volume ?? volume,
      vibrate: p.vibrate ?? vibrate,
    }
    if (isDefault) {
      const cur = await loadReminderPrefs()
      cur.defaultSoundUri = next.soundUri || null
      cur.defaultVolume = next.volume
      cur.defaultVibrate = next.vibrate
      await saveReminderPrefs(cur)
    } else {
      await setMeetingSoundPrefs(leadId!, next)
    }
    onChanged?.()
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    setNotice(null)
    try {
      // <input accept="audio/*"> em WebView → blob/file. No Capacitor usamos
      // file.blob() e FileReader para obter data URI? Não: o plugin importa de
      // um content://. No Android o input devolve um File; convertemos via FileReader.
      const uri = await readAsDataUri(file)
      // Passa a data URI (base64) — o plugin grava o arquivo no app.
      const imported = await importAlarmSound(uri, file.name)
      setSoundUri(imported)
      await persist({ soundUri: imported })
      setNotice('Som importado com sucesso.')
      // atualiza a lista (agora inclui o importado)
      const list = await listAlarmSounds()
      setSounds(list)
    } catch {
      setNotice('Não foi possível importar o som.')
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-4">
      {/* Som */}
      <div>
        <label className="flex items-center gap-1.5 text-xs font-medium text-slate-300 mb-1.5">
          <Music className="w-3.5 h-3.5 text-indigo-300" />
          Som do alarme
        </label>
        <select
          value={soundUri}
          onChange={(e) => {
            setSoundUri(e.target.value)
            void persist({ soundUri: e.target.value })
          }}
          className="w-full bg-black/30 border border-white/10 rounded-lg text-sm px-3 py-2 text-slate-200 outline-none focus:border-indigo-500"
        >
          {sounds.map((s) => (
            <option key={s.uri || 'default'} value={s.uri}>
              {s.name}
            </option>
          ))}
        </select>

        <button
          onClick={() => fileRef.current?.click()}
          disabled={importing}
          className="mt-2 inline-flex items-center gap-1.5 text-xs text-indigo-300 hover:text-indigo-200 disabled:opacity-50"
        >
          {importing ? 'Importando…' : '+ Importar som do aparelho'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => void onPickFile(e)}
        />
      </div>

      {/* Volume */}
      <div>
        <label className="flex items-center gap-1.5 text-xs font-medium text-slate-300 mb-1.5">
          <Volume2 className="w-3.5 h-3.5 text-indigo-300" />
          Volume: {volume}%
        </label>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          onMouseUp={() => void persist({ volume })}
          onTouchEnd={() => void persist({ volume })}
          onKeyUp={() => void persist({ volume })}
          className="w-full accent-indigo-500"
        />
      </div>

      {/* Vibração */}
      <button
        onClick={() => {
          const next = !vibrate
          setVibrate(next)
          void persist({ vibrate: next })
        }}
        className={`w-full flex items-center justify-between rounded-xl border px-4 py-2.5 text-sm transition ${
          vibrate
            ? 'border-indigo-500/30 bg-indigo-500/10 text-slate-100'
            : 'border-white/5 bg-white/[0.03] text-slate-400'
        }`}
      >
        <span className="flex items-center gap-2">
          <Vibrate className="w-4 h-4" />
          Vibrar
        </span>
        <span className={`w-9 h-5 rounded-full p-0.5 transition ${vibrate ? 'bg-indigo-500' : 'bg-white/10'}`}>
          <span
            className={`block w-4 h-4 rounded-full bg-white transition-transform ${vibrate ? 'translate-x-4' : ''}`}
          />
        </span>
      </button>

      {/* Permissão de alarme exato */}
      {!exactAllowed && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-100">
              O alarme pode atrasar porque o Android bloqueia alarmes exatos para este app. Permita
              o acesso para que a reunião toque no horário exato, mesmo com o celular economizando
              bateria.
            </p>
          </div>
          <button
            onClick={() => void requestExactAlarmPermission()}
            className="w-full rounded-lg bg-amber-500 text-black text-sm py-2 font-medium"
          >
            Permitir alarmes exatos
          </button>
          <button
            onClick={() => {
              void requestExactAlarmPermission().then(() => void isExactAlarmAllowed().then((a) => setExactAllowed(a)))
            }}
            className="w-full text-[11px] text-amber-300"
          >
            Já permiti — verificar de novo
          </button>
        </div>
      )}

      {notice && <p className="text-[11px] text-slate-400">{notice}</p>}
    </div>
  )
}

function readAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
