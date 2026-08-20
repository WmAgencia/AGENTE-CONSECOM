/**
 * Testes FUNCIONAIS do Modo Inteligente (agente de WhatsApp).
 *
 * Usa o modelo NVIDIA REAL (AGENT_MODEL do .env.local, ex.: openai/gpt-oss-20b)
 * — nenhum mock de modelo. A infraestrutura (Supabase/Evolution) não é tocada:
 * o agente roda direto com o registry de tools, como o webhook faz, e os casos
 * de prompt/Regra 5 são validados via buildSystemPrompt (função real).
 *
 * Contrato verificado (espelha o webhook):
 *   1) os 8 casos de intenção + humano são classificados corretamente;
 *   2) o marker <!--INTENT:x--> é emitido pelo modelo nas conversas WhatsApp;
 *   3) Regra 5: quando a conexão É o responsável, o prompt NÃO transfere;
 *   4) transferência: com handoff configurado, o prompt encaminha ao
 *      responsável (e a Regra 5 só desliga isso quando a conexão é o próprio);
 *   5) notificação: notify_admin_group está registrado/executável;
 *   6) identidade por conexão: o prompt apresenta o nome certo por conexão.
 *
 * Run:  npm run test  (ou isolado: npx tsx --test src/test/intelligent.mode.test.ts)
 */
import { loadDotenvLocalIfPresent } from './load.env.js';
loadDotenvLocalIfPresent();

// Todas as tools habilitadas (o .env.local restringe o allowlist de produção).
process.env.AGENT_ALLOWED_TOOLS = '';
process.env.AGENT_MODEL_SUPPORTS_TOOLS = 'auto';

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntentHeuristic, parseIntentMarker, planInbound } from '../services/intent.classifier.js';
import { buildSystemPrompt, runAgentLoop } from '../services/agent.service.js';
import { closerMatchesConnection } from '../routes/webhook.js';
import { getDefaultRegistry, type ToolRegistry } from '../tools/registry.js';
import { buildDefaultRegistry } from '../tools/index.js';
import { resetEnvCache } from '../config/env.js';

const MODEL_TIMEOUT = 120_000;
const IDENT = {
  connection_id: 'conn-1',
  connection_name: 'Ana',
  connection_phone: '5511999990001',
};

before(() => {
  // Habilita as tools com TODAS permitidas para o teste funcional (o webhook
  // em produção usa o allowlist da env). Re-parse do env após a mutação.
  process.env.AGENT_ENABLE_TOOLS = 'true';
  process.env.AGENT_ALLOWED_TOOLS = '';
  resetEnvCache();
  buildDefaultRegistry();
});

function currentRegistry(): ToolRegistry {
  return getDefaultRegistry();
}

// --- 1) 8 casos de intenção (+ humano) com o modelo REAL ---------------------
// Espelha o webhook: intent = marker do modelo ?? heurística, com a regra de
// segurança que deixa heurística ALTA (humano / sem interesse / responder
// depois) sobrescrever um marker contraditório do modelo.
const INTENT_CASES: Array<{ msg: string; expected: string[] }> = [
  // 'interesse' / 'reuniao' / 'informacao' são equivalentes no comportamento:
  // nenhum move o Kanban (o agente apenas continua a conversa). O modelo real
  // oscila entre esses markers para sinais positivos — aceitamos os três.
  { msg: 'Gostei da apresentação, estou interessado no serviço.', expected: ['interesse', 'reuniao', 'informacao'] },
  // 'duvida' e 'informacao' são equivalentes no comportamento (agente responde,
  // sem movimentar o Kanban), então aceitamos ambos conforme o modelo emitir.
  { msg: 'Tenho uma dúvida: vocês têm garantia?', expected: ['duvida', 'informacao'] },
  { msg: 'Me conta mais sobre como funciona o serviço de vocês.', expected: ['informacao', 'duvida'] },
  { msg: 'Quero marcar uma reunião para amanhã.', expected: ['reuniao'] },
  { msg: 'Quanto custa? Pode me mandar o orçamento?', expected: ['orcamento', 'informacao'] },
  { msg: 'Não tenho interesse, obrigado.', expected: ['sem_interesse'] },
  { msg: 'Pode encerrar essa conversa?', expected: ['encerrar'] },
  { msg: 'Não posso responder agora, me manda depois.', expected: ['responder_depois'] },
  { msg: 'Quero atendimento humano, me passa para uma pessoa.', expected: ['humano'] },
];

