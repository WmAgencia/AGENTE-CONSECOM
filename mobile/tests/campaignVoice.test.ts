import { describe, expect, it } from 'vitest'
import { decideCampaignVoice } from '../src/lib/campaignVoice'
import type { CampaignVoiceState } from '../src/lib/campaignVoice'

describe('decideCampaignVoice — idempotência da narração de campanha', () => {
  it('toca "iniciada" 1x por execução e ignora eventos duplicados', () => {
    const event = { id: 'c1', status: 'em_progresso', started_at: '2026-08-10T12:00:00.000Z' }
    const r1 = decideCampaignVoice({}, event)
    expect(r1.action).toBe('iniciada')

    const r2 = decideCampaignVoice(r1.next, event)
    expect(r2.action).toBeNull()
    expect(r2.next).toEqual(r1.next)
  })

  it('toca "iniciada" de novo apenas para uma nova execução (started_at diferente)', () => {
    const run1 = { id: 'c1', status: 'em_progresso', started_at: '2026-08-10T12:00:00.000Z' }
    const seen = decideCampaignVoice({}, run1)

    const run2 = { id: 'c1', status: 'em_progresso', started_at: '2026-08-11T12:00:00.000Z' }
    const r = decideCampaignVoice(seen.next, run2)
    expect(r.action).toBe('iniciada')
  })

  it('toca "finalizada" 1x e ignora repetições', () => {
    const started = { id: 'c1', status: 'em_progresso', started_at: '2026-08-10T12:00:00.000Z' }
    const s = decideCampaignVoice({}, started)

    const ended = { id: 'c1', status: 'finalizada', finished_at: '2026-08-10T18:00:00.000Z' }
    const r1 = decideCampaignVoice(s.next, ended)
    expect(r1.action).toBe('finalizada')

    const r2 = decideCampaignVoice(r1.next, ended)
    expect(r2.action).toBeNull()
  })

  it('sucesso/falha de mensagem (bump de contadores) NUNCA disparam voz', () => {
    const started = { id: 'c1', status: 'em_progresso', started_at: '2026-08-10T12:00:00.000Z' }
    const s = decideCampaignVoice({}, started)
    expect(s.action).toBe('iniciada')

    // UPDATEs que antes causavam replay de "campanha iniciada":
    const bumps = [
      { id: 'c1', status: 'em_progresso', started_at: '2026-08-10T12:00:00.000Z', success_count: 1, fail_count: 0 },
      { id: 'c1', status: 'em_progresso', started_at: '2026-08-10T12:00:00.000Z', success_count: 2, fail_count: 0 },
      { id: 'c1', status: 'em_progresso', started_at: '2026-08-10T12:00:00.000Z', success_count: 2, fail_count: 1 },
    ]
    for (const ev of bumps) {
      const r = decideCampaignVoice(s.next, ev)
      expect(r.action).toBeNull()
    }
  })

  it('"cancelada" reporta ação uma vez e segue ignorando', () => {
    const r1 = decideCampaignVoice({}, { id: 'c1', status: 'cancelada' })
    expect(r1.action).toBe('cancelada')
    const r2 = decideCampaignVoice(r1.next, { id: 'c1', status: 'cancelada' })
    expect(r2.action).toBe('cancelada')
  })

  it('estados sem id ou sem status relevante retornam null sem mutar o estado', () => {
    const state: CampaignVoiceState = {}
    expect(decideCampaignVoice(state, { id: null, status: 'em_progresso' }).action).toBeNull()
    expect(decideCampaignVoice(state, { id: 'c1', status: 'qualquer_coisa' }).action).toBeNull()
    expect(decideCampaignVoice(state, { id: 'c1', status: null }).action).toBeNull()
  })
})