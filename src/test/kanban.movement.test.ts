/**
 * MODIFICAÇÃO 1 — Regra de movimento do kanban durante sequência de campanha.
 *
 * O lead SÓ vai para "Conversando" quando TODAS as mensagens da campanha foram
 * enviadas. Respota no meio da sequência (run 'pending'/'running'), ou com
 * falha ('failed'), mantém o lead na coluna atual e a sequência continua.
 *
 * 1) isSequenceComplete — matriz de decisão pura:
 *    - sem run => move (comportamento antigo preservado)
 *    - run pendente/em andamento/falho => NÃO move
 *    - run 'done' => move só quando current_position >= total de mensagens
 *    - quebra de leitura (contagens desconhecidas) => fail-open (move)
 * 2) loadLeadSequenceCompleteness — busca do estado via fetch (URLs corretas)
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'

process.env.SUPABASE_URL = 'https://vyntra-mock.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role'

import {
  isSequenceComplete,
  loadLeadSequenceCompleteness,
  canProgressToEnviado,
  planKanbanMove,
  updateLeadStatus,
  type LeadSequenceCompleteness,
} from '../services/supabase.leads.js'
import { detectHandoffSignal } from '../services/intent.classifier.js'

function jsonRes(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: { get: () => 'application/json' },
  } as unknown as Response
}

const store = {
  sendRuns: [] as Array<Record<string, unknown>>,
  queueMessages: [] as Array<{ id: string }>,
  calls: [] as string[],
  historyWrites: [] as Array<{ lead_id: string; status: string }>,
}

async function mockFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = decodeURIComponent(typeof input === 'string' ? input : String(input))
  store.calls.push(url)
  if (url.includes('/rest/v1/send_runs')) return jsonRes(store.sendRuns)
  if (url.includes('/rest/v1/queue_messages')) return jsonRes(store.queueMessages)
  // Simula o CHECK leads_status_check de produção: 'ia'/'necessita_humano'
  // são REJEITADOS com 23514 (constraint) quando a migration v39 não foi
  // aplicada; os demais status passam. Sem a migration, o PATCH falha.
  if (url.includes('/rest/v1/leads')) {
    let body = {}
    try {
      body = init?.body ? JSON.parse(String(init.body)) : {}
    } catch {}
    const s = (body as { status?: string }).status
    const allowed = ['novo', 'na_fila', 'enviado', 'conversando', 'sem_interesse', 'responder_depois']
    if (s && !allowed.includes(s)) {
      return jsonRes({ code: '23514', message: 'new row violates check constraint' }, 400)
    }
    return jsonRes({}, 204)
  }
  if (url.includes('/rest/v1/lead_status_history') && init?.method === 'POST') {
    let body = {}
    try {
      body = init.body ? JSON.parse(String(init.body)) : {}
    } catch {}
    store.historyWrites.push(body as { lead_id: string; status: string })
    return jsonRes([body], 201)
  }
  return jsonRes([])
}

before(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

function reset(): void {
  store.sendRuns.length = 0
  store.queueMessages.length = 0
  store.calls.length = 0
  store.historyWrites.length = 0
}

// --- isSequenceComplete: matriz de decisão pura -------------------------------

test('sem run: move para conversando (comportamento antigo preservado)', () => {
  const info: LeadSequenceCompleteness = { hasRun: false, runStatus: null, currentPosition: null, queueMessageCount: null }
  assert.equal(isSequenceComplete(info), true)
})

test('run pendente (aguardando na fila): NÃO move', () => {
  const info: LeadSequenceCompleteness = { hasRun: true, runStatus: 'pending', currentPosition: 0, queueMessageCount: 3 }
  assert.equal(isSequenceComplete(info), false)
})

test('run em andamento (disparo): NÃO move', () => {
  const info: LeadSequenceCompleteness = { hasRun: true, runStatus: 'running', currentPosition: 1, queueMessageCount: 3 }
  assert.equal(isSequenceComplete(info), false)
})

test('run falho no meio da sequência: NÃO move (mensagem falha não conta)', () => {
  const info: LeadSequenceCompleteness = { hasRun: true, runStatus: 'failed', currentPosition: 2, queueMessageCount: 4 }
  assert.equal(isSequenceComplete(info), false)
})

test('run done com todas as mensagens enviadas: move', () => {
  const info: LeadSequenceCompleteness = { hasRun: true, runStatus: 'done', currentPosition: 3, queueMessageCount: 3 }
  assert.equal(isSequenceComplete(info), true)
})

test('run done com current_position acima do total: move', () => {
  const info: LeadSequenceCompleteness = { hasRun: true, runStatus: 'done', currentPosition: 4, queueMessageCount: 3 }
  assert.equal(isSequenceComplete(info), true)
})

test('run done sem alcançar o total (defensivo): NÃO move', () => {
  const info: LeadSequenceCompleteness = { hasRun: true, runStatus: 'done', currentPosition: 2, queueMessageCount: 3 }
  assert.equal(isSequenceComplete(info), false)
})

test('run done com contagem desconhecida: fail-open (move)', () => {
  const info: LeadSequenceCompleteness = { hasRun: true, runStatus: 'done', currentPosition: 3, queueMessageCount: null }
  assert.equal(isSequenceComplete(info), true)
})

test('campanha sem mensagens (fila vazia, run done): move', () => {
  const info: LeadSequenceCompleteness = { hasRun: true, runStatus: 'done', currentPosition: 0, queueMessageCount: 0 }
  assert.equal(isSequenceComplete(info), true)
})

// --- loadLeadSequenceCompleteness: leitura via fetch (Supabase REST) ----------

test('sem send_runs retorna hasRun=false', async () => {
  reset()
  const info = await loadLeadSequenceCompleteness('lead-1')
  assert.equal(info.hasRun, false)
  assert.equal(info.runStatus, null)
  const runCall = store.calls.find((u) => u.includes('/rest/v1/send_runs')) ?? ''
  assert.match(runCall, /lead_id=eq\.lead-1/)
  assert.match(runCall, /order=created_at\.desc/)
})

test('run done completo: carrega current_position + contagem da fila', async () => {
  reset()
  store.sendRuns = [
    { id: 'run-1', campaign_id: 'camp-1', status: 'done', current_position: 3 },
  ]
  store.queueMessages = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]
  const info = await loadLeadSequenceCompleteness('lead-1')
  assert.equal(info.hasRun, true)
  assert.equal(info.runStatus, 'done')
  assert.equal(info.currentPosition, 3)
  assert.equal(info.queueMessageCount, 3)
  assert.equal(isSequenceComplete(info), true)
  const queueCall = store.calls.find((u) => u.includes('/rest/v1/queue_messages')) ?? ''
  assert.match(queueCall, /campaign_id=eq\.camp-1/)
})

test('run running no meio: carrega estado e NÃO move', async () => {
  reset()
  store.sendRuns = [{ id: 'run-2', campaign_id: 'camp-1', status: 'running', current_position: 1 }]
  store.queueMessages = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]
  const info = await loadLeadSequenceCompleteness('lead-1')
  assert.equal(info.runStatus, 'running')
  assert.equal(isSequenceComplete(info), false)
})

test('run failed: carrega estado e NÃO move', async () => {
  reset()
  store.sendRuns = [{ id: 'run-3', campaign_id: 'camp-1', status: 'failed', current_position: 2 }]
  store.queueMessages = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }, { id: 'm4' }]
  const info = await loadLeadSequenceCompleteness('lead-1')
  assert.equal(info.runStatus, 'failed')
  assert.equal(isSequenceComplete(info), false)
})

test('falha de leitura (fila não retorna): fail-open quando done', async () => {
  reset()
  store.sendRuns = [{ id: 'run-4', campaign_id: 'camp-1', status: 'done', current_position: 2 }]
  store.queueMessages = []
  const info = await loadLeadSequenceCompleteness('lead-1')
  assert.equal(info.queueMessageCount, 0)
  // done + pos(2) >= 0 => move
  assert.equal(isSequenceComplete(info), true)
})

// --- Modo Inteligente: progressão do worker x movimentação manual -------------

// --- planKanbanMove: Modo Inteligente SEMPRE move p/ IA quando a IA responde ---

test('modo inteligente: run pendente NÃO impede movimento para IA (a IA já respondeu)', () => {
  const seq: LeadSequenceCompleteness = { hasRun: true, runStatus: 'pending', currentPosition: 0, queueMessageCount: 0 };
  assert.deepEqual(planKanbanMove({ aiMode: 'intelligent', sequence: seq }), { nextStatus: 'ia' });
});

test('modo inteligente: run done também move para IA', () => {
  const seq: LeadSequenceCompleteness = { hasRun: true, runStatus: 'done', currentPosition: 1, queueMessageCount: 0 };
  assert.deepEqual(planKanbanMove({ aiMode: 'intelligent', sequence: seq }), { nextStatus: 'ia' });
});

test('modo inteligente: sem run também move para IA', () => {
  assert.deepEqual(planKanbanMove({ aiMode: 'intelligent', sequence: null }), { nextStatus: 'ia' });
});

test('modo tradicional: sequência completa move para Conversando', () => {
  const seq: LeadSequenceCompleteness = { hasRun: true, runStatus: 'done', currentPosition: 3, queueMessageCount: 3 };
  assert.deepEqual(planKanbanMove({ aiMode: 'traditional', sequence: seq }), { nextStatus: 'conversando' });
});

test('modo tradicional: sequência incompleta (run pendente) NÃO move', () => {
  const seq: LeadSequenceCompleteness = { hasRun: true, runStatus: 'running', currentPosition: 1, queueMessageCount: 3 };
  assert.deepEqual(planKanbanMove({ aiMode: 'traditional', sequence: seq }), { nextStatus: null });
});

test('modo tradicional: sem run move para Conversando (comportamento antigo)', () => {
  assert.deepEqual(planKanbanMove({ aiMode: 'traditional', sequence: null }), { nextStatus: 'conversando' });
});

test('canProgressToEnviado: estados pré-envio permitem o worker avançar', () => {
  assert.equal(canProgressToEnviado(null), true)
  assert.equal(canProgressToEnviado(''), true)
  assert.equal(canProgressToEnviado('novo'), true)
  assert.equal(canProgressToEnviado('na_fila'), true)
  assert.equal(canProgressToEnviado('enviado'), true)
  assert.equal(canProgressToEnviado('estado_desconhecido'), true)
})

test('canProgressToEnviado: funil avançado NÃO é revertido pelo worker', () => {
  assert.equal(canProgressToEnviado('ia'), false)
  assert.equal(canProgressToEnviado('necessita_humano'), false)
  assert.equal(canProgressToEnviado('conversando'), false)
  assert.equal(canProgressToEnviado('sem_interesse'), false)
  assert.equal(canProgressToEnviado('remarketing'), false)
  assert.equal(canProgressToEnviado('responder_depois'), false)
  assert.equal(canProgressToEnviado('reuniao_marcada'), false)
  assert.equal(canProgressToEnviado('para_ligacao'), false)
  assert.equal(canProgressToEnviado('fechado'), false)
  assert.equal(canProgressToEnviado('nao_fechado'), false)
})

// --- DetectaHandoffSignal: rede de segurança do marker da IA -----------------

test('detectHandoffSignal: intenção explícita de compra dispara handoff', () => {
  assert.equal(detectHandoffSignal('quero fechar com vocês')?.reason, 'intenção explícita de compra')
  assert.equal(detectHandoffSignal('pode mandar o contrato?')?.reason, 'intenção explícita de compra')
  assert.equal(detectHandoffSignal('quero falar com o responsável')?.reason, 'intenção explícita de compra')
  assert.equal(detectHandoffSignal('como faço para pagar?')?.reason, 'intenção explícita de compra')
})

test('detectHandoffSignal: ignora ruído sem sinal forte', () => {
  assert.equal(detectHandoffSignal('bom dia'), null)
  assert.equal(detectHandoffSignal('tá caro'), null)
  assert.equal(detectHandoffSignal('tem desconto?'), null)
  assert.equal(detectHandoffSignal('quanto custa?'), null)
  assert.equal(detectHandoffSignal('sem interesse'), null)
  assert.equal(detectHandoffSignal('me manda depois'), null)
  assert.equal(detectHandoffSignal(''), null)
})

// --- updateLeadStatus: PATCH rejeitado NÃO gera histórico falso --------------
// Corresponde ao bug real: o CHECK leads_status_check não aceitava 'ia' nem
// 'necessita_humano'; o PATCH falhava silenciosamente e o histórico era
// gravado mesmo assim (linha falsa de "IA" com o lead ainda em "Enviados").

test('updateLeadStatus: status fora do CHECK => retorna false e NÃO grava histórico', async () => {
  reset()
  const ok = await updateLeadStatus('lead-1', 'ia')
  assert.equal(ok, false)
  assert.equal(store.historyWrites.length, 0, 'não pode gravar histórico sem o status ter mudado')
})

test('updateLeadStatus: status permitido => grava status + histórico', async () => {
  reset()
  const ok = await updateLeadStatus('lead-1', 'responder_depois', 'motivo')
  assert.equal(ok, true)
  assert.equal(store.historyWrites.length, 1)
  assert.equal(store.historyWrites[0].status, 'responder_depois')
  assert.equal(store.historyWrites[0].notes, 'motivo')
})