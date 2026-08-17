import { supabase, type FollowUp } from './supabase'
import { normalizeEvidence } from './evidence'

export { normalizeEvidence }

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
  code?: string
  details?: string
  hint?: string
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
  let data: T & ApiError
  try {
    data = text ? JSON.parse(text) as T & ApiError : {} as T & ApiError
  } catch {
    data = { message: text.slice(0, 500) } as T & ApiError
  }
  if (!res.ok) {
    console.error('[API] request failed', {
      endpoint: `${API_BASE}${path}`,
      method: init?.method ?? 'GET',
      status: res.status,
      error: data.error,
      message: data.message,
      code: data.code,
      details: data.details,
      hint: data.hint,
    })
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

// ===== Vyntra — Autenticação (login por usuário ou e-mail) =====

export interface AuthLoginResult {
  ok: boolean
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number | null
  user: Record<string, unknown> | null
}

/** Login direto no backend (aceita e-mail OU nome de usuário). */
export async function authLogin(identifier: string, password: string): Promise<AuthLoginResult> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  })
  const data = (await res.json()) as AuthLoginResult & ApiError
  if (!res.ok) throw new ApiRequestError(res.status, data as unknown as ApiError)
  return data
}

/** Atualiza o nome de usuário do usuário autenticado. */
export async function authUpdateUsername(username: string): Promise<string | null> {
  const data = await api.post<{ ok: boolean; username?: string | null }>('/api/auth/update-username', { username })
  return data.username ?? null
}

// ===== Vyntra SaaS (minha conta + catálogo de planos) =====

export interface SaasPlan {
  id: string
  name: string
  slug: string
  description: string | null
  price: number
  currency: string
  lead_limit: number
  duration_days: number | null
  billing_type: 'one_time' | 'recurring'
  active: boolean
  features: unknown[]
  featured: boolean
  display_order: number
  campaign_equivalence: number
  badge_label: string | null
}

export interface SaasSubscription {
  id: string
  plan_id: string
  status: 'active' | 'pending' | 'past_due' | 'cancelled' | 'expired'
  current_period_start: string | null
  current_period_end: string | null
  leads_used: number
  cancel_at_period_end: boolean
}

export interface SaasUsage {
  lead_limit: number
  leads_used: number
  leads_remaining: number
}

export interface SaasBalance {
  acquired: number
  used: number
  available: number
  limited: boolean
}

export interface CreditTransaction {
  id: string
  kind: 'purchase' | 'consumption' | 'trial' | 'refund' | 'adjustment'
  delta: number
  plan_id: string | null
  payment_id: string | null
  note: string | null
  detail: Record<string, unknown>
  created_at: string
}

export interface SaasMe {
  user: { id: string; email: string; username: string | null; role: 'USER' | 'MASTER'; status: string }
  tenantId: string
  subscription: SaasSubscription | null
  plan: SaasPlan | null
  usage: SaasUsage
  balance: SaasBalance
  trialUsed: boolean
  ledger: CreditTransaction[]
}

export interface CheckoutResult {
  ok: boolean
  paymentId: string
  checkoutUrl: string | null
  provider: string
}

export const saasApi = {
  async me(): Promise<SaasMe> {
    return api.get<SaasMe>('/api/saas/me')
  },
  async plans(): Promise<SaasPlan[]> {
    const r = await api.get<{ plans: SaasPlan[] }>('/api/saas/plans')
    return r.plans ?? []
  },
  async validateCoupon(code: string, planId: string): Promise<{
    ok: boolean
    code?: string
    discountType?: string
    discountValue?: number
    discountAmount?: number
    total?: number
  }> {
    return api.post<{
      ok: boolean
      code?: string
      discountType?: string
      discountValue?: number
      discountAmount?: number
      total?: number
    }>('/api/saas/coupons/validate', { code, planId })
  },
  async checkout(planId: string, couponCode?: string, backUrl?: string): Promise<CheckoutResult> {
    return api.post<CheckoutResult>('/api/saas/checkout', { planId, couponCode, backUrl })
  },
  async transparentPayment(input: {
    planId: string; couponCode?: string; method: 'pix' | 'card'; cpf: string; phone: string; email: string;
    paymentMethodId?: string; cardToken?: string; installments?: number; issuerId?: string
  }): Promise<{ ok: boolean; status?: string; paymentId: string; qrCode?: string | null; qrCodeBase64?: string | null; ticketUrl?: string | null }> {
    return api.post('/api/saas/transparent-payment', input)
  },
  async paymentPublicKey(): Promise<string> {
    const r = await api.get<{ publicKey?: string }>('/api/saas/payment/public-key')
    return r.publicKey ?? ''
  },
  async publicCheckout(input: {
    planId: string; name: string; email: string; password: string; cpf: string; phone: string; method: 'pix' | 'card';
    paymentMethodId?: string; cardToken?: string; installments?: number; issuerId?: string
  }): Promise<{ ok: boolean; status?: string; paymentId: string; qrCode?: string | null; qrCodeBase64?: string | null }> {
    return api.post('/api/public/checkout', input)
  },
  async changePassword(currentPassword: string, newPassword: string, confirmPassword: string): Promise<void> {
    await api.post<{ ok: boolean }>('/api/account/password', { currentPassword, newPassword, confirmPassword })
  },
  async transactions(): Promise<CreditTransaction[]> {
    const r = await api.get<{ transactions: CreditTransaction[] }>('/api/saas/transactions')
    return r.transactions ?? []
  },
  async redeemTrial(deviceId?: string, phone?: string): Promise<{ ok: boolean }> {
    return api.post<{ ok: boolean }>('/api/saas/trial/redeem', { deviceId, phone })
  },
}

