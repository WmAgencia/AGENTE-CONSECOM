/**
 * Testes FUNCIONAIS do fluxo comercial do Modo Inteligente (modelo NVIDIA REAL).
 *
 * Diferente do intelligent.mode.test.ts (foco em intenção/Regra 5/identidade),
 * este arquivo prova o COMPORTAMENTO COMERCIAL exigido na especificação:
 *
 *   - a Base de Conhecimento / README REALMENTE influencia o agente (troca a
 *     regra do README => muda a resposta do modelo);
 *   - preço documentado é respondido; preço ausente NÃO é inventado e é
 *     encaminhado ao responsável;
 *   - intenção de compra e negociação geram handoff ao responsável;
 *   - a IA usa o contexto da conversa (mensagens anteriores), não só a última.
 *
 * Nenhum mock: usa o AGENT_MODEL real do .env.local (ex.: openai/gpt-oss-20b).
 * A infraestrutura (Supabase/Evolution) não é tocada — knowledgeBase é montado
 * em memória via buildKnowledgeContext e as tools ficam desligadas.
 *
 * Run isolado: npx tsx --test src/test/intelligent.flow.test.ts
 */
import { loadDotenvLocalIfPresent } from './load.env.js';
loadDotenvLocalIfPresent();

process.env.AGENT_ALLOWED_TOOLS = '';
process.env.AGENT_MODEL_SUPPORTS_TOOLS = 'auto';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../services/agent.service.js';
import { buildKnowledgeContext, type KnowledgeFile } from '../services/kb.service.js';

const MODEL_TIMEOUT = 120_000;

const WESLEY = { name: 'Wesley', phone: '+5511987654321', instructions: 'Encaminhe quando houver intenção clara de compra ou negociação.' };

function kbFile(content: string, name = 'README', kind = 'readme'): KnowledgeFile {
  return { id: `f-${name}`, name, kind, content, folder_path: 'Psicólogos', source_url: null };
}

