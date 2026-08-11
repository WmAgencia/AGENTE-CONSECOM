// =====================================================================
// Helpers puros do chat da IA (formatação, ids, limite de histórico).
// =====================================================================

export function newChatId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Formata milissegundos de áudio como m:ss (ex.: 1:23). */
export function formatAudioDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Mantém apenas as últimas `max` mensagens do histórico. */
export function trimHistory<T>(messages: T[], max = 120): T[] {
  return messages.slice(-max)
}

/** Hora local curta (ex.: 14:05) para timestamps das mensagens. */
export function formatChatTimestamp(iso: number): string {
  return new Date(iso).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  })
}
