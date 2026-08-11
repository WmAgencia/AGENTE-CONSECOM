/**
 * Testes da separação "Leads ativos vs. histórico por campanha".
 *
 * 1) clear-list sem autenticação => 401
 * 2) clear-list: marca is_active_in_prospecting=false (PATCH), NÃO deleta, e
 *    grava auditoria (histórico preservado)
 * 3) permanent-delete sem senha => 400
 * 4) permanent-delete com senha de login errada => 403 (+ auditoria de negação)
 * 5) permanent-delete com senha de login correta => DELETE SOMENTE dos ids
 *    selecionados (+ auditoria) — nenhum outro lead é afetado
 * 6) permanent-delete sem autenticação => 401
 * 7) permanent-delete sem email => 400
 * 8) clear-list sem lead_ids => 400
 *
 * A senha é a do login da plataforma: o backend valida via Supabase Auth
 * (POST /auth/v1/token?grant_type=password) com email + senha do usuário.
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'

process.env.NVIDIA_API_KEY = 'test-key'
process.env.LOG_LEVEL = 'error'
process.env.SUPABASE_URL = 'https://vyntra-mock.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role'
process.env.SUPABASE_MARCAR_REUNIAO_RPC = 'consecom_marcar_reuniao'
process.env.WEBHOOK_SECRET = 'test-secret'
process.env.EVOLUTION_API_URL = 'http://evolution.mock'
process.env.EVOLUTION_API_KEY = 'mock'
process.env.EVOLUTION_INSTANCE_NAME = 'inst'
process.env.EVOLUTION_AGENT_CONCURRENCY = '1'
process.env.AGENT_API_KEY = 'test-key'
process.env.AGENT_ALLOWED_TOOLS = ''

/** Senha de login "correta" usada no mock do Supabase Auth. */
const LOGIN_PASSWORD = 'senha-do-login'
const LOGIN_EMAIL = 'admin@consecom.com'

interface LeadRow {
  id: string
  name: string | null
  is_active_in_prospecting?: boolean
}

const store = {
  leads: [] as LeadRow[],
  patchCalls: [] as Array<{ url: string; body: Record<string, unknown> }>,
  deleteCalls: [] as string[],
  auditLogs: [] as Array<Record<string, unknown>>,
}

function jsonRes(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: { get: () => 'application/json' },
  } as unknown as Response
}

function inParam(url: string): string[] | null {
  const m = url.match(/id=in\.\(([^)]+)\)/)
  if (!m) return null
  return m[1].split(',').map((x) => x.trim())
}

async function mockFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = decodeURIComponent(typeof input === 'string' ? input : String(input))
  const method = (init?.method ?? 'GET').toUpperCase()
  const body = init?.body && method !== 'GET' ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null

  if (url.includes('/rest/v1/leads')) {
    const ids = inParam(url)
    if (method === 'GET') {
      const out = ids ? store.leads.filter((l) => ids.includes(l.id)) : store.leads
      return jsonRes(out.map((l) => ({ id: l.id, name: l.name })))
    }
    if (method === 'PATCH') {
      store.patchCalls.push({ url, body: body ?? {} })
      if (ids) {
        for (const l of store.leads) {
          if (ids.includes(l.id)) Object.assign(l, body)
        }
      }
      return jsonRes([])
    }
    if (method === 'DELETE') {
      store.deleteCalls.push(url)
      if (ids) {
        store.leads = store.leads.filter((l) => !ids.includes(l.id))
      }
      return jsonRes([])
    }
  }

  if (url.includes('/rest/v1/consecom_audit_log') && method === 'POST') {
    store.auditLogs.push((body ?? {}) as Record<string, unknown>)
    return jsonRes([])
  }

  if (url.includes('/rest/v1/send_runs')) return jsonRes([])
  if (url.includes('/rest/v1/capture_sessions')) return jsonRes([])
  if (url.includes('/rest/v1/campaigns')) return jsonRes([])
  if (url.includes('/rest/v1/queue_messages')) return jsonRes([])
  if (url.includes('/rest/v1/consecom_conversations')) return jsonRes([])
  if (url.includes('/rest/v1/lead_contacts')) return jsonRes([])
  if (url.includes('/rest/v1/agent_settings')) return jsonRes([])
  if (url.includes('/rest/v1/strategies')) return jsonRes([])
  if (url.includes('/rest/v1/campaign_strategies')) return jsonRes([])
  if (url.includes('/rest/v1/agent_learning')) return jsonRes([])
  if (url.includes('/rest/v1/ai_memory')) return jsonRes([])
  if (url.includes('/rest/v1/whatsapp_connections')) return jsonRes([])

  // Supabase Auth — validação da senha de login ("Excluir histórico")
  if (url.includes('/auth/v1/token')) {
    const creds = (body ?? {}) as { email?: string; password?: string }
    if (creds.password === LOGIN_PASSWORD) {
      return jsonRes({ access_token: 'mock-token', user: { email: creds.email } })
    }
    return jsonRes({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400)
  }

  return jsonRes([])
}

