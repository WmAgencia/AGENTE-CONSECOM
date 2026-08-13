/**
 * Testes do motor de campanha (SendWorker) — Regra A (fila SEQUENCIAL por
 * lead: um lead por vez, sequência completa antes do próximo) e Regra B
 * (falha mantém o lead ativo em retry; os demais aguardam a vez).
 *
 * O worker real é testado com um `fetch` mockado: o Supabase e a Evolution API
 * viram um armazenamento em memória, e cada `tick()` avança exatamente como em
 * produção (em cada tick a campanha dispara APENAS o lead ativo, respeitando o
 * intervalo next_send_at do próprio lead).
 *
 * Ordem esperada (sequencial): L1 M1..M4 -> L2 M1..M4 -> L3 M1..M4
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
process.env.CONSECOM_SEND_MAX_RETRIES = '3'
process.env.CONSECOM_SEND_RETRY_BACKOFF_MS = '60000'
process.env.EVOLUTION_RATE_LIMIT_MAX_PER_MINUTE = '0'
process.env.EVOLUTION_SEND_JITTER_MIN_MS = '0'
process.env.EVOLUTION_SEND_JITTER_MAX_MS = '0'

interface Run {
  id: string
  campaign_id: string
  lead_id: string
  status: string
  current_position: number
  next_send_at: string | null
  created_at: string
  connection_id?: string | null
  connection_instance?: string | null
  fail_reason?: string | null
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
  connection_ids?: string[] | null
}
interface Connection {
  id: string
  instance_name: string
  status: string
}
interface Message {
  id: string
  campaign_id: string
  position: number
  kind: 'text' | 'video'
  text: string
  media_url: string | null
  media_caption: string | null
  delay_seconds: number
}

const store = {
  campaigns: new Map<string, Campaign>(),
  runs: new Map<string, Run>(),
  leads: new Map<string, Lead>(),
  connections: new Map<string, Connection>(),
  messages: new Map<string, Message[]>(),
  sent: [] as Array<{ to: string; text: string; instance?: string }>,
  finalizeSeq: [] as number[],
  failSend: new Set<string>(),
  killOnFail: new Set<string>(),
  leadHistory: [] as Array<{ lead_id: string; status: string; notes: string | null }>,
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
      // lista usada pelo tick: campanhas ativas (acao do worker em_progresso e
      // as que estão aguardando conexão para auto-resumo).
      return jsonRes(
        [...store.campaigns.values()].filter(
          (c) => c.status === 'em_progresso' || c.status === 'waiting_connection',
        ),
      )
    }
    if (method === 'PATCH') {
      const id = eq('id')!
      const c = store.campaigns.get(id)!
      Object.assign(c, body)
      if (body?.status === 'finalizada') store.finalizeSeq.push(sendSeq)
      return jsonRes([])
    }
  }

  if (url.includes('/rest/v1/whatsapp_connections')) {
    const id = eq('id')
    const inst = eq('instance_name')
    // or=(id.eq.<a>,id.eq.<b>) -> pool de conexões configurado da campanha.
    const orMatch = url.match(/or=\(([^)]+)\)/)
    let rows = [...store.connections.values()]
    if (orMatch) {
      const ids = new Set(
        orMatch[1]
          .split(',')
          .map((s) => s.replace(/^id\.eq\./, ''))
          .filter(Boolean),
      )
      rows = rows.filter((c) => ids.has(c.id))
    } else if (id) {
      rows = rows.filter((c) => c.id === id)
    } else if (inst) {
      rows = rows.filter((c) => c.instance_name === inst)
    }
    return jsonRes(rows)
  }

  if (url.includes('/rest/v1/send_runs')) {
    if (method === 'GET') {
      const campId = eq('campaign_id')
      // Espelha a ordenação do worker (Regra A): ordem de ENTRADA (created_at,
      // depois id). current_position/next_send_at são por-lead.
      const out = [...store.runs.values()]
        .filter((r) => r.campaign_id === campId && (r.status === 'pending' || r.status === 'running'))
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
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

  if (url.includes('/rest/v1/lead_status_history')) {
    store.leadHistory.push(body as never)
    return jsonRes([])
  }
  if (url.includes('/rest/v1/campaign_strategies')) return jsonRes([])
  if (url.includes('/rest/v1/agent_settings')) return jsonRes([])
  if (url.includes('/rest/v1/consecom_conversations')) return jsonRes([])

  if (url.includes('/message/sendMedia/')) {
    const to = String(body?.number ?? '')
    const kind = String(body?.mediatype ?? 'media')
    const media = String(body?.media ?? '')
    const instance = decodeURIComponent(url.split('/message/sendMedia/')[1].split('?')[0])
    sendSeq++
    if (store.failSend.has(`${to}|media:${kind}`)) {
      if (store.killOnFail.has(instance)) {
        for (const c of store.connections.values()) if (c.instance_name === instance) c.status = 'disconnected'
      }
      return jsonRes({ error: 'boom' }, 500)
    }
    store.sent.push({ to, text: `[media:${kind}] ${media}`, instance })
    return jsonRes({ key: { id: `mock-${sendSeq}` } })
  }

  if (url.includes('/message/sendText/')) {
    const to = String(body?.number ?? '')
    const text = String(body?.text ?? '')
    const instance = decodeURIComponent(url.split('/message/sendText/')[1].split('?')[0])
    sendSeq++
    if (store.failSend.has(`${to}|${text}`)) {
      if (store.killOnFail.has(instance)) {
        for (const c of store.connections.values()) if (c.instance_name === instance) c.status = 'disconnected'
      }
      return jsonRes({ error: 'boom' }, 500)
    }
    store.sent.push({ to, text, instance })
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

type MsgSpec = { text: string; kind?: 'text' | 'video'; delay_seconds?: number }

function setupCampaign(msgs: MsgSpec[], globalDelay: number | number[] = 0, connectionIds?: string[] | null): void {
  const delays = Array.isArray(globalDelay) ? globalDelay : msgs.map(() => globalDelay)
  store.campaigns.set('c1', {
    id: 'c1',
    name: 'C1',
    status: 'em_progresso',
    started_at: '2026-08-10T12:00:00.000Z',
    finished_at: null,
    success_count: 0,
    fail_count: 0,
    connection_ids: connectionIds ?? null,
  })
  store.messages.set(
    'c1',
    msgs.map((m, i) => ({
      id: `m${i}`,
      campaign_id: 'c1',
      position: i,
      kind: m.kind ?? 'text',
      text: m.text,
      media_url: m.kind === 'video' ? 'videos/promo.mp4' : null,
      media_caption: m.kind === 'video' ? m.text : null,
      delay_seconds: m.delay_seconds ?? delays[i] ?? 0,
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
    // next_send_at no passado: o 1º run da fila fica elegível já no 1º tick.
    next_send_at: '2000-01-01T00:00:00.000Z',
    created_at: at,
  }
  store.runs.set(r.id, r)
  return r
}

function resetBoard(
  msgs: number | MsgSpec[],
  delaySeconds: number | number[] = 0,
  ...leads: Lead[]
): { now: number } {
  store.runs.clear()
  store.sent.length = 0
  store.finalizeSeq.length = 0
  store.failSend.clear()
  store.killOnFail.clear()
  store.leadHistory.length = 0
  store.connections.clear()
  sendSeq = 0
  const specs: MsgSpec[] =
    typeof msgs === 'number'
      ? Array.from({ length: msgs }, (_, i) => ({ text: `M${i + 1}` }))
      : msgs
  setupCampaign(specs, delaySeconds)
  const now = Date.now()
  // created_at distinto (ordem de entrada: L1 mais antigo => dispara primeiro).
  leads.forEach((l, i) => enqueue(l, now + i))
  return { now }
}

function addConnection(id: string, instanceName: string, status = 'connected'): void {
  store.connections.set(id, { id, instance_name: instanceName, status })
}

async function runTicks(worker: { tick(): Promise<void> }, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await worker.tick()
}

/** Força os runs dos leads a ficarem elegíveis (retry com backoff decorrido). */
function makeDue(...leadIds: string[]): void {
  const past = new Date(Date.now() - 1000).toISOString()
  for (const id of leadIds) {
    const run = store.runs.get(`run-${id}`)
    if (run) run.next_send_at = past
  }
}

