/**
 * Testes do motor de campanha (SendWorker): execução SEQUENCIAL POR LEAD,
 * tratamento de falha e finalização real.
 *
 * O worker real é testado com um `fetch` mockado: o Supabase e a Evolution API
 * viram um armazenamento em memória, e cada `tick()` avança a fila exatamente
 * como em produção (uma mensagem por run quando due).
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'

// Env deve estar setado antes de carregar os módulos (env.ts é cacheado).
process.env.NVIDIA_API_KEY = 'test-key'
process.env.LOG_LEVEL = 'error'
process.env.SUPABASE_URL = 'https://vyntra-mock.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role'
process.env.SUPABASE_MARCAR_REUNIAO_RPC = 'consecom_marcar_reuniao'
process.env.EVOLUTION_API_URL = 'http://evolution.mock'
process.env.EVOLUTION_API_KEY = 'mock'
process.env.EVOLUTION_INSTANCE_NAME = 'inst'
process.env.EVOLUTION_SENDTEXT_MAX_RETRIES = '1'
process.env.CONSECOM_WORKER_TICK_MS = '5000'

interface Run {
  id: string
  campaign_id: string
  lead_id: string
  status: string
  current_position: number
  next_send_at: string | null
  created_at: string
}
interface Lead {
  id: string
  name: string
  phone: string
  status: string
  last_message_sent: string | null
}
interface Campaign {
  id: string
  name: string
  status: string
  started_at: string | null
  finished_at: string | null
  success_count: number
  fail_count: number
}
interface Message {
  id: string
  campaign_id: string
  position: number
  kind: 'text'
  text: string
  media_url: string | null
  media_caption: string | null
  delay_seconds: number
}

const store = {
  campaigns: new Map<string, Campaign>(),
  runs: new Map<string, Run>(),
  leads: new Map<string, Lead>(),
  messages: new Map<string, Message[]>(),
  sent: [] as Array<{ to: string; text: string }>,
  finalizeSeq: [] as number[],
  failSend: new Set<string>(),
}
let sendSeq = 0

function jsonRes(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: { get: () => 'application/json' },
  } as unknown as Response
}

async function mockFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = decodeURIComponent(typeof input === 'string' ? input : String(input))
  const method = (init?.method ?? 'GET').toUpperCase()
  const body = init?.body && method !== 'GET' ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null

  const eq = (key: string): string | null => {
    const m = url.match(new RegExp(`${key}=eq\\.([^&]+)`))
    return m ? m[1] : null
  }

  if (url.includes('/rest/v1/campaigns')) {
    if (method === 'GET') {
      const id = eq('id')
      if (id) return jsonRes([store.campaigns.get(id)].filter((c): c is Campaign => Boolean(c)))
      // lista usada pelo tick: só campanhas ainda ativas (status=eq.em_progresso)
      return jsonRes([...store.campaigns.values()].filter((c) => c.status === 'em_progresso'))
    }
    if (method === 'PATCH') {
      const id = eq('id')!
      const c = store.campaigns.get(id)!
      Object.assign(c, body)
      if (body?.status === 'finalizada') store.finalizeSeq.push(sendSeq)
      return jsonRes([])
    }
  }

  if (url.includes('/rest/v1/send_runs')) {
    if (method === 'GET') {
      const campId = eq('campaign_id')
      const out = [...store.runs.values()]
        .filter((r) => r.campaign_id === campId && (r.status === 'pending' || r.status === 'running'))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
      return jsonRes(out)
    }
    if (method === 'PATCH') {
      const id = eq('id')!
      Object.assign(store.runs.get(id)!, body)
      return jsonRes([])
    }
  }

  if (url.includes('/rest/v1/queue_messages')) {
    const campId = eq('campaign_id')
    const msgs = [...(store.messages.get(campId!) ?? [])].sort((a, b) => a.position - b.position)
    return jsonRes(msgs)
  }

  if (url.includes('/rest/v1/leads')) {
    if (method === 'GET') {
      const id = eq('id')
      if (id) return jsonRes([store.leads.get(id)].filter((l): l is Lead => Boolean(l)))
      return jsonRes([])
    }
    if (method === 'PATCH') {
      const id = eq('id')!
      Object.assign(store.leads.get(id)!, body)
      return jsonRes([])
    }
  }

  if (url.includes('/rest/v1/lead_status_history')) return jsonRes([])
  if (url.includes('/rest/v1/campaign_strategies')) return jsonRes([])
  if (url.includes('/rest/v1/agent_settings')) return jsonRes([])

  if (url.includes('/message/sendText/')) {
    const to = String(body?.number ?? '')
    const text = String(body?.text ?? '')
    sendSeq++
    if (store.failSend.has(`${to}|${text}`)) {
      return jsonRes({ error: 'boom' }, 500)
    }
    store.sent.push({ to, text })
    return jsonRes({ key: { id: `mock-${sendSeq}` } })
  }

  return jsonRes([])
}

before(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

async function newWorker() {
  const { SendWorker } = await import('../services/send.worker.js')
  return new SendWorker()
}

function setupCampaign(msgs: string[], delaySeconds = 0): void {
  store.campaigns.set('c1', {
    id: 'c1',
    name: 'C1',
    status: 'em_progresso',
    started_at: '2026-08-10T12:00:00.000Z',
    finished_at: null,
    success_count: 0,
    fail_count: 0,
  })
  store.messages.set(
    'c1',
    msgs.map((m, i) => ({
      id: `m${i}`,
      campaign_id: 'c1',
      position: i,
      kind: 'text' as const,
      text: m,
      media_url: null,
      media_caption: null,
      delay_seconds: delaySeconds,
    })),
  )
}

function setupLead(name: string, phone: string): Lead {
  const l: Lead = { id: `lead-${store.leads.size + 1}`, name, phone, status: 'novo', last_message_sent: null }
  store.leads.set(l.id, l)
  return l
}

function enqueue(lead: Lead, createdMs: number): Run {
  const at = new Date(createdMs).toISOString()
  const r: Run = {
    id: `run-${lead.id}`,
    campaign_id: 'c1',
    lead_id: lead.id,
    status: 'pending',
    current_position: 0,
    next_send_at: at,
    created_at: at,
  }
  store.runs.set(r.id, r)
  return r
}

function resetBoard(msgCount: number, delaySeconds = 0, ...leads: Lead[]): { now: number } {
  store.runs.clear()
  store.sent.length = 0
  store.finalizeSeq.length = 0
  store.failSend.clear()
  sendSeq = 0
  setupCampaign(Array.from({ length: msgCount }, (_, i) => `M${i + 1}`), delaySeconds)
  const now = Date.now()
  leads.forEach((l, i) => enqueue(l, now + i))
  return { now }
}

async function runTicks(worker: { tick(): Promise<void> }, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await worker.tick()
}

test('A) sequência estrita por lead: L1 M1,M2,M3 -> L2 -> L3 e finalização 1x', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  const l3 = setupLead('Lead 3', '11999990003')
  resetBoard(3, 0, l1, l2, l3)

  const w = await newWorker()
  await runTicks(w, 20)

  const seq = store.sent.map((s) => `${s.to}|${s.text}`)
  assert.deepEqual(seq, [
    '5511999990001|M1',
    '5511999990001|M2',
    '5511999990001|M3',
    '5511999990002|M1',
    '5511999990002|M2',
    '5511999990002|M3',
    '5511999990003|M1',
    '5511999990003|M2',
    '5511999990003|M3',
  ])

  assert.equal(store.leads.get(l1.id)!.status, 'enviado')
  assert.equal(store.leads.get(l2.id)!.status, 'enviado')
  assert.equal(store.leads.get(l3.id)!.status, 'enviado')

  // Finalização única, só depois do último envio
  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
  assert.equal(store.finalizeSeq.length, 1)
  assert.ok(store.finalizeSeq[0] >= seq.length, 'finaliza depois do último envio')
})

test('A2) intervalo configurado bloqueia a próxima mensagem até o tempo passar', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  resetBoard(2, 600, l1, l2) // delay 10min

  const w = await newWorker()
  await w.tick() // M1 L1

  assert.deepEqual(store.sent.map((s) => `${s.to}|${s.text}`), ['5511999990001|M1'])

  // Vários ticks imediatos NÃO avançam (L1 M2 não due; L2 NÃO começa).
  await runTicks(w, 5)
  assert.deepEqual(store.sent.map((s) => `${s.to}|${s.text}`), ['5511999990001|M1'])
  assert.equal(store.runs.get(`run-${l2.id}`)!.status, 'pending', 'L2 não começa enquanto L1 não concluir')

  // Simula o intervalo decorrido (próximo tick envia M2 e conclui L1)
  const now = Date.now()
  store.runs.get(`run-${l1.id}`)!.next_send_at = new Date(now - 1000).toISOString()
  await w.tick()
  assert.deepEqual(store.sent.map((s) => `${s.to}|${s.text}`), ['5511999990001|M1', '5511999990001|M2'])

  store.runs.get(`run-${l1.id}`)!.next_send_at = new Date(now - 1000).toISOString()
  await w.tick() // L1 done -> L2 M1
  assert.equal(store.sent.length, 3)
  assert.equal(store.sent[2].to, '5511999990002')
})

test('B) falha: registra, não duplica, não reinicia, finaliza só no fim', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  resetBoard(3, 0, l1, l2)
  store.failSend.add('5511999990001|M2')

  const w = await newWorker()
  await runTicks(w, 20)

  // L1: SÓ M1 foi enviada. A M2 falhou (500, maxRetries=1) e o run parou.
  const l1Sends = store.sent.filter((s) => s.to === '5511999990001')
  assert.deepEqual(l1Sends.map((s) => s.text), ['M1'])
  assert.equal(l1Sends.filter((s) => s.text === 'M2').length, 0, 'M2 nunca é enviada')

  const run1 = store.runs.get(`run-${l1.id}`)!
  assert.equal(run1.status, 'failed')
  assert.equal(run1.current_position, 1, 'parou exatamente na M2')

  // L1 não vira 'enviado' (sequência incompleta)
  assert.equal(store.leads.get(l1.id)!.status, 'novo')

  // L2 roda normalmente depois
  const l2Sends = store.sent.filter((s) => s.to === '5511999990002')
  assert.deepEqual(l2Sends.map((s) => s.text), ['M1', 'M2', 'M3'])
  assert.equal(store.leads.get(l2.id)!.status, 'enviado')

  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
  assert.equal(store.finalizeSeq.length, 1)
})

test('E) múltiplas falhas: cada lead independe, finalização 1x no fim', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  const l3 = setupLead('Lead 3', '11999990003')
  resetBoard(3, 0, l1, l2, l3)
  store.failSend.add('5511999990001|M2')
  store.failSend.add('5511999990002|M2')
  store.failSend.add('5511999990003|M2')

  const w = await newWorker()
  await runTicks(w, 30)

  const seq = store.sent.map((s) => `${s.to}|${s.text}`)
  assert.deepEqual(seq, ['5511999990001|M1', '5511999990002|M1', '5511999990003|M1'])

  for (const l of [l1, l2, l3]) {
    assert.equal(store.runs.get(`run-${l.id}`)!.status, 'failed')
    assert.equal(store.runs.get(`run-${l.id}`)!.current_position, 1)
  }

  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
  assert.equal(store.finalizeSeq.length, 1)
  assert.ok(store.finalizeSeq[0] >= seq.length)
})