before(async () => {
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

function clearStore(): void {
  store.leads.length = 0
  store.patchCalls.length = 0
  store.deleteCalls.length = 0
  store.auditLogs.length = 0
}

async function inject(
  method: 'POST',
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { app } = (await import('../app.js')).buildApp()
  await app.ready()
  try {
    const res = await app.inject({
      method,
      url,
      headers: { 'content-type': 'application/json', ...headers },
      payload,
    })
    return { status: res.statusCode, body: res.json() as Record<string, unknown> }
  } finally {
    await app.close()
  }
}

function auth(): Record<string, string> {
  return { 'x-user-id': 'user-1' }
}

test('1) clear-list sem autenticação => 401', async () => {
  clearStore()
  const r = await inject('POST', '/api/leads/clear-list', { lead_ids: ['id-1'] })
  assert.equal(r.status, 401)
  assert.equal(r.body.error, 'unauthorized')
})

test('2) clear-list marca is_active_in_prospecting=false, não deleta e audita', async () => {
  clearStore()
  store.leads.push(
    { id: 'id-1', name: 'Empresa A', is_active_in_prospecting: true },
    { id: 'id-2', name: 'Empresa B', is_active_in_prospecting: true },
    { id: 'id-3', name: 'Empresa C', is_active_in_prospecting: true },
  )

  const r = await inject('POST', '/api/leads/clear-list', { lead_ids: ['id-1', 'id-3'] }, auth())
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.cleared, 2)

  // PATCH apenas os selecionados, marcando is_active_in_prospecting=false
  assert.equal(store.patchCalls.length, 1)
  assert.equal(store.patchCalls[0].body.is_active_in_prospecting, false)
  const patchedIds = inParam(store.patchCalls[0].url)
  assert.deepEqual(patchedIds?.sort(), ['id-1', 'id-3'])

  // NENHUM DELETE ocorreu (histórico preservado)
  assert.equal(store.deleteCalls.length, 0)

  // auditoria registrada
  assert.equal(store.auditLogs.length, 1)
  assert.equal(store.auditLogs[0].action, 'leads.clear_list')
  assert.equal(store.auditLogs[0].user_id, 'user-1')

  // o lead não selecionado NÃO foi alterado
  const b = store.leads.find((l) => l.id === 'id-2')
  assert.equal(b?.is_active_in_prospecting, true)
})

test('3) permanent-delete sem senha => 400', async () => {
  clearStore()
  const r = await inject('POST', '/api/leads/permanent-delete', { lead_ids: ['id-1'], email: LOGIN_EMAIL }, auth())
  assert.equal(r.status, 400)
  assert.equal(r.body.error, 'password_required')
})

test('4) permanent-delete com senha de login errada => 403 e audita negação', async () => {
  clearStore()
  const r = await inject(
    'POST',
    '/api/leads/permanent-delete',
    { lead_ids: ['id-1'], password: 'senha-errada', email: LOGIN_EMAIL },
    auth(),
  )
  assert.equal(r.status, 403)
  assert.equal(r.body.error, 'invalid_password')
  assert.equal(store.deleteCalls.length, 0, 'nada é deletado com senha inválida')
  assert.equal(store.auditLogs.length, 1)
  assert.equal(store.auditLogs[0].action, 'leads.permanent_delete_denied')
})

test('5) permanent-delete com senha de login correta deleta SOMENTE os selecionados e audita', async () => {
  clearStore()
  store.leads.push(
    { id: 'id-1', name: 'Empresa A', is_active_in_prospecting: true },
    { id: 'id-2', name: 'Empresa B', is_active_in_prospecting: true },
    { id: 'id-3', name: 'Empresa C', is_active_in_prospecting: true },
  )

  const r = await inject(
    'POST',
    '/api/leads/permanent-delete',
    { lead_ids: ['id-1'], password: LOGIN_PASSWORD, email: LOGIN_EMAIL },
    auth(),
  )
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.deleted, 1)

  // DELETE em leads com filtro id=in.(...) contendo apenas id-1
  assert.equal(store.deleteCalls.length, 1)
  const delIds = inParam(store.deleteCalls[0])
  assert.deepEqual(delIds, ['id-1'])

  // auditoria da exclusão
  assert.equal(store.auditLogs.length, 1)
  assert.equal(store.auditLogs[0].action, 'leads.permanent_delete')
  assert.equal(store.auditLogs[0].user_id, 'user-1')

  // apenas id-1 foi removido do armazenamento
  assert.equal(store.leads.some((l) => l.id === 'id-1'), false)
  assert.equal(store.leads.some((l) => l.id === 'id-2'), true)
  assert.equal(store.leads.some((l) => l.id === 'id-3'), true)
})

test('6) permanent-delete sem autenticação => 401', async () => {
  clearStore()
  const r = await inject('POST', '/api/leads/permanent-delete', {
    lead_ids: ['id-1'],
    password: LOGIN_PASSWORD,
    email: LOGIN_EMAIL,
  })
  assert.equal(r.status, 401)
  assert.equal(r.body.error, 'unauthorized')
})

test('7) permanent-delete sem email => 400', async () => {
  clearStore()
  const r = await inject('POST', '/api/leads/permanent-delete', { lead_ids: ['id-1'], password: LOGIN_PASSWORD }, auth())
  assert.equal(r.status, 400)
  assert.equal(r.body.error, 'email_required')
})

test('8) clear-list sem lead_ids => 400', async () => {
  clearStore()
  const r = await inject('POST', '/api/leads/clear-list', { lead_ids: [] }, auth())
  assert.equal(r.status, 400)
  assert.equal(r.body.error, 'lead_ids_required')
})