test('1) OBRIGATÓRIO: 3 leads x 4 mensagens (3 texto + 1 vídeo), intervalos 6s/3s/3s — um lead por vez', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  const l3 = setupLead('Lead 3', '11999990003')
  resetBoard(
    [
      { text: 'M1', delay_seconds: 6 },
      { text: 'M2', delay_seconds: 3 },
      { text: 'M3', delay_seconds: 3 },
      { text: 'M4', kind: 'video' },
    ],
    0,
    l1,
    l2,
    l3,
  )

  const w = await newWorker()

  // Tick 1: apenas L1 M1 (texto). L2/L3 NÃO começam.
  await w.tick()
  assert.deepEqual(store.sent.map((s) => `${s.to}|${s.text}`), ['5511999990001|M1'])

  // Intervalo de 6s do M1: ticks seguintes NÃO enviam nada (nem do L1, nem trocam de lead).
  await runTicks(w, 3)
  assert.deepEqual(store.sent.map((s) => `${s.to}|${s.text}`), ['5511999990001|M1'])
  assert.equal(store.runs.get(`run-${l1.id}`)!.status, 'running')
  assert.equal(store.runs.get(`run-${l2.id}`)!.status, 'pending', 'L2 aguarda a vez na fila')

  // L1 M2 (3s) -> L1 M3 (3s) -> L1 M4 (vídeo) => L1 conclui inteiro.
  makeDue(l1.id)
  await w.tick()
  makeDue(l1.id)
  await w.tick()
  makeDue(l1.id)
  await w.tick()
  assert.deepEqual(store.sent.map((s) => `${s.to}|${s.text}`), [
    '5511999990001|M1',
    '5511999990001|M2',
    '5511999990001|M3',
    '5511999990001|[media:video] https://vyntra-mock.supabase.co/storage/v1/object/public/videos/promo.mp4',
  ])
  assert.equal(store.leads.get(l1.id)!.status, 'enviado')

  // Agora L2 começa (sequência do L1 terminou antes).
  await w.tick()
  assert.deepEqual(store.sent.slice(-1).map((s) => `${s.to}|${s.text}`), ['5511999990002|M1'])

  // L2 completa a própria sequência.
  makeDue(l2.id)
  await w.tick()
  makeDue(l2.id)
  await w.tick()
  makeDue(l2.id)
  await w.tick()
  assert.deepEqual(
    store.sent.filter((s) => s.to === '5511999990002').map((s) => s.text),
    ['M1', 'M2', 'M3', '[media:video] https://vyntra-mock.supabase.co/storage/v1/object/public/videos/promo.mp4'],
  )
  assert.equal(store.leads.get(l2.id)!.status, 'enviado')

  // L3 por último.
  await w.tick()
  assert.deepEqual(store.sent.slice(-1).map((s) => `${s.to}|${s.text}`), ['5511999990003|M1'])
  makeDue(l3.id)
  await w.tick()
  makeDue(l3.id)
  await w.tick()
  makeDue(l3.id)
  await w.tick()
  assert.deepEqual(
    store.sent.filter((s) => s.to === '5511999990003').map((s) => s.text),
    ['M1', 'M2', 'M3', '[media:video] https://vyntra-mock.supabase.co/storage/v1/object/public/videos/promo.mp4'],
  )
  assert.equal(store.leads.get(l3.id)!.status, 'enviado')

  await w.tick() // finaliza
  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
  assert.equal(store.finalizeSeq.length, 1)
})

