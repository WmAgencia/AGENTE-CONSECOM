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
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

// ===== Inteligência Comercial (Metas + Faturamento) =====

export interface CommercialGoal {
  id: string
  user_id: string
  workspace_id: string | null
  goal_amount: number
  period_days: 30 | 60 | 90
  avg_ticket: number
  meeting_close_rate: number
  leads_per_day: number | null
  created_at: string
  updated_at: string
}

export interface GoalInput {
  goal_amount: number
  period_days: 30 | 60 | 90
  avg_ticket: number
  meeting_close_rate: number
  leads_per_day: number | null
}

export interface ProjectionResult {
  vendasNecessarias: number
  reunioesNecessarias: number
  reunioesPorDia: number
  leadsNecessarios: number | null
  leadsPorDia: number | null
  conversaoLeadReuniaoNecessaria: number | null
  conversaoLeadVendaNecessaria: number | null
}

export interface FunnelStage {
  label: string
  value: number
}

export interface RealResults {
  faturamento: number
  vendas: number
  vendasComValor: number
  leadsTrabalhados: number
  conversando: number
  reunioesMarcadas: number
  reunioesRealizadas: number
  conversaoLeadReuniao: number | null
  conversaoReuniaoVenda: number | null
  conversaoLeadVenda: number | null
  funnel: FunnelStage[]
  hoje: { faturamento: number; vendas: number; reunioes: number }
  historico: Array<{ mes: string; faturamento: number }>
  diasRestantes: number
  rPorDiaNecessario: number | null
  metaAtingida: number | null
}

export interface CommercialDashboard {
  goal: CommercialGoal | null
  projection: ProjectionResult | null
  real: RealResults
  generatedAt: string
}

async function userIdHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getUser()
  const uid = data?.user?.id
  return uid ? { 'x-user-id': uid } : {}
}

export const commercialApi = {
  async dashboard(): Promise<CommercialDashboard> {
    return request<CommercialDashboard>('/api/commercial/dashboard', {
      method: 'GET',
      cache: 'no-store',
      headers: await userIdHeader(),
    })
  },
  async goal(): Promise<CommercialGoal | null> {
    try {
      const r = await request<{ goal: CommercialGoal }>('/api/commercial/goal', {
        method: 'GET',
        cache: 'no-store',
        headers: await userIdHeader(),
      })
      return r.goal ?? null
    } catch {
      return null
    }
  },
  async saveGoal(input: GoalInput): Promise<CommercialGoal | null> {
    const r = await request<{ ok: boolean; goal: CommercialGoal }>('/api/commercial/goal', {
      method: 'PUT',
      body: JSON.stringify(input),
      headers: await userIdHeader(),
    })
    return r.goal ?? null
  },
  async simulate(input: GoalInput): Promise<ProjectionResult> {
    const r = await request<{ projection: ProjectionResult }>('/api/commercial/simulate', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: await userIdHeader(),
    })
    return r.projection
  },
}

// Formatação BR para valores monetários.
export function formatBRL(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  }).format(value)
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value)
}