// ===== Vyntra SaaS — Painel Master (apenas MASTER) =====

export interface MasterSeries {
  revenueByMonth: Array<{ mes: string; label: string; value: number }>
  leadsByMonth: Array<{ mes: string; label: string; value: number }>
  tenantsByMonth: Array<{ mes: string; label: string; value: number }>
  usersByRole: Array<{ label: string; value: number }>
  usersByStatus: Array<{ label: string; value: number }>
  subsByStatus: Array<{ label: string; value: number }>
  subsByPlan: Array<{ label: string; value: number }>
  paymentsByStatus: Array<{ label: string; value: number }>
  requestsByStatus: Array<{ label: string; value: number }>
}

export interface MasterDashboard {
  users: number
  masters: number
  actives: number
  tenants: number
  subscriptions: number
  activeSubscriptions: number
  approvedPayments: number
  revenue: number
  requests: number
  pendingRequests: number
  leads: number
  plans: number
  series: MasterSeries
}

export interface MasterPlan {
  id: string
  name: string
  slug: string
  description: string | null
  price: number
  lead_limit: number
  duration_days: number | null
  billing_type: string
  active: boolean
  featured: boolean
  display_order: number
  campaign_equivalence: number
  badge_label: string | null
  features: unknown[]
}

export interface MasterCoupon {
  id: string
  code: string
  discount_type: 'percentage' | 'fixed'
  discount_value: number
  valid_from: string | null
  valid_until: string | null
  usage_limit: number | null
  usage_count: number
  active: boolean
  applicable_plan_ids: string[]
}

export interface MasterGateway {
  id: string
  provider: string
  enabled: boolean
  sandbox: boolean
  active: boolean
  created_at: string
  updated_at: string
}

