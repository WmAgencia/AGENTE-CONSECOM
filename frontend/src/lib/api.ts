import { supabase } from './supabase'

/** URL pública do backend (Railway). Sobrescreva com VITE_BACKEND_URL no build. */
export const API_BASE = (import.meta.env.VITE_BACKEND_URL as string | undefined) ?? 'https://consecom-backend-production.up.railway.app'

/** Recupera o access token atual do Supabase (para Authorization Bearer). */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

export interface ApiError {
  error?: string
  message?: string
  statusCode?: number
}

export class ApiRequestError extends Error {
  statusCode: number
  detail?: ApiError
  constructor(statusCode: number, detail?: ApiError) {
    super(detail?.message ?? detail?.error ?? `Erro HTTP ${statusCode}`)
    this.statusCode = statusCode
    this.detail = detail
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers })
  const text = await res.text()
  const data = text ? (JSON.parse(text) as T & ApiError) : ({} as T)
  if (!res.ok) {
    throw new ApiRequestError(res.status, data as unknown as ApiError)
  }
  return data
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET', cache: 'no-store' }),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
}

// ===== Tipos da Central da IA =====

export interface AiStatus {
  configured: boolean
  provider: string
  model: string
  toolsEnabled: boolean
  evolutionConfigured: boolean
  lastActivityAt: string | null
  lastActivityLabel: string
  timestamp: string
}

export interface AiChatReply {
  conversationId: string
  response: string
  model: string
  provider: string
  latencyMs: number
}

export interface AiFlowTestResult {
  mode: 'simulation'
  simulationNotice: string
  lead: { name: string; company: string }
  etapa: string
  mensagem: string
  proximaEtapa: string
  status: 'ok'
  model: string
  provider: string
  latencyMs: number
  signed: string
}

// ===== Tipos de contatos importados =====

export interface ContactList {
  id: string
  name: string
  createdAt: string
  count: number
}

export interface ContactSummary {
  total: number
  valid: number
  created: number
  duplicates: number
  invalid: number
  errors: number
}

export interface ContactImportResponse {
  ok: boolean
  summary: ContactSummary
  listId: string | null
  listName: string
}