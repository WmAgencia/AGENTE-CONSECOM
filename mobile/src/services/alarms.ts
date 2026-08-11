import { LocalNotifications, type ScheduleOptions } from '@capacitor/local-notifications'
import {
  loadReminderPrefs,
  saveReminderPrefs,
  loadNotifPrefs,
  type Lead,
  type NotifPrefs,
  type ReminderPrefs,
} from '../lib/types'
import { computeAlarmPlan, alarmIdFor } from '../core/syncEngine'
import { reminderFor } from '../core/syncEngine'
import { VOICE_MAP } from '../lib/voiceEvents'
import VyntraAlarm, {
  isNativeAlarmAvailable,
  type ScheduleAlarmOptions,
  type VyntraPendingAlarm,
} from '../native/vyntraAlarm'

// =====================================================================
// Serviço de alarmes.
//   - No Android nativo: usa o módulo VyntraAlarm (AlarmManager exato,
//     soa em Doze, restaura após reboot, som/volume/vibração por reunião).
//     O som de alarme é a narração de voz (ElevenLabs) que bate com a
//     antecedência configurada (ex.: 5 min → "reunião em 5 minutos").
//   - Fallback (browser/dev): Local Notifications.
//   - `syncAlarms()` aplica o plano do motor de sync (criar/alterar/cancelar).
// =====================================================================

const CHANNEL_MEETINGS = 'consecom-meetings'
const CHANNEL_EVENTS = 'consecom-events'

/** URI nativa (android.resource://) para o arquivo raw/<name>.mp3 */
function nativeVoiceUri(key: string): string | null {
  const file = VOICE_MAP[key]?.file
  if (!file) return null
  const name = file.replace(/\.mp3$/i, '')
  return `android.resource://com.consecom.mobile/raw/${name}`
}

// ---------------------------------------------------------------------
// Canais (fallback Local Notifications — no nativo o canal é do plugin)
// ---------------------------------------------------------------------
export async function ensureChannels(): Promise<void> {
  if (isNativeAlarmAvailable()) {
    return
  }
  await LocalNotifications.createChannel({
    id: CHANNEL_MEETINGS,
    name: 'Reuniões',
    description: 'Lembretes de reuniões agendadas',
    importance: 5,
    visibility: 1,
  })
  await LocalNotifications.createChannel({
    id: CHANNEL_EVENTS,
    name: 'Eventos',
    description: 'Atualizações da operação (campanhas, WhatsApp, Alex)',
    importance: 4,
  })
}

export async function requestNotificationPermission(): Promise<boolean> {
  // SEMPRE pedir (Android 13+/API 33 exige POST_NOTIFICATIONS), mesmo com o
  // módulo nativo de alarme disponível — o receiver também mostra notificações.
  const current = await LocalNotifications.checkPermissions()
  if (current.display === 'granted') return true
  const req = await LocalNotifications.requestPermissions()
  return req.display === 'granted'
}

export async function areNotificationsEnabled(): Promise<boolean> {
  const s = await LocalNotifications.checkPermissions()
  return s.display === 'granted'
}

/** Map id -> fireAt (ISO) dos alarmes de reunião agendados hoje. */
async function currentScheduledMap(): Promise<Map<number, string>> {
  if (isNativeAlarmAvailable()) {
    try {
      const { alarms } = await VyntraAlarm.getPending()
      const map = new Map<number, string>()
      for (const a of alarms ?? []) map.set(a.id, a.fireAt)
      return map
    } catch {
      return new Map()
    }
  }
  try {
    const { notifications } = await LocalNotifications.getPending()
    const map = new Map<number, string>()
    for (const n of notifications ?? []) {
      if (n.schedule?.at) map.set(n.id, new Date(n.schedule.at).toISOString())
    }
    return map
  } catch {
    return new Map()
  }
}

