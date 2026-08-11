import { CapacitorHttp } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { supabase } from '../lib/supabase'

// =====================================================================
// Chat com a IA do painel VYNTRA.
//   - Mesmo backend do painel: POST /api/ai/chat (auth = token Supabase).
//   - HTTP nativo via CapacitorHttp (sem CORS no Android).
//   - Histórico da conversa persistido localmente (Capacitor Preferences)
//     para sobreviver a fechar/abrir o app.
// =====================================================================

const BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ??
  'https://consecom-backend-production.up.railway.app'

const HISTORY_KEY = 'vyntra.chat.history.v1'

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
  return `mobile:${userId}`
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
    url: `${BACKEND_URL}/api/ai/chat`,
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
      body?.message ?? `Erro ao falar com a IA (HTTP ${res.status})`,
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
