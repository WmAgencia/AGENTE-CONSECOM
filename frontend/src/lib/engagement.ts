import { type Lead, type LeadStatus, type ConversationMessage } from './supabase'

/**
 * Cálculo de engajamento de um lead na conversa (0-100).
 *
 * Sub-métricas:
 *  - velocidade: quão rápido o lead responde às mensagens (mediana dos gaps
 *    entre a mensagem do agente e a resposta seguinte do lead).
 *  - volume: quantidade de mensagens enviadas pelo lead.
 *  - interesse: score heurístico já calculado pelo backend (lead.score) ou um
 *    fallback derivado do status do funil.
 *  - reuniao: sinal de interesse quando o lead chegou a marcar/participar de
 *    reunião (mais forte que qualquer conversa).
 *
 * O total é uma média ponderada das sub-métricas disponíveis.
 */

export interface EngagementSub {
  velocidade: number
  volume: number
  interesse: number
  reuniao: number | null
}

export interface Engagement {
  total: number
  emoji: string
  label: string
  band: 'alto' | 'bom' | 'medio' | 'baixo' | 'nenhum'
  sub: EngagementSub
}

const EMOJI: Record<Engagement['band'], string> = {
  alto: '🔥',
  bom: '😃',
  medio: '🙂',
  baixo: '😕',
  nenhum: '😴',
}

const LABEL: Record<Engagement['band'], string> = {
  alto: 'Alto engajamento',
  bom: 'Bom engajamento',
  medio: 'Engajamento médio',
  baixo: 'Baixo engajamento',
  nenhum: 'Quase nenhum engajamento',
}

function bandOf(total: number): Engagement['band'] {
  if (total >= 80) return 'alto'
  if (total >= 60) return 'bom'
  if (total >= 40) return 'medio'
  if (total >= 20) return 'baixo'
  return 'nenhum'
}

/** Mediana de uma lista (ordena e pega o valor central). */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/** Converte um gap (ms) entre mensagens em uma nota 0-100 de velocidade. */
function speedScore(gapMs: number): number {
  const minutes = gapMs / 60000
  if (minutes <= 5) return 100
  if (minutes <= 30) return 80
  if (minutes <= 120) return 60
  if (minutes <= 480) return 40
  if (minutes <= 1440) return 25
  return 10
}

/** Converte a quantidade de mensagens do lead em uma nota 0-100 de volume. */
function volumeScore(count: number): number {
  if (count <= 0) return 0
  if (count === 1) return 30
  if (count <= 3) return 50
  if (count <= 6) return 70
  if (count <= 10) return 85
  return 100
}

/** Fallback de interesse baseado no status do funil (quando não há score). */
const STATUS_INTEREST: Record<LeadStatus, number> = {
  novo: 20,
  na_fila: 20,
  enviado: 30,
  conversando: 55,
  remarketing: 45,
  sem_interesse: 10,
  reuniao_marcada: 88,
  reuniao_cancelada: 35,
  fechado: 100,
  nao_fechado: 40,
  para_ligacao: 25,
  responder_depois: 50,
}

/** Sinal de interesse por reunião (null quando não houve reunião). */
function meetingScore(status: LeadStatus): number | null {
  if (status === 'reuniao_marcada') return 90
  if (status === 'fechado') return 100
  if (status === 'nao_fechado') return 45
  if (status === 'reuniao_cancelada') return 30
  return null
}

export function computeEngagement(
  lead: Pick<Lead, 'id' | 'status' | 'score'>,
  messages: ConversationMessage[],
): Engagement {
  const userMsgs = messages.filter((m) => m.role === 'user')

  // --- velocidade: gaps entre a msg do agente e a resposta do lead ---
  const gaps: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== 'user') continue
    for (let j = i - 1; j >= 0; j--) {
      if (messages[j].role === 'assistant') {
        const gap = new Date(m.created_at).getTime() - new Date(messages[j].created_at).getTime()
        if (gap > 0) gaps.push(gap)
        break
      }
    }
  }
  const medGap = median(gaps)
  const velocidade = medGap === null ? 50 : speedScore(medGap)

  // --- volume ---
  const volume = volumeScore(userMsgs.length)

  // --- interesse ---
  const score = typeof lead.score === 'number' ? lead.score : null
  const interesse = score ?? STATUS_INTEREST[lead.status] ?? 40

  // --- reunião ---
  const reuniao = meetingScore(lead.status)

  // --- média ponderada das sub-métricas disponíveis ---
  const weights: Array<{ value: number; w: number }> = [
    { value: velocidade, w: 0.3 },
    { value: volume, w: 0.25 },
    { value: interesse, w: 0.35 },
  ]
  if (reuniao !== null) weights.push({ value: reuniao, w: 0.1 })

  const totalWeight = weights.reduce((acc, x) => acc + x.w, 0)
  const total = Math.max(
    0,
    Math.min(
      100,
      Math.round(weights.reduce((acc, x) => acc + x.value * x.w, 0) / totalWeight),
    ),
  )

  const band = bandOf(total)
  return {
    total,
    emoji: EMOJI[band],
    label: LABEL[band],
    band,
    sub: { velocidade, volume, interesse, reuniao },
  }
}
