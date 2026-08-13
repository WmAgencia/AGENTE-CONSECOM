/**
 * Testes da Regra B — portão de sequência de campanha (campaign.gate.ts).
 *
 * A IA é bloqueada SOMENTE quando o lead está EM DISPARO (send_run com status
 * 'running' — o lead ativo da fila sequencial). Nesses casos a mensagem do lead
 * é PRESERVADA (conversation store + consecom_conversations).
 *
 * 1) Sem run ativo => IA LIBERADA.
 * 2) Run 'pending' (aguardando a vez na fila) => IA LIBERADA (ainda não é o
 *    lead em disparo).
 * 3) Run 'running' (em disparo agora) => IA BLOQUEADA e mensagem preservada.
 * 4) Run 'done'/'failed' (concluído/interrompido) => IA LIBERADA.
 * 5) Teste do webhook (rota /webhook/evolution): com lead em disparo, o evento
 *    é aceito, a mensagem é salva e NENHUMA resposta é enviada.
 *
 * O Supabase/Evolution viram um armazenamento em memória via fetch mockado.
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'

// Env antes de carregar módulos (env.ts é cacheado). SEM DATABASE_URL =>
// conversation store usa fallback em memória.
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

interface RunRow {
  id: string
  lead_id: string
  campaign_id: string
  status: string
}
interface LeadRow {
  id: string
  name: string
  phone: string
  status: string
  niche: string | null
  category: string | null
  ai_control?: 'ai' | 'human'
}

const store = {
  runs: [] as RunRow[],
  leads: [] as LeadRow[],
  conversations: [] as Array<{ lead_id: string; role: string; content: string; agent_model: string | null }>,
  evolutionSent: [] as Array<{ to: string; text: string }>,
  campaigns: [{ id: 'c1', status: 'em_progresso' }],
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

function eqParam(url: string, key: string): string | null {
  const m = url.match(new RegExp(`${key}=eq\\.([^&]+)`))
  return m ? m[1] : null
}

async function mockFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = decodeURIComponent(typeof input === 'string' ? input : String(input))
  const method = (init?.method ?? 'GET').toUpperCase()
  const body = init?.body && method !== 'GET' ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null

  if (url.includes('/rest/v1/leads')) {
    if (method === 'GET') {
      const id = eqParam(url, 'id')
      if (id) return jsonRes(store.leads.filter((l) => l.id === id))
      return jsonRes(store.leads)
    }
    if (method === 'PATCH') {
      const id = eqParam(url, 'id')
      const lead = store.leads.find((l) => l.id === id)
      if (lead) Object.assign(lead, body)
      return jsonRes([])
    }
  }

  if (url.includes('/rest/v1/send_runs')) {
    if (method === 'GET') {
      const leadId = eqParam(url, 'lead_id')
      // Novo portão: só runs em disparo (status=eq.running) bloqueiam.
      const runningOnly = /status=eq\.running/.test(url)
      let out = store.runs.filter((r) => !leadId || r.lead_id === leadId)
      if (runningOnly) out = out.filter((r) => r.status === 'running')
      return jsonRes(out)
    }
  }

  if (url.includes('/rest/v1/campaigns') && method === 'GET') {
    const id = eqParam(url, 'id')
    if (id) return jsonRes(store.campaigns.filter((c) => c.id === id))
    return jsonRes([])
  }

  if (url.includes('/rest/v1/consecom_conversations')) {
    if (method === 'POST') {
      store.conversations.push(body as never)
      return jsonRes([])
    }
    return jsonRes([])
  }

  if (url.includes('/rest/v1/agent_settings')) return jsonRes([])
  if (url.includes('/rest/v1/strategies')) return jsonRes([])
  if (url.includes('/rest/v1/campaign_strategies')) return jsonRes([])
  if (url.includes('/rest/v1/agent_learning')) return jsonRes([])
  if (url.includes('/rest/v1/ai_memory')) return jsonRes([])
  if (url.includes('/rest/v1/whatsapp_connections')) return jsonRes([])

  if (url.includes('/message/sendText/')) {
    const to = String(body?.number ?? '')
    const text = String(body?.text ?? '')
    store.evolutionSent.push({ to, text })
    return jsonRes({ key: { id: 'mock-msg' } })
  }

  return jsonRes([])
}

before(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

async function newGate() {
  const mod = await import('../services/campaign.gate.js')
  return mod
}

function setupLead(): LeadRow {
  const lead: LeadRow = {
    id: 'lead-1',
    name: 'Lead Um',
    phone: '11999990001',
    status: 'novo',
    niche: null,
    category: null,
  }
  store.leads.push(lead)
  return lead
}

function clearStore(): void {
  store.runs.length = 0
  store.leads.length = 0
  store.conversations.length = 0
  store.evolutionSent.length = 0
}

// ---------------------------------------------------------------------------
// Portão (Regra B)
// ---------------------------------------------------------------------------

test('1) sem run ativo => IA liberada (block=false, nada salvo)', async () => {
  clearStore()
  const { blockIfSequenceActive } = await newGate()
  const blocked = await blockIfSequenceActive({ leadId: 'lead-1', conversationId: 'wa:x', text: 'Oi' })
  assert.equal(blocked, false)
  assert.equal(store.conversations.length, 0, 'nada é salvo quando a IA pode responder')
  assert.equal(store.evolutionSent.length, 0)
})

test('2) run pending (aguardando a vez na fila) => IA LIBERADA (não é o lead em disparo)', async () => {
  clearStore()
  store.runs.push({ id: 'r1', lead_id: 'lead-1', campaign_id: 'c1', status: 'pending' })

  const { blockIfSequenceActive } = await newGate()
  const blocked = await blockIfSequenceActive({
    leadId: 'lead-1',
    conversationId: 'wa:lead-1',
    text: 'Oi, quero saber mais',
  })
  assert.equal(blocked, false, 'lead apenas enfileirado não bloqueia a IA')

  // nada é salvo / enviado quando a IA pode responder
  assert.equal(store.conversations.length, 0)
  assert.equal(store.evolutionSent.length, 0)
})

test('3) run running (lead em disparo) => IA bloqueada e mensagem do lead preservada', async () => {
  clearStore()
  store.runs.push({ id: 'r2', lead_id: 'lead-1', campaign_id: 'c1', status: 'running' })
  const { isLeadSequenceActive, blockIfSequenceActive } = await newGate()
  assert.equal(await isLeadSequenceActive('lead-1'), true)
  const blocked = await blockIfSequenceActive({
    leadId: 'lead-1',
    conversationId: 'wa:lead-1',
    text: 'Oi, quero saber mais',
  })
  assert.equal(blocked, true, 'IA bloqueada enquanto o lead está em disparo')

  // mensagem preservada no histórico persistido
  assert.deepEqual(
    store.conversations.map((c) => ({ lead: c.lead_id, role: c.role, content: c.content })),
    [{ lead: 'lead-1', role: 'user', content: 'Oi, quero saber mais' }],
  )
  // nenhuma resposta de IA / Evolution foi disparada
  assert.equal(store.evolutionSent.length, 0, 'IA não responde enquanto bloqueada')

  // mensagem também preservada no conversation store (contexto completo)
  const { getConversationStore } = await import('../services/conversation.store.js')
  const turns = await getConversationStore().get('wa:lead-1')
  assert.ok(turns.some((t) => t.role === 'user' && t.content === 'Oi, quero saber mais'))
})

test('4) run done => IA liberada (sequência concluída)', async () => {
  clearStore()
  store.runs.push({ id: 'r3', lead_id: 'lead-1', campaign_id: 'c1', status: 'done' })
  const { isLeadSequenceActive, blockIfSequenceActive } = await newGate()
  assert.equal(await isLeadSequenceActive('lead-1'), false)
  assert.equal(
    await blockIfSequenceActive({ leadId: 'lead-1', conversationId: 'wa:x', text: 'oi3' }),
    false,
    'após concluir a sequência a IA volta a responder',
  )
})

test('5) run failed => IA liberada (sequência interrompida)', async () => {
  clearStore()
  store.runs.push({ id: 'r4', lead_id: 'lead-1', campaign_id: 'c1', status: 'failed' })
  const { isLeadSequenceActive, blockIfSequenceActive } = await newGate()
  assert.equal(await isLeadSequenceActive('lead-1'), false)
  assert.equal(
    await blockIfSequenceActive({ leadId: 'lead-1', conversationId: 'wa:x', text: 'oi4' }),
    false,
    'sequência interrompida libera a IA',
  )
})

// ---------------------------------------------------------------------------
// Webhook: rota real /webhook/evolution bloqueada por sequência ativa
// ---------------------------------------------------------------------------

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout aguardando condição')
    await new Promise((r) => setTimeout(r, 20))
  }
}

test('6) webhook: sequência ativa => aceita, salva mensagem e NÃO chama a IA', async () => {
  clearStore()
  const lead = setupLead()
  store.runs.push({ id: 'r1', lead_id: lead.id, campaign_id: 'c1', status: 'running' })

  const { buildApp } = await import('../app.js')
  const { app } = buildApp()
  await app.ready()

  const res = await app.inject({
    method: 'POST',
    url: '/webhook/evolution',
    headers: {
      'x-webhook-secret': 'test-secret',
      'content-type': 'application/json',
    },
    payload: {
      event: 'messages.upsert',
      instance: 'inst',
      data: {
        key: { id: 'webhook-k1', remoteJid: '5511999990001@s.whatsapp.net', fromMe: false },
        message: { conversation: 'Oi, quero saber mais sobre o serviço' },
        pushName: 'Lead Um',
      },
    },
  })

  assert.equal(res.statusCode, 200)
  assert.equal((res.json() as { accepted: boolean }).accepted, true)

  // processamento assíncrono: aguarda a mensagem ser persistida
  await waitFor(() => store.conversations.length >= 1)
  await waitFor(() => true)

  // mensagem do lead preservada
  const saved = store.conversations.find((c) => c.content.includes('quero saber'))
  assert.ok(saved, 'mensagem do lead foi salva durante o bloqueio')
  assert.equal(saved!.role, 'user')
  assert.equal(saved!.lead_id, 'lead-1')

  // NENHUMA resposta de IA / Evolution (runAgentLoop não foi chamado)
  assert.equal(store.evolutionSent.length, 0, 'webhook não envia resposta enquanto a sequência está ativa')

  await app.close()
})

test('7) takeover persistido => webhook salva a mensagem e não responde este lead', async () => {
  clearStore()
  const lead = setupLead()
  lead.ai_control = 'human'

  const { buildApp } = await import('../app.js')
  const { app } = buildApp()
  await app.ready()
  const res = await app.inject({
    method: 'POST',
    url: '/webhook/evolution',
    headers: { 'x-webhook-secret': 'test-secret', 'content-type': 'application/json' },
    payload: {
      event: 'messages.upsert',
      instance: 'inst',
      data: {
        key: { id: 'webhook-human-1', remoteJid: '5511999990001@s.whatsapp.net', fromMe: false },
        message: { conversation: 'Mensagem para o operador' },
        pushName: 'Lead Um',
      },
    },
  })
  assert.equal(res.statusCode, 200)
  await waitFor(() => store.conversations.some((c) => c.content === 'Mensagem para o operador'))
  assert.equal(store.evolutionSent.length, 0)
  await app.close()
})
