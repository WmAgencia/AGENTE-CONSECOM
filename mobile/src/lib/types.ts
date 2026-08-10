import { Preferences } from '@capacitor/preferences'

export type LeadStatus =
  | 'novo'
  | 'na_fila'
  | 'enviado'
  | 'conversando'
  | 'sem_interesse'
  | 'remarketing'
  | 'reuniao_marcada'
  | 'reuniao_cancelada'
  | 'fechado'
  | 'nao_fechado'
  | 'para_ligacao'

export interface Lead {
  id: string
  name: string | null
  phone: string | null
  category: string | null
  website: string | null
  city: string | null
  state: string | null
  status: LeadStatus
  last_message_sent: string | null
  meeting_at: string | null
  meeting_notes: string | null
  session_id: string | null
  campaign_id: string | null
  no_interest_until: string | null
  closed_reason: string | null
  closed_at: string | null
  remarket_at: string | null
  created_at: string
  updated_at: string
}

export interface ConversationMessage {
  id: string
  lead_id: string
  role: 'user' | 'assistant'
  content: string
  agent_model: string | null
  created_at: string
}

export interface Campaign {
  id: string
  name: string
  description: string | null
  is_active: boolean
  status: 'pronta' | 'em_progresso' | 'finalizada' | 'cancelada'
  started_at: string | null
  finished_at: string | null
  lead_count: number
  success_count: number
  fail_count: number
  created_at: string
}

export type SendRunStatus = 'pending' | 'running' | 'done' | 'failed'

export interface SendRun {
  id: string
  campaign_id: string
  lead_id: string
  status: SendRunStatus
  current_position: number
  next_send_at: string | null
  last_sent_at: string | null
  created_at: string
}

export interface WhatsAppConnection {
  id: string
  user_id: string
  instance_name: string
  status: 'pending' | 'connected' | 'disconnected' | 'error'
  qr_code: string | null
  phone: string | null
  created_at: string
  updated_at: string
}

// ---- Preferências locais do app (alarmes e notificações) ----

export const PREF_KEYS = {
  settings: 'consecom.mobile.settings.v1',
  alarmRegistry: 'consecom.mobile.alarmRegistry.v1',
  notifPrefs: 'consecom.mobile.notifPrefs.v1',
} as const

export interface ReminderPrefs {
  defaultMinutes: number
  // antecedência por lead (override), chave = lead id
  perLead: Record<string, number>
  // som/volume/vibração por lead (override), chave = lead id
  perLeadSound?: Record<string, { soundUri: string | null; volume: number; vibrate: boolean }>
  // configurações padrão (fallback)
  defaultSoundUri?: string | null
  defaultVolume?: number
  defaultVibrate?: boolean
}

export interface NotifPrefs {
  reuniao_marcada: boolean
  reuniao_cancelada: boolean
  reuniao_reagendada: boolean
  lead_respondeu: boolean
  campanha_iniciada: boolean
  campanha_concluida: boolean
  campanha_erro: boolean
  whatsapp_desconectado: boolean
  alex_evento: boolean
  // Narrações de voz (ElevenLabs) — toggle por notificação
  voz_reuniao_30min: boolean
  voz_reuniao_15min: boolean
  voz_reuniao_10min: boolean
  voz_reuniao_5min: boolean
  voz_reuniao_1min: boolean
  voz_reuniao_marcada: boolean
  voz_reuniao_cancelada: boolean
  voz_reuniao_reagendada: boolean
  voz_campanha_iniciada: boolean
  voz_campanha_concluida: boolean
  voz_campanha_atencao: boolean
  voz_lead_atencao: boolean
  voz_whatsapp_desconectado: boolean
  voz_resumo_diario: boolean
}

export const DEFAULT_NOTIF_PREFS: NotifPrefs = {
  reuniao_marcada: true,
  reuniao_cancelada: true,
  reuniao_reagendada: true,
  lead_respondeu: true,
  campanha_iniciada: true,
  campanha_concluida: true,
  campanha_erro: true,
  whatsapp_desconectado: true,
  alex_evento: true,
  // Narrações de voz — padrão: ativadas
  voz_reuniao_30min: true,
  voz_reuniao_15min: true,
  voz_reuniao_10min: true,
  voz_reuniao_5min: true,
  voz_reuniao_1min: true,
  voz_reuniao_marcada: true,
  voz_reuniao_cancelada: true,
  voz_reuniao_reagendada: true,
  voz_campanha_iniciada: true,
  voz_campanha_concluida: true,
  voz_campanha_atencao: true,
  voz_lead_atencao: true,
  voz_whatsapp_desconectado: true,
  voz_resumo_diario: true,
}