export function formatMonth(mes: string): string {
  const [y, m] = mes.split('-')
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('pt-BR', { month: 'short' })
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

// ===== Tipos da Memória Comercial da IA =====

export type MemoryImportOrigin = 'zip' | 'txt' | 'csv' | 'arquivo'
export type MemoryImportStatus = 'processing' | 'done' | 'failed'

export interface MemoryImport {
  id: string
  user_id: string
  origin: MemoryImportOrigin
  file_name: string
  source_files: number
  conversations_found: number
  conversations_processed: number
  learnings_generated: number
  failures: number
  status: MemoryImportStatus
  error_message: string | null
  created_at: string
  finished_at: string | null
  pending?: boolean
  conversations?: MemoryConversation[]
}

export type MemoryConversationStatus = 'imported' | 'processing' | 'processed' | 'failed'

export interface MemoryConversation {
  id: string
  source_file: string | null
  contact_name: string | null
  contact_identifier: string | null
  messages_count: number
  direction: string | null
  outcome: string | null
  status: MemoryConversationStatus
  error_message?: string | null
  created_at: string
  processed_at: string | null
}

export type LearningCategory =
  | 'communication_style'
  | 'opening_patterns'
  | 'discovery_questions'
  | 'value_proposition'
  | 'objection_handling'
  | 'meeting_transition'
  | 'follow_up_patterns'
  | 'successful_patterns'
  | 'unsuccessful_patterns'
  | 'common_objections'
  | 'conversation_patterns'

export type LearningStatus = 'identificado' | 'validado' | 'ativo' | 'inativo'

export interface MemoryLearning {
  id: string
  category: LearningCategory
  content: string
  evidence: string[]
  confidence: 'alta' | 'media' | 'baixa'
  occurrences: number
  performance: 'positivo' | 'negativo' | 'neutro'
  status: LearningStatus
  important: boolean
  discovered_at: string
  created_at: string
}

export interface MemoryDashboard {
  conversationsImported: number
  conversationsProcessed: number
  learnings: number
  patterns: number
  objections: number
  meetingStrategies: number
  statusCounts: Record<string, number>
  recentLearnings: MemoryLearning[]
  totalImports: number
}

export interface MemoryImportResponse {
  ok: boolean
  importId: string
  origin: string
  fileName: string
  sourceFiles: number
  conversationsFound: number
  inserted: number
  processing: boolean
}

const CATEGORY_LABELS: Record<LearningCategory, string> = {
  communication_style: 'Estilo de comunicação',
  opening_patterns: 'Padrões de abertura',
  discovery_questions: 'Perguntas de descoberta',
  value_proposition: 'Proposta de valor',
  objection_handling: 'Tratamento de objeções',
  meeting_transition: 'Condução à reunião',
  follow_up_patterns: 'Padrões de follow-up',
  successful_patterns: 'Padrões de sucesso',
  unsuccessful_patterns: 'Padrões de recusa',
  common_objections: 'Objeções comuns',
  conversation_patterns: 'Padrões de conversa',
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category as LearningCategory] ?? category
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

/** API da Memória Comercial da IA. */
export const memoryApi = {
  async dashboard(): Promise<MemoryDashboard> {
    return api.get<MemoryDashboard>('/api/ai/memory/dashboard')
  },
  async imports(): Promise<MemoryImport[]> {
    const r = await api.get<{ imports: MemoryImport[] }>('/api/ai/memory/imports')
    return r.imports
  },
  async import(fileName: string, content: string, kind: 'auto' | 'txt' | 'csv' | 'zip' = 'auto'): Promise<MemoryImportResponse> {
    return api.post<MemoryImportResponse>('/api/ai/memory/import', { fileName, content, kind })
  },
  async importStatus(id: string): Promise<MemoryImport & { conversations: MemoryConversation[] }> {
    return api.get<MemoryImport & { conversations: MemoryConversation[] }>(`/api/ai/memory/imports/${encodeURIComponent(id)}`)
  },
  async deleteImport(id: string): Promise<void> {
    await api.del(`/api/ai/memory/imports/${encodeURIComponent(id)}`)
  },
  async conversations(opts?: { importId?: string; status?: string; limit?: number }): Promise<MemoryConversation[]> {
    const r = await api.get<{ conversations: MemoryConversation[] }>(
      `/api/ai/memory/conversations${qs({ importId: opts?.importId, status: opts?.status, limit: opts?.limit })}`,
    )
    return r.conversations
  },
  async deleteConversation(id: string): Promise<void> {
    await api.del(`/api/ai/memory/conversations/${encodeURIComponent(id)}`)
  },
  async reprocessConversation(id: string): Promise<void> {
    await api.post(`/api/ai/memory/conversations/${encodeURIComponent(id)}/reprocess`, {})
  },
  async learnings(opts?: { category?: string; status?: string; limit?: number }): Promise<MemoryLearning[]> {
    const r = await api.get<{ learnings: MemoryLearning[] }>(
      `/api/ai/memory/learnings${qs({ category: opts?.category, status: opts?.status, limit: opts?.limit })}`,
    )
    return r.learnings
  },
  async updateLearning(id: string, patch: Partial<Pick<MemoryLearning, 'status' | 'important' | 'content' | 'category' | 'confidence'>>): Promise<void> {
    await api.patch(`/api/ai/memory/learnings/${encodeURIComponent(id)}`, patch)
  },
  async deleteLearning(id: string): Promise<void> {
    await api.del(`/api/ai/memory/learnings/${encodeURIComponent(id)}`)
  },
}