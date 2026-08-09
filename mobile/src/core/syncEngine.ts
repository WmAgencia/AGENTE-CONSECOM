import type { Lead, ReminderPrefs } from '../lib/types'

// =====================================================================
// Motor de sincronização de reuniões -> alarmes locais (puro/testável).
//
// Decide, para cada lead com reunião, o conjunto de operações de alarme:
//   - CREATE / UPDATE: agenda (id derivado de forma determinística do lead)
//   - CANCEL: cancela alarme de lead que saiu de `reuniao_marcada`
//
// Sem estado externo (sem I/O) → testável com Vitest cobrindo: criar,
// alterar, cancelar, reagendar, dupla sincronização (sem duplicar),
// offline (sem agendar nada novo se já tem), permissões negadas (idempotente)
// e timezone (meeting_at ISO → horário local via Date).
// =====================================================================

export const MEETING_STATUS = 'reuniao_marcada'
export const CANCELED_STATUS = 'reuniao_cancelada'

/**
 * Faixa de IDs reservada para eventos pontuais (não-reunião) disparados
 * pelo módulo nativo. O motor de sync de reuniões ignora esses IDs no loop
 * de "leads sumiram" — senão cancelaria os alarmes efêmeros de evento.
 */
export const EVENT_ALARM_ID_BASE = 2_000_000_000

/** ID de alarme determinístico derivado do lead (evita duplicação). */
export function alarmIdFor(leadId: string): number {
  let h = 2166136261
  for (let i = 0; i < leadId.length; i++) {
    h ^= leadId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) % 2_000_000_000
}

export interface ScheduledAlarm {
  alarmId: number
  leadId: string
  /** instante ISO (UTC) em que o alarme deve disparar */
  fireAt: string
  title: string
  body: string
  /** payload para devolver ao abrir */
  extra: { leadId: string; meetingAt: string | null }
}

export interface SyncInput {
  leads: Lead[]
  /** alarmes atualmente agendados no SO (id -> fireAt) */
  scheduled: Map<number, string>
  /** prefs de antecedência (padrão + override por lead) */
  reminder: ReminderPrefs
  /** now em ms (injetável p/ testes) */
  now?: number
}

export interface SyncResult {
  /** alarmes para agendar/atualizar */
  toSchedule: ScheduledAlarm[]
  /** ids de alarmes a cancelar (lead saiu de reuniao_marcada ou sumiu) */
  toCancel: number[]
  /** ids de leads cujo alarme já estava correto (sem mudança) */
  unchanged: string[]
  /** reuniões com antecedência já no passado -> não agenda (permissão negada/offline) */
  skippedPast: string[]
}

const ms = (n: number) => n * 60_000

export function reminderFor(prefs: ReminderPrefs, leadId: string): number {
  return prefs.perLead[leadId] ?? prefs.defaultMinutes
}

export function meetingFireAt(meetingAt: Date, leadId: string, prefs: ReminderPrefs): number {
  return meetingAt.getTime() - ms(reminderFor(prefs, leadId))
}

export function buildAlarm(
  lead: Lead,
  meetingAt: Date,
  fireAt: Date,
): ScheduledAlarm {
  return {
    alarmId: alarmIdFor(lead.id),
    leadId: lead.id,
    fireAt: fireAt.toISOString(),
    title: '🔔 Reunião agendada',
    body: formatMeetingBody(lead.name, meetingAt, lead.meeting_notes),
    extra: { leadId: lead.id, meetingAt: meetingAt.toISOString() },
  }
}

export function formatMeetingBody(
  name: string | null,
  meetingAt: Date,
  notes: string | null,
): string {
  const time = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(meetingAt)
  const nome = name?.trim()
  return `${time} · ${nome ?? 'Reunião'}${notes?.trim() ? ` — ${notes.trim()}` : ''}`
}

/** Núcleo do sync: calcula as operações a aplicar. 100% determinístico. */
export function computeAlarmPlan(input: SyncInput): SyncResult {
  const now = input.now ?? Date.now()
  const toSchedule: ScheduledAlarm[] = []
  const toCancel: number[] = []
  const unchanged: string[] = []
  const skippedPast: string[] = []
  const seenLeads = new Set<string>()

  for (const lead of input.leads) {
    seenLeads.add(lead.id)

    // 1) Fora de reuniao_marcada -> cancela qualquer alarme
    if (lead.status !== MEETING_STATUS || !lead.meeting_at) {
      if (input.scheduled.has(alarmIdFor(lead.id))) {
        toCancel.push(alarmIdFor(lead.id))
      }
      continue
    }

    // 2) Horário da reunião (ISO → Date; timezone do aparelho aplicada pelo SO)
    const meetingAt = new Date(lead.meeting_at)
    if (Number.isNaN(meetingAt.getTime())) {
      if (input.scheduled.has(alarmIdFor(lead.id))) toCancel.push(alarmIdFor(lead.id))
      continue
    }

    const fireAtMs = meetingFireAt(meetingAt, lead.id, input.reminder)

    // 3) Antecedência já passou (permissão negada, offline, mudança tardia)
    //    -> não agenda no passado (evita disparo imediato indesejado)
    if (fireAtMs <= now) {
      skippedPast.push(lead.id)
      if (input.scheduled.has(alarmIdFor(lead.id))) {
        // reunião mudou para dentro da antecedência: mantém o que existe se ainda futuro? Não.
        // Se o alarme existente também já passou, cancela; se ainda vale, mantém.
        const existing = input.scheduled.get(alarmIdFor(lead.id))
        if (existing && new Date(existing).getTime() <= now) {
          toCancel.push(alarmIdFor(lead.id))
        }
      }
      continue
    }

    const fireAt = new Date(fireAtMs)
    const alarm = buildAlarm(lead, meetingAt, fireAt)
    const existing = input.scheduled.get(alarm.alarmId)

    // 4) Já agendado e com o MESMO horário -> sem mudança
    if (existing && existing === alarm.fireAt) {
      unchanged.push(lead.id)
      continue
    }

    // 5) Mudou (reagendamento) ou novo -> agenda (mesmo id substitui no SO)
    toSchedule.push(alarm)
  }

  // Leads que sumiram da listagem e tinham alarme -> cancela
  for (const [alarmId] of input.scheduled) {
    // Ignora IDs da faixa de eventos pontuais (não pertencem a leads)
    if (alarmId >= EVENT_ALARM_ID_BASE) continue
    const owner = [...input.leads].find((l) => alarmIdFor(l.id) === alarmId)
    if (!owner || !seenLeads.has(owner.id)) {
      toCancel.push(alarmId)
    }
  }

  return { toSchedule, toCancel, unchanged, skippedPast }
}