test('A) sequencial por lead: L1 M1..M3 -> L2 M1..M3 -> L3 M1..M3 e finalização 1x', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  const l3 = setupLead('Lead 3', '11999990003')
  resetBoard(3, 0, l1, l2, l3)

  const w = await newWorker()
  await runTicks(w, 20)

  assert.deepEqual(store.sent.map((s) => `${s.to}|${s.text}`), [
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

  for (const l of [l1, l2, l3]) {
    assert.equal(store.leads.get(l.id)!.status, 'enviado')
  }

  // Finalização única, só depois do último envio
  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
  assert.equal(store.finalizeSeq.length, 1)
  assert.ok(store.finalizeSeq[0] >= store.sent.length, 'finaliza depois do último envio')
})

test('A2) intervalo configurado: bloqueia o MESMO lead e impede o próximo de começar', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  resetBoard(2, 600, l1, l2) // delay 10min no M1

  const w = await newWorker()
  await w.tick() // apenas L1 M1

  assert.deepEqual(store.sent.map((s) => `${s.to}|${s.text}`), ['5511999990001|M1'])
  assert.equal(store.runs.get(`run-${l1.id}`)!.status, 'running')
  assert.equal(store.runs.get(`run-${l2.id}`)!.status, 'pending', 'L2 não inicia enquanto L1 aguarda')

  // Vários ticks imediatos NÃO avançam L1 nem iniciam L2.
  await runTicks(w, 5)
  assert.deepEqual(store.sent.map((s) => `${s.to}|${s.text}`), ['5511999990001|M1'])

  // Intervalo decorrido => L1 M2 (última) => L1 conclui.
  makeDue(l1.id)
  await w.tick()
  assert.deepEqual(store.sent.map((s) => `${s.to}|${s.text}`), ['5511999990001|M1', '5511999990001|M2'])
  assert.equal(store.leads.get(l1.id)!.status, 'enviado')

  // Só depois L2 começa.
  await w.tick()
  assert.deepEqual(store.sent.slice(-1).map((s) => `${s.to}|${s.text}`), ['5511999990002|M1'])

  makeDue(l2.id)
  await w.tick()
  assert.equal(store.leads.get(l2.id)!.status, 'enviado')

  await w.tick() // finaliza (sem runs ativos)
  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
})