export const masterApi = {
  async dashboard(): Promise<MasterDashboard> {
    return api.get<MasterDashboard>('/api/master/dashboard')
  },
  async users(): Promise<Array<Record<string, unknown>>> {
    const r = await api.get<{ users: Array<Record<string, unknown>> }>('/api/master/users')
    return r.users ?? []
  },
  async updateUser(id: string, patch: { role?: string; status?: string }): Promise<void> {
    await api.patch(`/api/master/users/${encodeURIComponent(id)}`, patch)
  },
  async createUser(input: { email: string; password: string; full_name?: string }): Promise<void> {
    await api.post('/api/master/users', input)
  },
  async deleteUser(id: string): Promise<void> {
    await api.del(`/api/master/users/${encodeURIComponent(id)}`)
  },
  async assignUserPlan(id: string, planId: string): Promise<void> {
    await api.post(`/api/master/users/${encodeURIComponent(id)}/plan`, { plan_id: planId })
  },
  async plans(): Promise<MasterPlan[]> {
    const r = await api.get<{ plans: MasterPlan[] }>('/api/master/plans')
    return r.plans ?? []
  },
  async createPlan(input: Record<string, unknown>): Promise<void> {
    await api.post('/api/master/plans', input)
  },
  async updatePlan(id: string, patch: Record<string, unknown>): Promise<void> {
    await api.patch(`/api/master/plans/${encodeURIComponent(id)}`, patch)
  },
  async deletePlan(id: string, hard = false): Promise<void> {
    await api.del(`/api/master/plans/${encodeURIComponent(id)}${hard ? '?hard=true' : ''}`)
  },
  async subscriptions(): Promise<Array<Record<string, unknown>>> {
    const r = await api.get<{ subscriptions: Array<Record<string, unknown>> }>('/api/master/subscriptions')
    return r.subscriptions ?? []
  },
  async payments(): Promise<Array<Record<string, unknown>>> {
    const r = await api.get<{ payments: Array<Record<string, unknown>> }>('/api/master/payments')
    return r.payments ?? []
  },
  async gateways(): Promise<MasterGateway[]> {
    const r = await api.get<{ gateways: MasterGateway[] }>('/api/master/gateways')
    return r.gateways ?? []
  },
  async saveGateway(input: { provider: string; accessToken: string; publicKey?: string; webhookSecret?: string; sandbox: boolean; active: boolean }): Promise<void> {
    await api.post('/api/master/gateways', input)
  },
  async testGateway(id: string): Promise<{ ok: boolean; error: string | null }> {
    return api.post(`/api/master/gateways/${encodeURIComponent(id)}/test`, {})
  },
  async coupons(): Promise<MasterCoupon[]> {
    const r = await api.get<{ coupons: MasterCoupon[] }>('/api/master/coupons')
    return r.coupons ?? []
  },
  async createCoupon(input: Record<string, unknown>): Promise<void> {
    await api.post('/api/master/coupons', input)
  },
  async updateCoupon(id: string, patch: Record<string, unknown>): Promise<void> {
    await api.patch(`/api/master/coupons/${encodeURIComponent(id)}`, patch)
  },
  async deleteCoupon(id: string): Promise<void> {
    await api.del(`/api/master/coupons/${encodeURIComponent(id)}`)
  },
  async pixels(): Promise<Record<string, unknown> | null> {
    const r = await api.get<{ settings: Record<string, unknown> | null }>('/api/master/pixels')
    return r.settings
  },
  async updatePixels(patch: Record<string, unknown>): Promise<void> {
    await api.patch('/api/master/pixels', patch)
  },
  async extensionSites(): Promise<{ maps: boolean; webmotors: boolean; wepsy: boolean }> {
    return api.get<{ maps: boolean; webmotors: boolean; wepsy: boolean }>('/api/master/extension-sites')
  },
  async updateExtensionSites(patch: { maps?: boolean; webmotors?: boolean; wepsy?: boolean }): Promise<void> {
    await api.patch('/api/master/extension-sites', patch)
  },
  async sourceRequests(): Promise<Array<Record<string, unknown>>> {
    const r = await api.get<{ requests: Array<Record<string, unknown>> }>('/api/master/source-requests')
    return r.requests ?? []
  },
  async updateSourceRequest(id: string, status: string): Promise<void> {
    await api.patch(`/api/master/source-requests/${encodeURIComponent(id)}`, { status })
  },
  async auditLogs(limit = 100): Promise<Array<Record<string, unknown>>> {
    const r = await api.get<{ logs: Array<Record<string, unknown>> }>(`/api/master/audit-logs?limit=${limit}`)
    return r.logs ?? []
  },
  async visualReferences(): Promise<{ landing_reference_url: string | null; dashboard_reference_url: string | null }> {
    return api.get('/api/master/visual-references')
  },
  async saveVisualReferences(patch: { landing_reference_url?: string | null; dashboard_reference_url?: string | null }): Promise<{ ok: boolean; landing_reference_url: string | null; dashboard_reference_url: string | null }> {
    return api.patch('/api/master/visual-references', patch)
  },
  async antifraud(): Promise<{ redemptions: Array<Record<string, unknown>>; events: Array<Record<string, unknown>>; stats: { total: number; highRisk: number; blockedEvents: number; uniqueIps: number; uniqueDevices: number } }> {
    return api.get('/api/master/antifraud')
  },
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
  operacao: {
    mensagensEnviadas: number
    respostasRecebidas: number
    followUpsPendentes: number
    campanhasAtivas: number
    campanhasTotal: number
    conexoesConectadas: number
    conexoesTotal: number
  }
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
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
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
  firstError?: { status?: number; body?: string } | null
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

export const followUpsApi = {
  async list(opts?: { leadId?: string; start?: string; end?: string }): Promise<FollowUp[]> {
    const params = new URLSearchParams()
    if (opts?.leadId) params.set('leadId', opts.leadId)
    if (opts?.start) params.set('start', opts.start)
    if (opts?.end) params.set('end', opts.end)
    const r = await request<{ followUps: FollowUp[] }>(`/api/follow-ups${params.toString() ? `?${params}` : ''}`, {
      method: 'GET', cache: 'no-store', headers: await userIdHeader(),
    })
    return r.followUps ?? []
  },
  async create(input: { leadId: string; scheduledDate: string; scheduledTime?: string | null; message: string; connectionId?: string | null; conversationId?: string | null; originContext?: string | null }): Promise<FollowUp> {
    const r = await request<{ followUp: FollowUp }>('/api/follow-ups', {
      method: 'POST', body: JSON.stringify(input), headers: await userIdHeader(),
    })
    return r.followUp
  },
  async update(id: string, input: { scheduledDate?: string; scheduledTime?: string | null; message?: string; status?: 'cancelado' }): Promise<void> {
    await request(`/api/follow-ups/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify(input), headers: await userIdHeader(),
    })
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
export type LearningOrigin = 'ai' | 'manual'

export interface MemoryLearning {
  id: string
  category: LearningCategory
  content: string
  /** Sempre normalizado para string[] (ver normalizeEvidence). */
  evidence: string[]
  /** 'ai' = extraído da conversa · 'manual' = criado pelo usuário. */
  origin: LearningOrigin
  confidence: 'alta' | 'media' | 'baixa'
  occurrences: number
  performance: 'positivo' | 'negativo' | 'neutro'
  status: LearningStatus
  important: boolean
  discovered_at: string
  created_at: string
}

export interface MemoryLearningInput {
  category: LearningCategory
  content: string
  confidence: 'alta' | 'media' | 'baixa'
  performance?: 'positivo' | 'negativo' | 'neutro'
  status?: LearningStatus
  important?: boolean
  evidence?: string[]
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
    // Contrato defensivo: garante array + evidence normalizada (evita crash).
    return (r.learnings ?? []).map((l) => ({
      ...l,
      evidence: normalizeEvidence(l.evidence),
      origin: l.origin === 'manual' ? 'manual' : 'ai',
    }))
  },
  async createLearning(input: MemoryLearningInput): Promise<{ ok: boolean; id: string }> {
    return api.post<{ ok: boolean; id: string }>('/api/ai/memory/learnings', input)
  },
  async updateLearning(
    id: string,
    patch: Partial<
      Pick<MemoryLearning, 'status' | 'important' | 'content' | 'category' | 'confidence' | 'performance' | 'evidence'>
    >,
  ): Promise<void> {
    await api.patch(`/api/ai/memory/learnings/${encodeURIComponent(id)}`, patch)
  },
  async deleteLearning(id: string): Promise<void> {
    await api.del(`/api/ai/memory/learnings/${encodeURIComponent(id)}`)
  },
}

// ===== Leads: Limpar lista ativa vs. Exclusão definitiva (histórico) =====

export interface LeadsClearResult {
  ok: boolean
  cleared: number
}

export interface LeadsDeleteResult {
  ok: boolean
  deleted: number
}

async function leadsHeaders(): Promise<Record<string, string>> {
  return userIdHeader()
}

/**
 * "Limpar lista ativa" — marca is_active_in_prospecting = false (soft clear).
 * NÃO apaga o lead nem o histórico/campanhas/Kanban. Sem senha.
 */
export const leadsApi = {
  async clearList(leadIds: string[]): Promise<LeadsClearResult> {
    return request<LeadsClearResult>('/api/leads/clear-list', {
      method: 'POST',
      body: JSON.stringify({ lead_ids: leadIds }),
      headers: await leadsHeaders(),
    })
  },
  /**
   * "Excluir histórico" — exclusão DEFINITIVA do lead + conversas, reuniões,
   * histórico e participações em todas as campanhas. A senha é a do login da
   * plataforma (validada no backend via Supabase Auth). Nunca fica no frontend.
   */
  async permanentDelete(leadIds: string[], password: string): Promise<LeadsDeleteResult> {
    const { data } = await supabase.auth.getSession()
    const email = data.session?.user.email ?? null
    return request<LeadsDeleteResult>('/api/leads/permanent-delete', {
      method: 'POST',
      body: JSON.stringify({ lead_ids: leadIds, password, email }),
      headers: await leadsHeaders(),
    })
  },
}