export async function syncAlarms(leads: Lead[], now?: number) {
  const reminder = await loadReminderPrefs()
  const notifPrefs = await loadNotifPrefs()
  const scheduled = await currentScheduledMap()

  const plan = computeAlarmPlan({ leads, scheduled, reminder, now })

  // CANCEL primeiro (mudança de status / reagendamento)
  if (plan.toCancel.length > 0) {
    if (isNativeAlarmAvailable()) {
      for (const id of plan.toCancel) {
        await VyntraAlarm.cancel({ id })
      }
    } else {
      await LocalNotifications.cancel({
        notifications: plan.toCancel.map((id: number) => ({ id })),
      })
    }
  }

  // AGENDA/ATUALIZA: mesmo id substitui o pendente anterior (reagendamento)
  if (plan.toSchedule.length > 0) {
    if (isNativeAlarmAvailable()) {
      const native: ScheduleAlarmOptions[] = plan.toSchedule.map((a) => ({
        id: a.alarmId,
        fireAt: a.fireAt,
        title: a.title,
        body: a.body,
        soundUri: voiceUriForLead(reminder, notifPrefs, a.leadId) ?? alarmSoundFor(reminder, a.leadId),
        volume: alarmVolumeFor(reminder, a.leadId),
        vibrate: alarmVibrateFor(reminder, a.leadId),
      }))
      for (const o of native) {
        await VyntraAlarm.schedule(o)
      }
    } else {
      const toSchedule: ScheduleOptions['notifications'] = plan.toSchedule.map((a) => ({
        id: a.alarmId,
        title: a.title,
        body: a.body,
        schedule: { at: new Date(a.fireAt), allowWhileIdle: true },
        extra: a.extra,
        channelId: CHANNEL_MEETINGS,
      }))
      await LocalNotifications.schedule({ notifications: toSchedule })
    }
  }

  return plan
}

// ---------------------------------------------------------------------
// Configurações de som/volume/vibração por reunião
// (guardadas nas ReminderPrefs — campo `perLeadSound`)
// ---------------------------------------------------------------------
export interface MeetingSoundPrefs {
  soundUri: string | null
  volume: number // 0..100
  vibrate: boolean
}

const DEFAULT_SOUND: MeetingSoundPrefs = { soundUri: null, volume: 80, vibrate: true }

function alarmSoundFor(prefs: ReminderPrefs, leadId: string): string | undefined {
  const p = prefs.perLeadSound?.[leadId]
  return p?.soundUri ?? prefs.defaultSoundUri ?? undefined
}

function alarmVolumeFor(prefs: ReminderPrefs, leadId: string): number {
  return prefs.perLeadSound?.[leadId]?.volume ?? prefs.defaultVolume ?? DEFAULT_SOUND.volume
}

function alarmVibrateFor(prefs: ReminderPrefs, leadId: string): boolean {
  return prefs.perLeadSound?.[leadId]?.vibrate ?? prefs.defaultVibrate ?? DEFAULT_SOUND.vibrate
}

// Narração de voz conforme a antecedência da reunião (se ativada no NotifPrefs).
const REMINDER_VOICE_MAP: Record<number, string> = {
  30: 'voz_reuniao_30min',
  15: 'voz_reuniao_15min',
  10: 'voz_reuniao_10min',
  5: 'voz_reuniao_5min',
  1: 'voz_reuniao_1min',
}

function voiceUriForLead(
  reminder: ReminderPrefs,
  notifPrefs: NotifPrefs,
  leadId: string,
): string | null {
  const minutes = reminderFor(reminder, leadId)
  const voiceKey = REMINDER_VOICE_MAP[minutes]
  if (!voiceKey) return null
  if (!notifPrefs[voiceKey as keyof NotifPrefs]) return null
  return nativeVoiceUri(voiceKey)
}

export function getMeetingSoundPrefs(prefs: ReminderPrefs, leadId: string): MeetingSoundPrefs {
  return {
    soundUri: alarmSoundFor(prefs, leadId) ?? null,
    volume: alarmVolumeFor(prefs, leadId),
    vibrate: alarmVibrateFor(prefs, leadId),
  }
}

export async function setMeetingSoundPrefs(leadId: string, p: MeetingSoundPrefs): Promise<ReminderPrefs> {
  const prefs = await loadReminderPrefs()
  prefs.perLeadSound = prefs.perLeadSound ?? {}
  prefs.perLeadSound[leadId] = p
  await saveReminderPrefs(prefs)
  return prefs
}

// ---------------------------------------------------------------------
// Sons: nativos + personalizados (somente Android nativo)
// ---------------------------------------------------------------------
export async function listAlarmSounds(): Promise<{ name: string; uri: string }[]> {
  if (!isNativeAlarmAvailable()) return []
  const [nativeSounds, imported] = await Promise.all([
    VyntraAlarm.getAlarmSounds(),
    VyntraAlarm.getImportedSounds(),
  ])
  const out: { name: string; uri: string }[] = [
    { name: 'Padrão do sistema', uri: '' },
  ]
  for (const s of imported?.sounds ?? []) out.push(s)
  for (const s of nativeSounds?.sounds ?? []) out.push(s)
  return out
}

