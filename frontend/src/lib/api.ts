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

export interface AiTrainingPersona {
  name: string
  company: string
  niche: string
  profile: string
}

export interface AiTrainingReply {
  conversationId: string
  response: string
  model: string
  provider: string
  latencyMs: number
  sandbox: boolean
}

// ===== Tipos de contatos importados =====

export interface Contact {
  id: string
  name: string
  phone: string
  category?: string | null
  status?: string | null
  createdAt?: string | null
}

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

/** Contrato real do backend para GET /api/contacts/lists (payload bruto). */
interface ContactListsResponse {
  lists?: unknown
}

/** Contrato real do backend para GET /api/contacts/:listId/leads (payload bruto). */
interface ContactLeadsResponse {
  leads?: unknown
}

function asContactRow(raw: unknown): Contact | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id : ''
  const phone = typeof r.phone === 'string' ? r.phone : ''
  if (!id || !phone) return null
  return {
    id,
    name: typeof r.name === 'string' ? r.name : 'Sem nome',
    phone,
    category: typeof r.category === 'string' ? r.category : null,
    status: typeof r.status === 'string' ? r.status : null,
    createdAt: typeof r.created_at === 'string' ? r.created_at : null,
  }
}

/** Normalização segura: extrai SEMPRE um array do payload de listas. */
export function normalizeContactLists(data: unknown): ContactList[] {
  const raw = (data as ContactListsResponse | null)?.lists
  if (!Array.isArray(raw)) return []
  return raw
    .map((l) => {
      if (!l || typeof l !== 'object') return null
      const r = l as Record<string, unknown>
      const id = typeof r.id === 'string' ? r.id : ''
      if (!id) return null
      return {
        id,
        name: typeof r.name === 'string' ? r.name : 'Contatos importados',
        createdAt: typeof r.created_at === 'string' ? r.created_at : new Date().toISOString(),
        count: typeof r.count === 'number' ? r.count : 0,
      }
    })
    .filter((l): l is ContactList => l !== null)
}

/** Normalização segura: extrai SEMPRE um array do payload de leads de lista. */
export function normalizeContactLeads(data: unknown): Contact[] {
  const raw = (data as ContactLeadsResponse | null)?.leads
  if (!Array.isArray(raw)) return []
  return raw.map(asContactRow).filter((c): c is Contact => c !== null)
}

/** API de contatos respeitando o contrato real + camada de normalização. */
export const contactsApi = {
  async lists(): Promise<ContactList[]> {
    const data = await api.get<unknown>('/api/contacts/lists')
    return normalizeContactLists(data)
  },
  async listLeads(listId: string): Promise<Contact[]> {
    const data = await api.get<unknown>(`/api/contacts/${encodeURIComponent(listId)}/leads`)
    return normalizeContactLeads(data)
  },
  async import(listName: string, contacts: { name: string; phone: string }[]): Promise<ContactImportResponse> {
    const res = await api.post<ContactImportResponse>('/api/contacts/import', {
      listName,
      contacts,
    })
    return res
  },
}