export const DEFAULT_REMINDER_PREFS: ReminderPrefs = {
  defaultMinutes: 30,
  perLead: {},
  perLeadSound: {},
  defaultSoundUri: null,
  defaultVolume: 80,
  defaultVibrate: true,
}

const NOTIF_LABELS: Record<keyof NotifPrefs, string> = {
  reuniao_marcada: 'Reunião marcada',
  reuniao_cancelada: 'Reunião cancelada',
  reuniao_reagendada: 'Reunião reagendada',
  lead_respondeu: 'Lead respondeu',
  campanha_iniciada: 'Campanha iniciada',
  campanha_concluida: 'Campanha concluída',
  campanha_erro: 'Campanha com erro',
  whatsapp_desconectado: 'WhatsApp desconectado',
  alex_evento: 'Eventos do Alex',
  voz_reuniao_30min: 'Reunião em 30 min',
  voz_reuniao_15min: 'Reunião em 15 min',
  voz_reuniao_10min: 'Reunião em 10 min',
  voz_reuniao_5min: 'Reunião em 5 min',
  voz_reuniao_1min: 'Reunião em 1 min',
  voz_reuniao_marcada: 'Nova reunião agendada',
  voz_reuniao_cancelada: 'Reunião cancelada',
  voz_reuniao_reagendada: 'Reunião reagendada',
  voz_campanha_iniciada: 'Campanha iniciada',
  voz_campanha_concluida: 'Campanha concluída',
  voz_campanha_atencao: 'Campanha precisa de atenção',
  voz_lead_atencao: 'Lead precisa de atenção',
  voz_whatsapp_desconectado: 'WhatsApp desconectado',
  voz_resumo_diario: 'Resumo diário',
}

export function notifPrefLabel(key: keyof NotifPrefs): string {
  return NOTIF_LABELS[key]
}

export async function loadReminderPrefs(): Promise<ReminderPrefs> {
  const { value } = await Preferences.get({ key: PREF_KEYS.settings })
  if (!value) return { ...DEFAULT_REMINDER_PREFS }
  try {
    const parsed = JSON.parse(value) as Partial<ReminderPrefs>
    return {
      defaultMinutes: parsed.defaultMinutes ?? DEFAULT_REMINDER_PREFS.defaultMinutes,
      perLead: parsed.perLead ?? {},
      perLeadSound: parsed.perLeadSound ?? {},
      defaultSoundUri: parsed.defaultSoundUri ?? null,
      defaultVolume: parsed.defaultVolume ?? DEFAULT_REMINDER_PREFS.defaultVolume,
      defaultVibrate: parsed.defaultVibrate ?? DEFAULT_REMINDER_PREFS.defaultVibrate,
    }
  } catch {
    return { ...DEFAULT_REMINDER_PREFS }
  }
}

export async function saveReminderPrefs(prefs: ReminderPrefs): Promise<void> {
  await Preferences.set({ key: PREF_KEYS.settings, value: JSON.stringify(prefs) })
}

export async function setLeadReminder(leadId: string, minutes: number): Promise<ReminderPrefs> {
  const prefs = await loadReminderPrefs()
  prefs.perLead[leadId] = minutes
  await saveReminderPrefs(prefs)
  return prefs
}

export async function clearLeadReminder(leadId: string): Promise<ReminderPrefs> {
  const prefs = await loadReminderPrefs()
  delete prefs.perLead[leadId]
  await saveReminderPrefs(prefs)
  return prefs
}

export async function loadNotifPrefs(): Promise<NotifPrefs> {
  const { value } = await Preferences.get({ key: PREF_KEYS.notifPrefs })
  if (!value) return { ...DEFAULT_NOTIF_PREFS }
  try {
    return { ...DEFAULT_NOTIF_PREFS, ...(JSON.parse(value) as Partial<NotifPrefs>) }
  } catch {
    return { ...DEFAULT_NOTIF_PREFS }
  }
}

export async function saveNotifPrefs(prefs: NotifPrefs): Promise<void> {
  await Preferences.set({ key: PREF_KEYS.notifPrefs, value: JSON.stringify(prefs) })
}