test('B) falha na M2: L1 fica ativo em retry, L2 NÃO inicia; após esgotar, L1 falha e L2 começa', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  resetBoard(3, 0, l1, l2)
  store.failSend.add('5511999990001|M2')

  const w = await newWorker()
  await runTicks(w, 3)

  // L1: SÓ M1 foi enviada. M2 falhou (500) e o run permanece ATIVO ('running')
  // com retry agendado — sequência ativa.
  const l1Sends = store.sent.filter((s) => s.to === '5511999990001')
  assert.deepEqual(l1Sends.map((s) => s.text), ['M1'])

  const run1 = store.runs.get(`run-${l1.id}`)!
  assert.equal(run1.status, 'running', 'sequência continua ativa após falha')
  assert.equal(run1.current_position, 1, 'parou exatamente na M2')
  assert.ok(run1.next_send_at && new Date(run1.next_send_at).getTime() > Date.now(), 'retry agendado no futuro')

  // L1 não vira 'enviado' (sequência incompleta)
  assert.equal(store.leads.get(l1.id)!.status, 'novo')

  // CRÍTICO: L2 NÃO começa enquanto L1 está em retry.
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990002'), [])
  assert.equal(store.runs.get(`run-${l2.id}`)!.status, 'pending', 'L2 aguarda a vez')

  // Enquanto o run de L1 segue ativo, a campanha NÃO finaliza.
  assert.equal(store.campaigns.get('c1')!.status, 'em_progresso')

  // Tentativa 2 (ainda falha, segue ativa)
  makeDue(l1.id)
  await w.tick()
  assert.equal(store.runs.get(`run-${l1.id}`)!.status, 'running')
  assert.equal(store.runs.get(`run-${l1.id}`)!.current_position, 1)

  // Tentativa 3 => esgotou CONSECOM_SEND_MAX_RETRIES => L1 'failed'
  makeDue(l1.id)
  await w.tick()
  const run1Final = store.runs.get(`run-${l1.id}`)!
  assert.equal(run1Final.status, 'failed')
  assert.equal(run1Final.current_position, 1, 'parou exatamente na M2')
  assert.equal(store.leads.get(l1.id)!.status, 'novo')
  assert.equal(store.sent.filter((s) => s.to === '5511999990001' && s.text === 'M2').length, 0)

  // Agora L2 inicia e conclui normalmente.
  await w.tick()
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990002').map((s) => s.text), ['M1'])
  makeDue(l2.id)
  await w.tick()
  makeDue(l2.id)
  await w.tick()
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990002').map((s) => s.text), ['M1', 'M2', 'M3'])
  assert.equal(store.leads.get(l2.id)!.status, 'enviado')

  await w.tick() // finaliza após todos os runs terminarem
  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
  assert.equal(store.finalizeSeq.length, 1)
})

test('E) múltiplas falhas: leads falham um a um (sequencial), finalização 1x no fim', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  const l3 = setupLead('Lead 3', '11999990003')
  resetBoard(3, 0, l1, l2, l3)
  store.failSend.add('5511999990001|M2')
  store.failSend.add('5511999990002|M2')
  store.failSend.add('5511999990003|M2')

  const w = await newWorker()
  await w.tick()
  assert.deepEqual(store.sent.map((s) => `${s.to}|${s.text}`), ['5511999990001|M1'])

  // L1 esgota retries da M2 => 'failed'
  for (let i = 0; i < 3; i++) {
    makeDue(l1.id)
    await w.tick()
  }
  assert.equal(store.runs.get(`run-${l1.id}`)!.status, 'failed')

  // L2 começa, falha na M2, esgota => 'failed'
  await w.tick() // L2 M1
  assert.equal(store.runs.get(`run-${l2.id}`)!.status, 'running')
  for (let i = 0; i < 3; i++) {
    makeDue(l2.id)
    await w.tick()
  }
  assert.equal(store.runs.get(`run-${l2.id}`)!.status, 'failed')

  // L3 idem
  await w.tick() // L3 M1
  assert.equal(store.runs.get(`run-${l3.id}`)!.status, 'running')
  for (let i = 0; i < 3; i++) {
    makeDue(l3.id)
    await w.tick()
  }
  assert.equal(store.runs.get(`run-${l3.id}`)!.status, 'failed')

  for (const l of [l1, l2, l3]) {
    assert.equal(store.leads.get(l.id)!.status, 'novo')
  }

  await w.tick() // finaliza após todos os runs terminarem
  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
  assert.equal(store.finalizeSeq.length, 1)
})

