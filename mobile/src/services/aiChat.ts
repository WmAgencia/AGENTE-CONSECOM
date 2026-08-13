import { CapacitorHttp } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { supabase } from '../lib/supabase'

// =====================================================================
// Chat com o ASSISTENTE PESSOAL da VYNTRA.
//   - Backend dedicado: POST /api/personal/chat (auth = token Supabase).
//   - Endpoint SEPARADO do agente comercial (/api/ai/chat) — o chat do app
//     NUNCA aciona o agente de atendimento dos clientes.
//   - HTTP nativo via CapacitorHttp (sem CORS no Android).
//   - Histórico da conversa persistido localmente (Capacitor Preferences)
//     para sobreviver a fechar/abrir o app.
// =====================================================================

const BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ??
  'https://consecom-backend-production.up.railway.app'

const HISTORY_KEY = 'vyntra.personal.chat.v1'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  audioUri?: string
  audioDurationMs?: number
  createdAt: number
}

export interface AiChatResponse {
  conversationId: string
  response: string
  model: string | null
  provider: string
  latencyMs: number | null
}

export async function getConversationId(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const userId = data.session?.user?.id
  if (!userId) throw new Error('Sessão expirada. Conecte o app pelo painel.')
  return `personal:${userId}`
}

async function sessionToken(): Promise<string> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new Error('Sessão expirada. Conecte o app pelo painel.')
  return token
}

export async function sendMessage(
  text: string,
  conversationId: string,
): Promise<AiChatResponse> {
  const token = await sessionToken()
  const res = await CapacitorHttp.post({
    url: `${BACKEND_URL}/api/personal/chat`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: { message: text, conversationId },
    connectTimeout: 60000,
    readTimeout: 120000,
  })

  const body = res.data as {
    conversationId?: string
    response?: string
    model?: string | null
    provider?: string
    latencyMs?: number | null
    message?: string
    statusCode?: number
  }

  if (res.status !== 200 || !body.response) {
    throw new Error(
      body?.message ?? `Erro ao falar com o assistente (HTTP ${res.status})`,
    )
  }

  return {
    conversationId: body.conversationId ?? conversationId,
    response: body.response,
    model: body.model ?? null,
    provider: body.provider ?? '',
    latencyMs: body.latencyMs ?? null,
  }
}

/** Apaga a memória da conversa pessoal no backend (POST /api/personal/reset). */
export async function resetConversation(): Promise<void> {
  const token = await sessionToken()
  const res = await CapacitorHttp.post({
    url: `${BACKEND_URL}/api/personal/reset`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: {},
    connectTimeout: 30000,
    readTimeout: 30000,
  })
  if (res.status !== 200) {
    throw new Error(`Falha ao limpar a conversa (HTTP ${res.status})`)
  }
}

// ---------------------------------------------------------------------
// Histórico local
// ---------------------------------------------------------------------
export async function loadHistory(): Promise<ChatMessage[]> {
  const { value } = await Preferences.get({ key: HISTORY_KEY })
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as ChatMessage[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function saveHistory(messages: ChatMessage[]): Promise<void> {
  // Mantém só o suficiente para um chat leve (últimas ~120 mensagens).
  const trimmed = messages.slice(-120)
  await Preferences.set({ key: HISTORY_KEY, value: JSON.stringify(trimmed) })
}

export async function clearHistory(): Promise<void> {
  await Preferences.remove({ key: HISTORY_KEY })
}