test('funcional: modelo REAL classifica os 8 casos de intenção + humano', {
  timeout: MODEL_TIMEOUT * 3,
}, async () => {
  let markerCount = 0;
  for (const c of INTENT_CASES) {
    const r = await runAgentLoop({
      task: c.msg,
      source: 'whatsapp',
      conversationId: `intent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      enableTools: true,
    });
    const markerIntent = parseIntentMarker(r.result);
    const heuristic = classifyIntentHeuristic(c.msg);
    const heuristicIntent = heuristic?.intent ?? 'ambiguo';
    let effective = markerIntent ?? heuristicIntent ?? 'ambiguo';
    if (
      heuristic?.confidence === 'high' &&
      (heuristic.intent === 'humano' ||
        heuristic.intent === 'sem_interesse' ||
        heuristic.intent === 'responder_depois')
    ) {
      effective = heuristic.intent;
    }
    if (markerIntent) markerCount++;
    assert.ok(
      c.expected.includes(effective),
      `intenção de "${c.msg.slice(0, 40)}": marker=${markerIntent ?? 'sem marker'} heurística=${heuristicIntent} => ${effective} (esperado ${c.expected.join(' ou ')})`,
    );
    // A resposta NUNCA pode ser um placeholder técnico (bug de content:null).
    assert.ok(
      !r.result.includes('[no content returned by the model]') &&
        !r.result.includes('[agent stopped'),
      `placeholder vazou para o lead em "${c.msg.slice(0, 40)}"`,
    );
  }
  // O marker é o sinal primário: o modelo deve emitir na maioria dos casos.
  assert.ok(markerCount >= 7, `marker emitido só em ${markerCount}/9`);
});

// --- 2) Regra 5: conexão É o responsável => NÃO transfere --------------------
test('Regra 5: conexão responsável => prompt não encaminha para outra pessoa', () => {
  const responsible = buildSystemPrompt({
    useReactFallback: false,
    toolNames: ['finalizar_sem_interesse'],
    connectionIdentity: IDENT,
    campaignHandoff: {
      name: 'Ana',
      phone: '5511999990001',
      instructions: 'Atende você mesmo.',
    },
    connectionIsResponsible: true,
    injectIntentMarker: true,
  });
  assert.match(responsible, /VOCÊ É O RESPONSÁVEL PELO FECHAMENTO/);
  assert.ok(
    !responsible.includes('RESPONSÁVEL PELO FECHAMENTO / HANDOFF'),
    'não deve injetar o bloco de transferência quando a conexão é o responsável',
  );
});

test('Regra 5: conexão diferente => prompt mantém o handoff (transfere)', () => {
  const transfer = buildSystemPrompt({
    useReactFallback: false,
    toolNames: ['finalizar_sem_interesse'],
    connectionIdentity: { ...IDENT, connection_name: 'Ana', connection_phone: '5511999990001' },
    campaignHandoff: {
      name: 'Carlos',
      phone: '5511999990002',
      instructions: 'Encaminhe para o Carlos.',
    },
    connectionIsResponsible: false,
    injectIntentMarker: true,
  });
  assert.match(transfer, /RESPONSÁVEL PELO FECHAMENTO \/ HANDOFF/);
  assert.ok(!transfer.includes('VOCÊ É O RESPONSÁVEL PELO FECHAMENTO'));
});

// --- 3) closerMatchesConnection: matching por telefone e por nome -------------
test('closerMatchesConnection: casa por telefone ou nome, não casa quando diferente', () => {
  const closer = { name: 'Ana', phone: '55 11 99999-0001', instructions: 'x' };
  assert.equal(closerMatchesConnection({ ...IDENT, connection_phone: '5511999990001' }, closer), true, 'telefone com formatação diferente');
  assert.equal(closerMatchesConnection({ ...IDENT, connection_name: 'Ana' }, { ...closer, phone: '' }), true, 'nome igual');
  assert.equal(closerMatchesConnection({ ...IDENT, connection_name: 'Maria', connection_phone: '5511999999999' }, closer), false, 'telefone e nome diferentes');
  // Nome diferente mas MESMO telefone: casa pelo telefone (identidade real).
  assert.equal(closerMatchesConnection({ ...IDENT, connection_name: 'João' }, closer), true, 'telefone casa mesmo com nome diferente');
  assert.equal(closerMatchesConnection(IDENT, { name: '', phone: '', instructions: '' }), false, 'sem responsável configurado');
});

// --- 4) Identidade por conexão (2 conexões, nomes diferentes) -----------------
test('identidade: prompt usa o nome da conexão certa por conversa', () => {
  const a = buildSystemPrompt({
    useReactFallback: false,
    toolNames: [],
    connectionIdentity: { connection_id: 'c1', connection_name: 'Ana', connection_phone: '5511999990001' },
    injectIntentMarker: true,
  });
  const b = buildSystemPrompt({
    useReactFallback: false,
    toolNames: [],
    connectionIdentity: { connection_id: 'c2', connection_name: 'João', connection_phone: '5511999990002' },
    injectIntentMarker: true,
  });
  assert.match(a, /se apresente exatamente como Ana/);
  assert.match(b, /se apresente exatamente como João/);
  assert.ok(!a.includes('João'), 'conexão A não deve citar João');
  assert.ok(!b.includes('Ana'), 'conexão B não deve citar Ana');
});

// --- 4.1) Base de Conhecimento é a fonte prioritária (não o playbook/nicho) ---
test('KB presente: prompt instrui que a Base/README prevalece sobre playbook e nicho', () => {
  const withKb = buildSystemPrompt({
    useReactFallback: false,
    toolNames: [],
    knowledgeBase: '[README] README.md\nEsta campanha vende exclusivamente a solução da Consecom para psicólogos.',
    injectIntentMarker: true,
  });
  assert.match(withKb, /FONTE PRINCIPAL E ÚNICA/);
  assert.match(withKb, /INSTRUÇÃO PRINCIPAL/);
  assert.match(withKb, /nicho\/negócio\/categoria/);
});

test('KB ausente: prompt NÃO instrui prioridade da Base', () => {
  const withoutKb = buildSystemPrompt({
    useReactFallback: false,
    toolNames: [],
    injectIntentMarker: true,
  });
  assert.ok(!withoutKb.includes('FONTE PRINCIPAL E ÚNICA'));
  assert.ok(!withoutKb.includes('BASE DE CONHECIMENTO'));
});

// --- 5) Notificação: notify_admin_group registrado e executável --------------
test('notificação: notify_admin_group está registrado no registry', () => {
  const registry = currentRegistry();
  const def = registry.toOpenAITools().find((t) => t.function?.name === 'notify_admin_group');
  assert.ok(def, 'notify_admin_group deve estar no registry');
});

// --- 6) Plano de ação: intenções mapeiam corretamente no Kanban --------------
test('plano de ação: intenções movem o lead no Kanban (planInbound)', () => {
  assert.equal(planInbound('conversando', 'sem_interesse').nextStatus, 'sem_interesse');
  assert.equal(planInbound('conversando', 'sem_interesse').stopCampaign, true);
  assert.equal(planInbound('conversando', 'humano').stopCampaign, false);
  // 'reuniao' mantém o status: a coluna reuniao_marcada é movida pela TOOL
  // marcar_reuniao, não pelo plano (só rebaixa se já estiver em reunião).
  assert.equal(planInbound('reuniao_marcada', 'reuniao').nextStatus, undefined);
  assert.equal(planInbound('responder_depois', 'responder_depois').nextStatus, 'responder_depois');
});