test('F) concorrência: ticks simultâneos não duplicam mensagem (execução única)', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  resetBoard(2, 0, l1, l2)

  const w = await newWorker()
  // Três ticks disparados ao mesmo tempo: apenas um processa (busy guard).
  await Promise.all([w.tick(), w.tick(), w.tick()])

  assert.deepEqual(store.sent.map((s) => `${s.to}|${s.text}`), ['5511999990001|M1'])

  await runTicks(w, 10)

  const unique = new Map<string, number>()
  for (const s of store.sent) {
    const k = `${s.to}|${s.text}`
    unique.set(k, (unique.get(k) ?? 0) + 1)
  }
  for (const [k, count] of unique) {
    assert.equal(count, 1, `mensagem duplicada: ${k}`)
  }
  assert.equal(store.leads.get(l1.id)!.status, 'enviado')
  assert.equal(store.leads.get(l2.id)!.status, 'enviado')
  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
  assert.equal(store.finalizeSeq.length, 1)
})

test('G) falha definitiva na M1: lead abortado, M2/M3 não enviadas e próximo lead inicia', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  resetBoard(3, 0, l1, l2)
  store.failSend.add('5511999990001|M1')

  const w = await newWorker()

  // L1 M1 falha (tentativa 1): run segue ativo em retry, nada de M2.
  await w.tick()
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990001'), [])
  assert.equal(store.runs.get(`run-${l1.id}`)!.status, 'running')

  // Esgota retries da M1 => lead ABORTADO (failed_step=1).
  makeDue(l1.id)
  await w.tick() // tentativa 2
  makeDue(l1.id)
  await w.tick() // tentativa 3 => aborta
  const run1 = store.runs.get(`run-${l1.id}`)!
  assert.equal(run1.status, 'failed')
  assert.equal(run1.current_position, 0, 'falhou exatamente na M1')

  // M2/M3 do L1 NUNCA são enviadas.
  assert.equal(
    store.sent.filter((s) => s.to === '5511999990001' && (s.text === 'M2' || s.text === 'M3')).length,
    0,
    'restante da sequência do lead abortado não é enviado',
  )
  assert.equal(store.leads.get(l1.id)!.status, 'novo')

  // failed_step + motivo registrados no histórico do lead.
  const hist = store.leadHistory.find((h) => h.lead_id === l1.id && h.status === 'failed')
  assert.ok(hist, 'aborto registrado no lead_status_history')
  assert.match(hist!.notes ?? '', /failed_step: 1/)
  assert.match(hist!.notes ?? '', /send_failed/)

  // O próximo lead começa normalmente (erro do L1 não trava a campanha).
  await w.tick()
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990002').map((s) => s.text), ['M1'])
  makeDue(l2.id)
  await w.tick()
  makeDue(l2.id)
  await w.tick()
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990002').map((s) => s.text), ['M1', 'M2', 'M3'])
  assert.equal(store.leads.get(l2.id)!.status, 'enviado')

  await w.tick() // finaliza
  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
  assert.equal(store.finalizeSeq.length, 1)
})

test('P1) pausar ENTRE leads: nenhum novo disparo; retomar continua do lead seguinte', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  resetBoard(2, 0, l1, l2)

  const w = await newWorker()
  // L1 conclui a sequência (M1, M2).
  await w.tick()
  await w.tick()
  assert.equal(store.leads.get(l1.id)!.status, 'enviado')

  // PAUSA antes de o L2 começar: status no banco vira 'pausada' (idêntico ao
  // clique no frontend).
  store.campaigns.get('c1')!.status = 'pausada'
  await runTicks(w, 5)
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990002'), [], 'L2 não inicia enquanto pausada')
  assert.equal(store.runs.get(`run-${l2.id}`)!.status, 'pending', 'L2 permanece na fila')

  // RETOMA: volta a 'em_progresso' => L2 dispara do início da própria sequência.
  store.campaigns.get('c1')!.status = 'em_progresso'
  await w.tick()
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990002').map((s) => s.text), ['M1'])
  await w.tick()
  assert.equal(store.leads.get(l2.id)!.status, 'enviado')
  await w.tick() // finaliza
  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
  assert.equal(store.finalizeSeq.length, 1)
})

