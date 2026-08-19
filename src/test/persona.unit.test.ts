import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, sanitizeCampaignHandoff, sanitizeCampaignPersona } from '../services/agent.service.js';

test('persona inválida usa somente valores controlados', () => {
  const persona = sanitizeCampaignPersona({
    tone: 'inventado',
    formality: 'formal',
    verbosity: 'detalhada',
    emojis: 'moderado',
    style: 'x'.repeat(500),
  });
  assert.deepEqual(persona, {
    tone: 'consultivo',
    formality: 'formal',
    verbosity: 'detalhada',
    emojis: 'moderado',
    style: 'x'.repeat(240),
  });
});

test('persona é incluída no prompt com regras explícitas', () => {
  const prompt = buildSystemPrompt({
    useReactFallback: false,
    toolNames: [],
    campaignPersona: {
      tone: 'direto',
      formality: 'informal',
      verbosity: 'curta',
      emojis: 'nenhum',
      style: 'perguntas curtas',
    },
  });
  assert.match(prompt, /PERSONA DA CAMPANHA/);
  assert.match(prompt, /Tom: direto/);
  assert.match(prompt, /Emojis: nenhum/);
  assert.match(prompt, /perguntas curtas/);
});

test('persona ausente não cria bloco vazio', () => {
  const prompt = buildSystemPrompt({ useReactFallback: false, toolNames: [] });
  assert.doesNotMatch(prompt, /PERSONA DA CAMPANHA/);
});

test('handoff limita campos e aparece no prompt', () => {
  const handoff = sanitizeCampaignHandoff({ name: 'Wesley', phone: '+5511999999999', instructions: 'Encaminhar após interesse claro' });
  assert.deepEqual(handoff, { name: 'Wesley', phone: '+5511999999999', instructions: 'Encaminhar após interesse claro' });
  const prompt = buildSystemPrompt({ useReactFallback: false, toolNames: [], campaignHandoff: handoff });
  assert.match(prompt, /RESPONSÁVEL PELO FECHAMENTO/);
  assert.match(prompt, /Wesley/);
});
