import { LocalNotifications, type ScheduleOptions } from '@capacitor/local-notifications'
import {
  loadReminderPrefs,
  saveReminderPrefs,
} from '../lib/types'
import { computeAlarmPlan, alarmIdFor } from '../core/syncEngine'
import type { Lead } from '../lib/types'

// =====================================================================
// Serviço de alarmes (Local Notifications = AlarmManager nativo do Android).
//   - Cria canal dedicado de reuniões (importância alta)
//   - `syncAlarms()` aplica o plano do motor de sync
//   - Restaura/cancela alarmes de forma idempotente
// =====================================================================

const CHANNEL_MEETINGS = 'consecom-meetings'
const CHANNEL_EVENTS = 'consecom-events'

export async function ensureChannels(): Promise<void> {
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
  const current = await LocalNotifications.checkPermissions()
  if (current.display === 'granted') return true
  const req = await LocalNotifications.requestPermissions()
  return req.display === 'granted'
}

export async function areNotificationsEnabled(): Promise<boolean> {
  const s = await LocalNotifications.checkPermissions()
  return s.display === 'granted'
}

async function currentScheduledMap(): Promise<Map<number, string>> {
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
  const scheduled = await currentScheduledMap()

  const plan = computeAlarmPlan({ leads, scheduled, reminder, now })

  // CANCEL primeiro (mudança de status / reagendamento)
  if (plan.toCancel.length > 0) {
    await LocalNotifications.cancel({
      notifications: plan.toCancel.map((id: number) => ({ id })),
    })
  }

  // AGENDA/ATUALIZA: mesmo id substitui o pendente anterior (reagendamento)
  const toSchedule: ScheduleOptions['notifications'] = plan.toSchedule.map((a) => ({
    id: a.alarmId,
    title: a.title,
    body: a.body,
    schedule: { at: new Date(a.fireAt), allowWhileIdle: true },
    extra: a.extra,
    channelId: CHANNEL_MEETINGS,
  }))

  if (toSchedule.length > 0) {
    await LocalNotifications.schedule({ notifications: toSchedule })
  }

  return plan
}

/** Agenda imediatamente uma notificação pontual (evento realtime). */
export async function notifyEvent(
  title: string,
  body: string,
  id: number,
): Promise<void> {
  await LocalNotifications.schedule({
    notifications: [
      {
        id,
        title,
        body,
        schedule: { at: new Date(Date.now() + 1500), allowWhileIdle: true },
        channelId: CHANNEL_EVENTS,
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
