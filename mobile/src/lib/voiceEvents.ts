// =====================================================================
// Narrações de voz (ElevenLabs) por tipo de evento.
// O nome do arquivo bate com o arquivo em:
//   - mobile/android/app/src/main/res/raw/<file>  (Android nativo)
//   - frontend/public/audio/<file>                 (navegador/desktop)
//
// Cada entrada tem:
//   key  -> chave usada no NotifPrefs (toggle ativado/desativado)
//   label-> texto amigável mostrado na configuração
//   file -> arquivo de áudio
//   kind -> 'alarme' (agendado, toca com app fechado) | 'evento' (realtime)
// =====================================================================

export interface VoiceEvent {
  key: string
  label: string
  file: string
  kind: 'alarme' | 'evento'
}

export const VOICE_EVENTS: VoiceEvent[] = [
  // ---- Alarme de reunião: agenda no AlarmManager (toca com app fechado) ----
  { key: 'reuniao_30min', label: 'Reunião em 30 min', file: 'reuniao_30min.mp3', kind: 'alarme' },
  { key: 'reuniao_15min', label: 'Reunião em 15 min', file: 'reuniao_15min.mp3', kind: 'alarme' },
  { key: 'reuniao_10min', label: 'Reunião em 10 min', file: 'reuniao_10min.mp3', kind: 'alarme' },
  { key: 'reuniao_5min', label: 'Reunião em 5 min', file: 'reuniao_5min.mp3', kind: 'alarme' },
  { key: 'reuniao_1min', label: 'Reunião em 1 min', file: 'reuniao_1min.mp3', kind: 'alarme' },

  // ---- Eventos realtime (exigem app/aba aberta) ----
  { key: 'reuniao_marcada', label: 'Nova reunião agendada', file: 'reuniao_marcada.mp3', kind: 'evento' },
  { key: 'reuniao_cancelada', label: 'Reunião cancelada', file: 'reuniao_cancelada.mp3', kind: 'evento' },
  { key: 'reuniao_reagendada', label: 'Reunião reagendada', file: 'reuniao_reagendada.mp3', kind: 'evento' },
  { key: 'campanha_iniciada', label: 'Campanha iniciada', file: 'campanha_iniciada.mp3', kind: 'evento' },
  { key: 'campanha_concluida', label: 'Campanha concluída', file: 'campanha_concluida.mp3', kind: 'evento' },
  { key: 'campanha_atencao', label: 'Campanha precisa de atenção', file: 'campanha_atencao.mp3', kind: 'evento' },
  { key: 'lead_atencao', label: 'Lead precisa de atenção', file: 'lead_atencao.mp3', kind: 'evento' },
  { key: 'whatsapp_desconectado', label: 'WhatsApp desconectado', file: 'whatsapp_desconectado.mp3', kind: 'evento' },
  { key: 'resumo_diario', label: 'Resumo diário', file: 'resumo_diario.mp3', kind: 'evento' },
]

export const VOICE_MAP: Record<string, VoiceEvent> = Object.fromEntries(
  VOICE_EVENTS.map((v) => [v.key, v]),
)

export function voiceFileFor(key: string): string | null {
  return VOICE_MAP[key]?.file ?? null
}
