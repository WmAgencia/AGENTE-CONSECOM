import { registerPlugin } from '@capacitor/core'
import { Capacitor } from '@capacitor/core'

// =====================================================================
// Bridge para o módulo nativo VyntraAlarm (AlarmManager real do Android).
//   - Alarme exato (soa mesmo com o app fechado / em Doze)
//   - Som, volume e vibração configuráveis por reunião
//   - Sons nativos do sistema (RingtoneManager) + sons personalizados
//   - Restaura alarmes após reboot (BOOT_COMPLETED)
//   - Permissão de alarme exato (API 31+)
// =====================================================================

export interface VyntraAlarmSound {
  name: string
  uri: string
}

export interface VyntraPendingAlarm {
  id: number
  fireAt: string
  title: string
  body: string
  soundUri: string
  volume: number
  vibrate: boolean
}

export interface ScheduleAlarmOptions {
  id: number
  fireAt: string
  title: string
  body: string
  soundUri?: string
  volume?: number
  vibrate?: boolean
}

export interface VyntraAlarmPlugin {
  schedule(options: ScheduleAlarmOptions): Promise<void>
  cancel(options: { id: number }): Promise<void>
  cancelAll(): Promise<void>
  getPending(): Promise<{ alarms: VyntraPendingAlarm[] }>
  getAlarmSounds(): Promise<{ sounds: VyntraAlarmSound[] }>
  getImportedSounds(): Promise<{ sounds: VyntraAlarmSound[] }>
  importSound(options: { data: string; fileName?: string }): Promise<{ uri: string }>
  isExactAlarmAllowed(): Promise<{ allowed: boolean }>
  requestExactAlarmPermission(): Promise<void>
}

const VyntraAlarm = registerPlugin<VyntraAlarmPlugin>('VyntraAlarm')

/** true se estamos rodando dentro do Android nativo (não no browser). */
export function isNativeAlarmAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
}

export default VyntraAlarm
