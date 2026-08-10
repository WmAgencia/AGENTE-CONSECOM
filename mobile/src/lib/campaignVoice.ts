// =====================================================================
// Decisão idempotente da narração de campanha (pura/testável).
//
// A voz de início/finalização de campanha NÃO pode depender do `old` da
// linha do banco (replica identity pode não entregar a linha antiga, o que
// faria a narração de "campanha iniciada" tocar em qualquer UPDATE de
// campanha — inclusive sucesso/falha de cada mensagem). Aqui a decisão é
// amarrada ao `campaignRunId` (id + started_at / finished_at) e o estado
// "já tocou" é armazenado pelo chamador (Preferences no app, localStorage
// no painel).
//
// Garantias:
//   - 'iniciada' toca no MÁXIMO 1x por execução (mesmo com eventos duplicados).
//   - 'finalizada' toca no MÁXIMO 1x por execução.
//   - SUCESSO/FALHA de mensagem retornam null (nunca disparam voz de campanha).
// =====================================================================

export interface CampaignVoiceState {
  [campaignId: string]: { startKey?: string; endKey?: string }
}

export interface CampaignEvent {
  id: string | null
  status: string | null
  started_at?: string | null
  finished_at?: string | null
}

export type CampaignVoiceAction = 'iniciada' | 'finalizada' | 'cancelada' | null

export function decideCampaignVoice(
  current: CampaignVoiceState,
  event: CampaignEvent,
): { action: CampaignVoiceAction; next: CampaignVoiceState } {
  const id = String(event.id ?? '')
  if (!id) return { action: null, next: current }

  const prev = current[id] ?? {}
  const status = event.status ?? ''

  if (status === 'em_progresso') {
    const startKey = `${id}:${String(event.started_at ?? '')}`
    if (prev.startKey === startKey) return { action: null, next: current }
    return { action: 'iniciada', next: { ...current, [id]: { ...prev, startKey } } }
  }

  if (status === 'finalizada') {
    const endKey = `${id}:${String(event.finished_at ?? '')}`
    if (prev.endKey === endKey) return { action: null, next: current }
    return { action: 'finalizada', next: { ...current, [id]: { ...prev, endKey } } }
  }

  if (status === 'cancelada') {
    return { action: 'cancelada', next: current }
  }

  return { action: null, next: current }
}