export async function importAlarmSound(data: string, fileName?: string): Promise<string> {
  const res = await VyntraAlarm.importSound({ data, fileName })
  return res.uri
}

// ---------------------------------------------------------------------
// Permissão de alarme exato (API 31+)
// ---------------------------------------------------------------------
export async function isExactAlarmAllowed(): Promise<boolean> {
  if (!isNativeAlarmAvailable()) return true
  try {
    const { allowed } = await VyntraAlarm.isExactAlarmAllowed()
    return allowed
  } catch {
    return true
  }
}

export async function requestExactAlarmPermission(): Promise<void> {
  if (!isNativeAlarmAvailable()) return
  await VyntraAlarm.requestExactAlarmPermission()
}

/**
 * Agenda imediatamente uma notificação pontual (evento realtime).
 * Se `voiceKey` for informado e estiver ativado, a narração correspondente
 * soa como som da notificação.
 */
export async function notifyEvent(
  title: string,
  body: string,
  id: number,
  voiceKey?: string,
): Promise<void> {
  if (voiceKey && isNativeAlarmAvailable()) {
    const prefs = await loadNotifPrefs()
    const key = `voz_${voiceKey}` as keyof NotifPrefs
    if (prefs[key]) {
      const soundUri = nativeVoiceUri(key)
      if (soundUri) {
        // Usa o alarme nativo com disparo imediato: o receiver toca a narração.
        await VyntraAlarm.schedule({
          id,
          fireAt: new Date(Date.now() + 1500).toISOString(),
          title,
          body,
          soundUri,
        })
        return
      }
    }
  }
  await LocalNotifications.schedule({
    notifications: [
      {
        id,
        title,
        body,
        schedule: { at: new Date(Date.now() + 1500), allowWhileIdle: true },
        channelId: CHANNEL_EVENTS,
        extra: { tab: 'notificacoes' },
      },
    ],
  })
}

// ---------------------------------------------------------------------
// Testes reais de notificação (Ajustes)
// ---------------------------------------------------------------------

/** Evento de teste — faixa reservada, fora do sync de reuniões. */
export const TEST_EVENT_ID = 995_001
export const TEST_ALARM_ID = 995_002
export const TEST_ALARM_CHANNEL = 'vyntra_test_channel'

/** Notificação de evento imediata (app aberto ou em background). */
export async function sendTestNotification(): Promise<void> {
  await notifyEvent(
    'VYNTRA',
    'Teste de notificação do Vyntra. Funcionou!',
    TEST_EVENT_ID,
  )
}

/** Notificação de evento em `delayMs` (dá tempo de ir para background). */
export async function scheduleTestEvent(delayMs = 20_000): Promise<void> {
  await LocalNotifications.schedule({
    notifications: [
      {
        id: TEST_EVENT_ID,
        title: 'VYNTRA',
        body: 'Notificação de teste agendada.',
        schedule: { at: new Date(Date.now() + delayMs), allowWhileIdle: true },
        channelId: CHANNEL_EVENTS,
        extra: { tab: 'notificacoes' },
      },
    ],
  })
}

/**
 * Alarme NATIVO em 1 minuto (AlarmManager). Este funciona com o app FECHADO
 * e em modo Doze — é o teste real do caso "app fechado".
 */
export async function scheduleTestAlarm(delayMs = 60_000): Promise<void> {
  if (isNativeAlarmAvailable()) {
    await VyntraAlarm.schedule({
      id: TEST_ALARM_ID,
      fireAt: new Date(Date.now() + delayMs).toISOString(),
      title: 'VYNTRA',
      body: 'Alarme de teste — este toca mesmo com o app fechado.',
    })
    return
  }
  await LocalNotifications.schedule({
    notifications: [
      {
        id: TEST_ALARM_ID,
        title: 'VYNTRA',
        body: 'Alarme de teste.',
        schedule: { at: new Date(Date.now() + delayMs), allowWhileIdle: true },
        channelId: CHANNEL_MEETINGS,
      },
    ],
  })
}

/** Preferências: define antecedência padrão (affects sync). */
export async function setDefaultReminder(minutes: number): Promise<void> {
  const prefs = await loadReminderPrefs()
  prefs.defaultMinutes = minutes
  await saveReminderPrefs(prefs)
}

export { alarmIdFor }
export type { VyntraPendingAlarm }