test('P2) pausar DURANTE um lead: preserva o ponto exato e retomar não reenvia M1/M2', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  resetBoard([{ text: 'M1' }, { text: 'M2' }, { text: 'M3' }], 0, l1)

  const w = await newWorker()
  await w.tick() // L1 M1
  await w.tick() // L1 M2
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990001').map((s) => s.text), ['M1', 'M2'])

  // PAUSA antes do M3 (aguardando o intervalo do M2).
  store.campaigns.get('c1')!.status = 'pausada'
  await runTicks(w, 5)
  assert.deepEqual(
    store.sent.filter((s) => s.to === '5511999990001').map((s) => s.text),
    ['M1', 'M2'],
    'nenhuma mensagem nova durante a pausa',
  )
  assert.equal(store.runs.get(`run-${l1.id}`)!.current_position, 2, 'ponto salvo = M3')

  // RETOMA: M3 é enviado — M1/M2 NUNCA são reenviados.
  store.campaigns.get('c1')!.status = 'em_progresso'
  await w.tick()
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990001').map((s) => s.text), ['M1', 'M2', 'M3'])
  assert.equal(store.leads.get(l1.id)!.status, 'enviado')
  await w.tick() // finaliza
  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
  assert.equal(store.finalizeSeq.length, 1)
})

test('39) TODAS as conexões caem => status waiting_connection (fila preservada); conexão de volta => auto-retoma', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  resetBoard(1, 0, l1, l2)
  addConnection('conn-a', 'instA', 'disconnected')
  addConnection('conn-b', 'instB', 'disconnected')
  store.campaigns.get('c1')!.connection_ids = ['conn-a', 'conn-b']

  const w = await newWorker()

  // Todas fora: a campanha NÃO falha nem finaliza — entra em waiting_connection.
  await w.tick()
  assert.equal(store.campaigns.get('c1')!.status, 'waiting_connection')
  assert.equal(store.runs.get(`run-${l1.id}`)!.status, 'pending', 'fila preservada (não aborta)')
  assert.equal(store.sent.length, 0, 'nenhum envio sem conexão')

  // Uma conexão volta: o worker retoma sozinho (waiting_connection -> em_progresso)
  // e o disparo continua normalmente.
  store.connections.get('conn-a')!.status = 'connected'
  await w.tick()
  assert.equal(store.campaigns.get('c1')!.status, 'em_progresso', 'retomada automática')
  assert.deepEqual(store.sent.map((s) => `${s.to}|${s.text}`), ['5511999990001|M1'])

  // A fila completa normalmente até finalizar.
  await runTicks(w, 10)
  assert.equal(store.leads.get(l1.id)!.status, 'enviado')
  assert.equal(store.leads.get(l2.id)!.status, 'enviado')
  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
  assert.equal(store.finalizeSeq.length, 1)
})

test('41/33) conexão cai no MEIO da sequência => lead NÃO aborta, troca para conexão viva a partir da próxima mensagem', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  resetBoard(3, 0, l1, l2)
  addConnection('conn-a', 'instA', 'connected')
  addConnection('conn-b', 'instB', 'connected')
  store.campaigns.get('c1')!.connection_ids = ['conn-a', 'conn-b']

  const w = await newWorker()
  // Primiero lead começa na conexão que estava no topo do pool (instA).
  await w.tick()
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990001').map((s) => s.text), ['M1'])
  assert.equal(store.runs.get(`run-${l1.id}`)!.connection_instance, 'instA')

  // conexão do lead ativo cai; a outra segue de pé.
  store.connections.get('conn-a')!.status = 'disconnected'
  makeDue(l1.id)
  await w.tick()
  // lead continua: reatribuído p/ instB, na MESMA posição, sem abortar.
  assert.equal(store.runs.get(`run-${l1.id}`)!.connection_instance, 'instB')
  assert.equal(store.runs.get(`run-${l1.id}`)!.status, 'running', 'lead preservado (não abortei)')
  assert.equal(store.runs.get(`run-${l1.id}`)!.current_position, 1)

  // Próxima mensagem (M2) sai pela nova conexão; lead não é trocado.
  makeDue(l1.id)
  await w.tick()
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990001').map((s) => s.text), ['M1', 'M2'])
  assert.equal(store.runs.get(`run-${l1.id}`)!.connection_instance, 'instB', 'segue na conexão viva')

  // L2 não começou enquanto L1 estava no meio da sequência (Regra A mantida).
  assert.equal(store.runs.get(`run-${l2.id}`)!.status, 'pending', 'L2 aguarda a vez')

  makeDue(l1.id)
  await w.tick()
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990001').map((s) => s.text), ['M1', 'M2', 'M3'])
  assert.equal(store.leads.get(l1.id)!.status, 'enviado')

  await w.tick()
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990002').map((s) => s.text), ['M1'])
  assert.equal(store.runs.get(`run-${l2.id}`)!.connection_instance, 'instB')
})

