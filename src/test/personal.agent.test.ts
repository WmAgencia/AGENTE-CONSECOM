import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasExplicitConfirmation,
  fmtDateTimeIso,
  buildPersonalSystemPrompt,
  PERSONAL_TOOLS,
  type PersonalHistoryItem,
} from '../services/personal.agent.js';

function history(...msgs: Array<[string, string]>): PersonalHistoryItem[] {
  return msgs.map(([role, content]) => ({ role: role as 'user' | 'assistant', content }));
}

test('hasExplicitConfirmation: false sem turnos do usuário', () => {
  assert.equal(hasExplicitConfirmation([]), false);
  assert.equal(
    hasExplicitConfirmation([{ role: 'assistant', content: 'Quer cancelar?' }]),
    false,
  );
});

test('hasExplicitConfirmation: false sem confirmação', () => {
  const msgs = history(
    ['assistant', 'Confirma o cancelamento da reunião com João?'],
    ['user', 'ainda não sei'],
  );
  assert.equal(hasExplicitConfirmation(msgs), false);
});

test('hasExplicitConfirmation: true com "pode cancelar"', () => {
  const msgs = history(
    ['assistant', 'Confirma o cancelamento com João?'],
    ['user', 'pode cancelar'],
  );
  assert.equal(hasExplicitConfirmation(msgs), true);
});

test('hasExplicitConfirmation: true com "sim, confirma o cancelamento"', () => {
  const msgs = history(
    ['assistant', 'Confirma?'],
    ['user', 'sim, confirma o cancelamento'],
  );
  assert.equal(hasExplicitConfirmation(msgs), true);
});

test('hasExplicitConfirmation: considera apenas as 2 últimas mensagens do usuário', () => {
  // Confirmação antiga (a 3 mensagens de usuário atrás) não deve "vazar"
  // para a ação atual, que não foi confirmada.
  const msgs = history(
    ['assistant', 'Confirma?'],
    ['user', 'pode cancelar'],
    ['assistant', 'ok. Alguma outra coisa?'],
    ['user', 'qual o status da campanha 99?'],
    ['assistant', 'Está em andamento.'],
    ['user', 'obrigado'],
  );
  assert.equal(hasExplicitConfirmation(msgs), false);
});

test('PERSONAL_TOOLS: nomes únicos e com executor', () => {
  const names = PERSONAL_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'deve haver nomes únicos');
  for (const t of PERSONAL_TOOLS) {
    assert.equal(typeof t.execute, 'function', `${t.name} deve ter executor`);
    assert.ok(t.description.length > 0, `${t.name} deve ter descrição`);
  }
});

test('PERSONAL_TOOLS: contém as ferramentas esperadas (incluindo as destrutivas)', () => {
  const names = new Set(PERSONAL_TOOLS.map((t) => t.name));
  for (const expected of [
    'consultar_agenda',
    'verificar_disponibilidade',
    'buscar_lead',
    'consultar_leads',
    'consultar_campanhas',
    'marcar_reuniao',
    'reagendar_reuniao',
    'cancelar_reuniao',
    'marcar_reuniao_realizada',
    'pausar_campanha',
    'retomar_campanha',
  ]) {
    assert.ok(names.has(expected), `ferramenta ${expected} deve existir`);
  }
});

test('fmtDateTimeIso: formata em fuso São Paulo (UTC-3)', () => {
  // 2026-08-14T17:00:00Z = 14:00 em SP (13/08 seria um dia a menos; 17Z -> 14h mesmo dia).
  assert.equal(fmtDateTimeIso('2026-08-14T17:00:00.000Z'), 'Sexta-feira 14/08 às 14:00');
  // 2026-08-13T23:30:00Z = 20:30 do mesmo dia (13/08) em SP.
  assert.equal(fmtDateTimeIso('2026-08-13T23:30:00.000Z'), 'Quinta-feira 13/08 às 20:30');
});

test('fmtDateTimeIso: valores vazios/inválidos', () => {
  assert.equal(fmtDateTimeIso(null), '');
  assert.equal(fmtDateTimeIso(''), '');
  assert.equal(fmtDateTimeIso('não é data'), '');
});

test('buildPersonalSystemPrompt: dia atual, hora e ferramentas; sem segredos', () => {
  const prompt = buildPersonalSystemPrompt();
  const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  assert.ok(prompt.includes(hoje), `deve conter a data de hoje (${hoje})`);
  assert.ok(prompt.includes('Assistente Pessoal da VYNTRA'));
  assert.ok(prompt.includes(PERSONAL_TOOLS[0].name));
  assert.ok(!/apikey|authorization|nvidia_api|AGENT_API_KEY|Bearer /i.test(prompt), 'não deve conter credenciais');
});