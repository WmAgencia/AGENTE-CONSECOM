import { describe, expect, it } from 'vitest'
import {
  computeAlarmPlan,
  alarmIdFor,
  buildAlarm,
  formatMeetingBody,
  reminderFor,
} from '../src/core/syncEngine'
import type { Lead, ReminderPrefs } from '../src/lib/types'

function makeLead(overrides: Partial<Lead>): Lead {
  return {
    id: 'lead-1',
    name: 'Clínica Bella',
    phone: null,
    category: null,
    website: null,
    city: null,
    state: null,
    status: 'reuniao_marcada',
    last_message_sent: null,
    meeting_at: '2026-08-12T18:00:00-03:00',
    meeting_notes: 'Apresentação do novo site',
    session_id: null,
    campaign_id: null,
    no_interest_until: null,
    closed_reason: null,
    closed_at: null,
    remarket_at: null,
    created_at: '2026-08-10T10:00:00Z',
    updated_at: '2026-08-10T10:00:00Z',
    ...overrides,
  }
}

const defaultPrefs: ReminderPrefs = { defaultMinutes: 30, perLead: {} }

const EMPTY = new Map<number, string>()

describe('computeAlarmPlan — criação', () => {
  it('agenda alarme de reunião futura com antecedência padrão', () => {
    const now = new Date('2026-08-12T10:00:00Z').getTime()
    const plan = computeAlarmPlan({ leads: [makeLead({})], scheduled: EMPTY, reminder: defaultPrefs, now })

    expect(plan.toSchedule).toHaveLength(1)
    const a = plan.toSchedule[0]
    expect(a.leadId).toBe('lead-1')
    expect(a.alarmId).toBe(alarmIdFor('lead-1'))
    // 18:00 -03:00 = 21:00Z; menos 30min = 20:30Z
    expect(a.fireAt).toBe('2026-08-12T20:30:00.000Z')
    expect(plan.toCancel).toHaveLength(0)
  })

  it('ID determinístico: mesmo lead sempre gera o mesmo alarme (não duplica)', () => {
    expect(alarmIdFor('abc')).toBe(alarmIdFor('abc'))
    expect(alarmIdFor('abc')).not.toBe(alarmIdFor('abd'))
  })

  it('dupla sincronização não gera duplicatas (unchanged)', () => {
    const now = new Date('2026-08-12T10:00:00Z').getTime()
    const plan1 = computeAlarmPlan({ leads: [makeLead({})], scheduled: EMPTY, reminder: defaultPrefs, now })
    const scheduled = new Map([[plan1.toSchedule[0].alarmId, plan1.toSchedule[0].fireAt]])
    const plan2 = computeAlarmPlan({ leads: [makeLead({})], scheduled, reminder: defaultPrefs, now })

    expect(plan2.toSchedule).toHaveLength(0)
    expect(plan2.toCancel).toHaveLength(0)
    expect(plan2.unchanged).toEqual(['lead-1'])
  })
})

describe('computeAlarmPlan — alteração e reagendamento', () => {
  it('reunião mudou de horário → reagenda (mesmo id, fireAt novo)', () => {
    const now = new Date('2026-08-12T10:00:00Z').getTime()
    const first = computeAlarmPlan({ leads: [makeLead({})], scheduled: EMPTY, reminder: defaultPrefs, now })
    const scheduled = new Map([[first.toSchedule[0].alarmId, first.toSchedule[0].fireAt]])

    const changed = makeLead({ meeting_at: '2026-08-12T19:00:00-03:00' })
    const plan2 = computeAlarmPlan({ leads: [changed], scheduled, reminder: defaultPrefs, now })

    expect(plan2.toSchedule).toHaveLength(1)
    expect(plan2.toSchedule[0].alarmId).toBe(first.toSchedule[0].alarmId)
    expect(plan2.toSchedule[0].fireAt).toBe('2026-08-12T21:30:00.000Z')
  })

  it('antecedência por lead (override) altera o fireAt', () => {
    const now = new Date('2026-08-12T10:00:00Z').getTime()
    const prefs = { defaultMinutes: 30, perLead: { 'lead-1': 60 } }
    const plan = computeAlarmPlan({ leads: [makeLead({})], scheduled: EMPTY, reminder: prefs, now })
    expect(plan.toSchedule[0].fireAt).toBe('2026-08-12T20:00:00.000Z')
    expect(reminderFor(prefs, 'lead-1')).toBe(60)
  })
})