test('40) envio falha com a conexão CAÍDA => reatribuído para conexão viva, tentativa NÃO contabilizada, lead não aborta', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  resetBoard(1, 0, l1, l2)
  addConnection('conn-a', 'instA', 'connected')
  addConnection('conn-b', 'instB', 'connected')
  store.campaigns.get('c1')!.connection_ids = ['conn-a', 'conn-b']

  const w = await newWorker()

  // M1 de L1 falha no envio E a conexão em uso (instA) morre exatamente nesse
  // instante: o worker discrimina falha de CONEXÃO (não é falha do lead).
  store.failSend.add('5511999990001|M1')
  store.killOnFail.add('instA')
  await w.tick()
  assert.equal(store.runs.get(`run-${l1.id}`)!.status, 'running', 'não aborta por falha de conexão')
  assert.equal(store.runs.get(`run-${l1.id}`)!.current_position, 0, 'mensagem não contabilizada')
  assert.equal(store.runs.get(`run-${l1.id}`)!.connection_instance, 'instB', 'reatribuído para conexão viva')
  assert.equal(store.runs.get(`run-${l1.id}`)!.fail_reason, 'connection_failed')
  assert.equal(store.leads.get(l1.id)!.status, 'novo', 'lead não penalizado')
  assert.equal(store.campaigns.get('c1')!.status, 'em_progresso', 'campanha segue ativa')

  // Com a conexão de volta e o envio funcionando, o mesmo passo é retomado.
  store.failSend.clear()
  store.killOnFail.clear()
  store.connections.get('conn-b')!.status = 'connected'
  makeDue(l1.id)
  await w.tick()
  assert.deepEqual(store.sent.map((s) => `${s.to}|${s.text}`), ['5511999990001|M1'])
  assert.equal(store.leads.get(l1.id)!.status, 'enviado')
})

test('42) ROUND-ROBIN real por LEAD: 3 conexões conectadas, 6 leads x 3 mensagens — sequência inteira na mesma conexão, rotacionando conn-a/b/c', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  const l3 = setupLead('Lead 3', '11999990003')
  const l4 = setupLead('Lead 4', '11999990004')
  const l5 = setupLead('Lead 5', '11999990005')
  const l6 = setupLead('Lead 6', '11999990006')
  resetBoard(3, 0, l1, l2, l3, l4, l5, l6)
  addConnection('conn-a', 'instA', 'connected')
  addConnection('conn-b', 'instB', 'connected')
  addConnection('conn-c', 'instC', 'connected')
  store.campaigns.get('c1')!.connection_ids = ['conn-a', 'conn-b', 'conn-c']

  const w = await newWorker()
  // Sequência completa de cada lead (3 mensagens). Sem intervalos: um tick por msg.
  await runTicks(w, 40)

  const sentByPhone = (phone: string) => store.sent.filter((s) => s.to === phone)

  // ROTATION POR LEAD: cada lead envia TODA a sequência pela MESMA conexão.
  assert.equal(sentByPhone('5511999990001').every((s) => s.instance === 'instA'), true, 'L1 toda em instA')
  assert.equal(sentByPhone('5511999990002').every((s) => s.instance === 'instB'), true, 'L2 toda em instB')
  assert.equal(sentByPhone('5511999990003').every((s) => s.instance === 'instC'), true, 'L3 toda em instC')
  assert.equal(sentByPhone('5511999990004').every((s) => s.instance === 'instA'), true, 'L4 toda em instA')
  assert.equal(sentByPhone('5511999990005').every((s) => s.instance === 'instB'), true, 'L5 toda em instB')
  assert.equal(sentByPhone('5511999990006').every((s) => s.instance === 'instC'), true, 'L6 toda em instC')

  // 3 mensagens por lead, sem duplicação, todos concluídos.
  for (const phone of ['5511999990001', '5511999990002', '5511999990003', '5511999990004', '5511999990005', '5511999990006']) {
    assert.equal(sentByPhone(phone).length, 3, `${phone}: 3 mensagens`)
  }
  for (const l of [l1, l2, l3, l4, l5, l6]) assert.equal(store.leads.get(l.id)!.status, 'enviado')
  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
})