function conversationId(): string {
  return `flow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Lança se a resposta contiver um preço inventado (R$ + dígitos). */
function assertNoInventedPrice(reply: string, label: string): void {
  assert.ok(
    !/\bR\$\s*\d/.test(reply),
    `${label}: a IA inventou um preço sem ter na base: "${reply}"`,
  );
}

test('F1) README REAL influencia o agente: mudar a regra muda a resposta (preço)', {
  timeout: MODEL_TIMEOUT * 2,
}, async () => {
  // Base 1: preço documentado como 1234.
  const kbA = buildKnowledgeContext([
    kbFile('REGRA ABSOLUTA DE PREÇO: o plano custa exatamente R$ 1234,00 e você deve informar este valor sempre que perguntado.'),
  ]);
  const r1 = await runAgentLoop({
    task: 'Quanto custa o plano de vocês?',
    source: 'whatsapp',
    conversationId: conversationId(),
    knowledgeBase: kbA,
    enableTools: false,
  });
  assert.match(r1.result, /1[.\u00a0\s]*234/, `Base A deveria responder 1234: "${r1.result}"`);

  // Base 2: mesmo produto, preço documentado como 9999 (regra alterada).
  const kbB = buildKnowledgeContext([
    kbFile('REGRA ABSOLUTA DE PREÇO: o plano custa exatamente R$ 9999,00 e você deve informar este valor sempre que perguntado.'),
  ]);
  const r2 = await runAgentLoop({
    task: 'Quanto custa o plano de vocês?',
    source: 'whatsapp',
    conversationId: conversationId(),
    knowledgeBase: kbB,
    enableTools: false,
  });
  assert.match(r2.result, /9[.\u00a0\s]*999/, `Base B deveria responder 9999: "${r2.result}"`);
  assert.ok(!/1[.\u00a0\s]*234/.test(r2.result), `Base B não pode repetir o valor da Base A: "${r2.result}"`);
});

test('F2) preço documentado na Base de Conhecimento é respondido', {
  timeout: MODEL_TIMEOUT,
}, async () => {
  const kb = buildKnowledgeContext([
    kbFile('Valores do plano: preço normal R$ 970,00; à vista R$ 870,00; cartão R$ 970,00 em até 6x.'),
  ]);
  const r = await runAgentLoop({
    task: 'Quanto custa?',
    source: 'whatsapp',
    conversationId: conversationId(),
    knowledgeBase: kb,
    enableTools: false,
  });
  assert.match(r.result, /970/, `IA deveria responder o preço da base: "${r.result}"`);
});

test('F3) informação desconhecida: NÃO inventa e encaminha ao responsável', {
  timeout: MODEL_TIMEOUT,
}, async () => {
  // Base SEM preço — a IA não tem como saber o valor.
  const kb = buildKnowledgeContext([
    kbFile('Aqui descrevemos os benefícios do serviço. Nenhuma tabela de preços foi divulgada ainda.'),
  ]);
  const r = await runAgentLoop({
    task: 'Quanto custa o plano?',
    source: 'whatsapp',
    conversationId: conversationId(),
    knowledgeBase: kb,
    campaignHandoff: WESLEY,
    enableTools: false,
  });
  assertNoInventedPrice(r.result, 'F3');
  assert.ok(
    /Wesley|confirmar|confirmo|respons[áa]vel/i.test(r.result),
    `IA deveria dizer que vai confirmar / encaminhar ao Wesley: "${r.result}"`,
  );
});

test('F4) intenção de compra => handoff ao responsável da Base', {
  timeout: MODEL_TIMEOUT,
}, async () => {
  const kb = buildKnowledgeContext([
    kbFile('Somos uma agência para psicólogos: site profissional, gestão de pacientes, agenda, financeiro e acompanhamento pelo celular.'),
  ]);
  const r = await runAgentLoop({
    task: 'Quero fechar, pode mandar o contrato?',
    source: 'whatsapp',
    conversationId: conversationId(),
    knowledgeBase: kb,
    campaignHandoff: WESLEY,
    enableTools: false,
  });
  assert.match(r.result, /Wesley/, `IA deveria encaminhar ao Wesley: "${r.result}"`);
});

test('F5) negociação ("tem desconto?") => handoff, sem inventar condição', {
  timeout: MODEL_TIMEOUT,
}, async () => {
  const kb = buildKnowledgeContext([
    kbFile('Preço normal R$ 970,00 à vista R$ 870,00. Condições especiais/desconto somente o responsável autoriza.'),
  ]);
  const r = await runAgentLoop({
    task: 'Faz um desconto pra mim?',
    source: 'whatsapp',
    conversationId: conversationId(),
    knowledgeBase: kb,
    campaignHandoff: WESLEY,
    enableTools: false,
  });
  assertNoInventedPrice(r.result, 'F5');
  assert.ok(
    /Wesley|respons[áa]vel|condi[çc][ãa]o/i.test(r.result),
    `IA deveria encaminhar a negociação ao responsável: "${r.result}"`,
  );
});

test('F6) contexto: a IA usa mensagens anteriores e não só a última mensagem', {
  timeout: MODEL_TIMEOUT,
}, async () => {
  // A resposta só pode vir do HISTÓRICO: o lead mencionou o sistema atual há
  // duas mensagens; a pergunta atual exige recuperar essa informação.
  const r = await runAgentLoop({
    task: 'E como você controla a agenda e os pacientes hoje?',
    source: 'whatsapp',
    conversationId: conversationId(),
    history: [
      { role: 'user', content: 'Meu consultório é todo no WhatsApp e numa planilha.' },
      { role: 'assistant', content: 'Entendi. E isso dá bastante trabalho, né?' },
    ],
    enableTools: false,
  });
  assert.ok(
    /planilha|WhatsApp|whatsapp/i.test(r.result),
    `A IA deveria usar o histórico (planilha/WhatsApp) em vez de perguntar de novo: "${r.result}"`,
  );
});