describe('computeAlarmPlan — cancelamento', () => {
  it('status sai de reuniao_marcada → cancela', () => {
    const now = new Date('2026-08-12T10:00:00Z').getTime()
    const first = computeAlarmPlan({ leads: [makeLead({})], scheduled: EMPTY, reminder: defaultPrefs, now })
    const scheduled = new Map([[first.toSchedule[0].alarmId, first.toSchedule[0].fireAt]])

    const canceled = makeLead({ status: 'reuniao_cancelada' })
    const plan2 = computeAlarmPlan({ leads: [canceled], scheduled, reminder: defaultPrefs, now })

    expect(plan2.toCancel).toContain(first.toSchedule[0].alarmId)
    expect(plan2.toSchedule).toHaveLength(0)
  })

  it('lead sem meeting_at → cancela', () => {
    const now = new Date('2026-08-12T10:00:00Z').getTime()
    const first = computeAlarmPlan({ leads: [makeLead({})], scheduled: EMPTY, reminder: defaultPrefs, now })
    const scheduled = new Map([[first.toSchedule[0].alarmId, first.toSchedule[0].fireAt]])

    const noMeeting = makeLead({ meeting_at: null })
    const plan2 = computeAlarmPlan({ leads: [noMeeting], scheduled, reminder: defaultPrefs, now })
    expect(plan2.toCancel).toContain(first.toSchedule[0].alarmId)
  })

  it('lead removido da listagem → cancela alarme órfão', () => {
    const now = new Date('2026-08-12T10:00:00Z').getTime()
    const orphanId = alarmIdFor('lead-removido')
    const scheduled = new Map([[orphanId, '2026-08-12T20:30:00.000Z']])
    const plan = computeAlarmPlan({ leads: [makeLead({})], scheduled, reminder: defaultPrefs, now })
    expect(plan.toCancel).toContain(orphanId)
  })
})

describe('computeAlarmPlan — casos de borda', () => {
  it('antecedência já passou (permissão negada / offline) → não agenda no passado', () => {
    const now = new Date('2026-08-12T21:00:00Z').getTime() // reunião 21:00Z, alarme 20:30Z já passou
    const plan = computeAlarmPlan({ leads: [makeLead({})], scheduled: EMPTY, reminder: defaultPrefs, now })
    expect(plan.toSchedule).toHaveLength(0)
    expect(plan.skippedPast).toEqual(['lead-1'])
  })

  it('alarme existente no passado com reunião futura próxima → mantém se ainda futuro', () => {
    const now = new Date('2026-08-12T20:40:00Z').getTime()
    // alarme antigo 20:30Z já disparou; reunião 21:00Z ainda futura
    const scheduled = new Map([[alarmIdFor('lead-1'), '2026-08-12T20:30:00.000Z']])
    const plan = computeAlarmPlan({ leads: [makeLead({})], scheduled, reminder: defaultPrefs, now })
    expect(plan.toCancel).toContain(alarmIdFor('lead-1'))
    expect(plan.toSchedule).toHaveLength(0)
  })

  it('meeting_at inválido não quebra o sync', () => {
    const now = new Date('2026-08-12T10:00:00Z').getTime()
    const bad = makeLead({ meeting_at: 'not-a-date' })
    const plan = computeAlarmPlan({ leads: [bad], scheduled: EMPTY, reminder: defaultPrefs, now })
    expect(plan.toSchedule).toHaveLength(0)
  })

  it('reunião no passado não agenda nada', () => {
    const now = new Date('2026-08-13T10:00:00Z').getTime()
    const past = makeLead({ meeting_at: '2026-08-12T09:00:00Z' })
    const plan = computeAlarmPlan({ leads: [past], scheduled: EMPTY, reminder: defaultPrefs, now })
    expect(plan.toSchedule).toHaveLength(0)
  })
})

describe('formatMeetingBody — texto da notificação', () => {
  it('inclui data, hora, nome e observação', () => {
    const body = formatMeetingBody('Clínica Bella', new Date('2026-08-12T18:00:00-03:00'), 'Apresentação')
    expect(body).toContain('Clínica Bella')
    expect(body).toContain('Apresentação')
    expect(body).toMatch(/\d{1,2}:\d{2}/)
  })

  it('nome vazio cai para fallback', () => {
    expect(formatMeetingBody(null, new Date(), null)).toContain('Reunião')
  })
})

describe('buildAlarm — estrutura', () => {
  it('gera alarme com extra do lead e meeting_at', () => {
    const lead = makeLead({})
    const meetingAt = new Date(lead.meeting_at!)
    const alarm = buildAlarm(lead, meetingAt, new Date(meetingAt.getTime() - 30 * 60_000))
    expect(alarm.extra).toEqual({ leadId: 'lead-1', meetingAt: meetingAt.toISOString() })
    expect(alarm.title).toContain('Reunião')
  })
})