test('42b) round-robin IGNORA conexão caída: conn-b desconectada => L1 a, L2 c, L3 a, L4 c, L5 a, L6 c', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  const l3 = setupLead('Lead 3', '11999990003')
  const l4 = setupLead('Lead 4', '11999990004')
  const l5 = setupLead('Lead 5', '11999990005')
  const l6 = setupLead('Lead 6', '11999990006')
  resetBoard(3, 0, l1, l2, l3, l4, l5, l6)
  addConnection('conn-a', 'instA', 'connected')
  addConnection('conn-b', 'instB', 'disconnected') // fora do pool
  addConnection('conn-c', 'instC', 'connected')
  store.campaigns.get('c1')!.connection_ids = ['conn-a', 'conn-b', 'conn-c']

  const w = await newWorker()
  await runTicks(w, 40)

  const first = (phone: string) => store.sent.filter((s) => s.to === phone)[0]
  assert.equal(first('5511999990001').instance, 'instA')
  assert.equal(first('5511999990002').instance, 'instC', 'conn-b ignorada')
  assert.equal(first('5511999990003').instance, 'instA')
  assert.equal(first('5511999990004').instance, 'instC')
  assert.equal(first('5511999990005').instance, 'instA')
  assert.equal(first('5511999990006').instance, 'instC')
  for (const phone of ['5511999990001', '5511999990002', '5511999990003', '5511999990004', '5511999990005', '5511999990006']) {
    assert.equal(store.sent.filter((s) => s.to === phone).length, 3)
  }
})

test('42c) lead migra de conexão no MEIO da sequência SEM reiniciar nem duplicar (WPP cai pós-M1)', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  resetBoard(3, 0, l1)
  addConnection('conn-a', 'instA', 'connected')
  addConnection('conn-b', 'instB', 'connected')
  store.campaigns.get('c1')!.connection_ids = ['conn-a', 'conn-b']

  const w = await newWorker()
  await w.tick() // L1 M1 -> instA
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990001').map((s) => [s.text, s.instance]), [['M1', 'instA']])

  // instA cai no meio da sequência.
  store.connections.get('conn-a')!.status = 'disconnected'
  makeDue(l1.id)
  await w.tick() // reatribui (ainda não envia M2)
  assert.equal(store.runs.get(`run-${l1.id}`)!.connection_instance, 'instB')
  assert.equal(store.runs.get(`run-${l1.id}`)!.current_position, 1, 'posição preservada, sem reiniciar M1')

  makeDue(l1.id)
  await w.tick() // M2 -> instB
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990001').map((s) => [s.text, s.instance]), [
    ['M1', 'instA'],
    ['M2', 'instB'],
  ])
  makeDue(l1.id)
  await w.tick() // M3 -> instB (continua na viva)
  assert.deepEqual(store.sent.filter((s) => s.to === '5511999990001').map((s) => [s.text, s.instance]), [
    ['M1', 'instA'],
    ['M2', 'instB'],
    ['M3', 'instB'],
  ])
  assert.equal(store.leads.get(l1.id)!.status, 'enviado', 'lead conclui normalmente')
})

test('P3) cliques repetidos de retomar NÃO duplicam (estado idempotente + worker único)', async () => {
  const l1 = setupLead('Lead 1', '11999990001')
  const l2 = setupLead('Lead 2', '11999990002')
  resetBoard(2, 0, l1, l2)

  const w = await newWorker()
  await runTicks(w, 2) // L1 M1
  // "Retomar" três vezes: só regrava o mesmo status (em_progresso).
  store.campaigns.get('c1')!.status = 'pausada'
  store.campaigns.get('c1')!.status = 'em_progresso'
  store.campaigns.get('c1')!.status = 'em_progresso'
  store.campaigns.get('c1')!.status = 'em_progresso'

  await runTicks(w, 10)

  const unique = new Map<string, number>()
  for (const s of store.sent) {
    const k = `${s.to}|${s.text}`
    unique.set(k, (unique.get(k) ?? 0) + 1)
  }
  for (const [k, count] of unique) {
    assert.equal(count, 1, `mensagem duplicada: ${k}`)
  }
  assert.equal(store.leads.get(l1.id)!.status, 'enviado')
  assert.equal(store.leads.get(l2.id)!.status, 'enviado')
  assert.equal(store.campaigns.get('c1')!.status, 'finalizada')
  assert.equal(store.finalizeSeq.length, 1)
})
