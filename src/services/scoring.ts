/**
 * Lead scoring service (0-100).
 *
 * Computes a lightweight heuristic score from the structured signals available
 * on a lead (status/progress, conversation engagement, meeting and sale state).
 * The score is deterministic, explainable (returns the contributing factors) and
 * safe to compute anywhere — no model calls involved.
 *
 * Bands (0-100):
 *   0-20   baixa prioridade
 *   21-40  potencial baixo
 *   41-60  lead interessante
 *   61-80  lead qualificado
 *   81-100 alta prioridade
 */
export interface ScoreInput {
  status: string | null;
  hasConversation: boolean;
  messagesCount: number;
  meetingBooked: boolean;
  meetingOutcome: string | null;
  saleStatus: string | null;
  problemIdentified: boolean;
  interestLevel: string | null;
}

export interface ScoreResult {
  score: number;
  band: 'baixa_prioridade' | 'potencial_baixo' | 'interessante' | 'qualificado' | 'alta_prioridade';
  factors: string[];
}

/** Maps a funnel status to a base engagement weight. */
const STATUS_BASE: Record<string, number> = {
  novo: 5,
  na_fila: 8,
  enviado: 15,
  conversando: 35,
  remarketing: 22,
  sem_interesse: 2,
  reuniao_marcada: 65,
  reuniao_cancelada: 25,
  fechado: 95,
  nao_fechado: 40,
};

export function bandOf(score: number): ScoreResult['band'] {
  if (score <= 20) return 'baixa_prioridade';
  if (score <= 40) return 'potencial_baixo';
  if (score <= 60) return 'interessante';
  if (score <= 80) return 'qualificado';
  return 'alta_prioridade';
}

export function computeLeadScore(input: ScoreInput): ScoreResult {
  const factors: string[] = [];
  let score = STATUS_BASE[input.status ?? 'novo'] ?? 5;
  factors.push(`status:${input.status ?? 'novo'}=${score}`);

  if (input.hasConversation) {
    score += 10;
    factors.push('conversa_ativa=+10');
  }

  const msgs = Math.min(input.messagesCount, 20);
  if (msgs > 0) {
    const bonus = Math.min(msgs * 1.5, 15);
    score += bonus;
    factors.push(`mensagens=${msgs}=+${bonus.toFixed(1)}`);
  }

  if (input.problemIdentified) {
    score += 12;
    factors.push('problema_identificado=+12');
  }

  if (input.interestLevel === 'alto') {
    score += 8;
    factors.push('interesse_alto=+8');
  } else if (input.interestLevel === 'medio') {
    score += 4;
    factors.push('interesse_medio=+4');
  }

  if (input.meetingBooked) {
    score += 20;
    factors.push('reuniao_marcada=+20');
  }

  if (input.saleStatus === 'venda') {
    score += 25;
    factors.push('venda=+25');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, band: bandOf(score), factors };
}
