import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreInboundMessage } from '../services/scoring.js';

test('sem interesse reduz fortemente o score', () => {
  const r = scoreInboundMessage({ currentScore: 60, intent: 'sem_interesse', text: 'Não tenho interesse' });
  assert.equal(r.score, 35);
  assert.ok(r.factors.includes('sem_interesse=-25'));
});

test('interesse sobe o score e registra o motivo', () => {
  const r = scoreInboundMessage({ currentScore: 20, intent: 'interesse', text: 'Quero contratar' });
  assert.equal(r.score, 35);
  assert.ok(r.factors.includes('interesse=+15'));
});

test('reunião sobe bastante o score', () => {
  const r = scoreInboundMessage({ currentScore: 30, intent: 'reuniao', text: 'Pode marcar uma reunião?' });
  assert.equal(r.score, 50);
  assert.ok(r.factors.includes('reuniao=+20'));
});

test('resposta rápida e visualização somam engajamento', () => {
  const r = scoreInboundMessage({ currentScore: 30, intent: 'informacao', text: 'Como funciona?', repliedFast: true, readReceipt: true });
  assert.equal(r.score, 47);
  assert.ok(r.factors.includes('resposta_rapida=+8'));
  assert.ok(r.factors.includes('visualizou=+4'));
});

test('palavras-chave de negócio dão bônus', () => {
  const r = scoreInboundMessage({ currentScore: 30, intent: 'duvida', text: 'Quanto custa o sistema por mês?' });
  assert.equal(r.score, 37);
  assert.ok(r.factors.some((f) => f.startsWith('palavras_chave=')));
});

test('sem histórico: usa base do status', () => {
  const r = scoreInboundMessage({ currentStatus: 'conversando', intent: 'informacao', text: 'me conta mais' });
  assert.equal(r.score, 40);
});

test('nunca ultrapassa 100 nem fica negativo', () => {
  const hi = scoreInboundMessage({ currentScore: 100, intent: 'reuniao', text: 'quero reunião' });
  assert.equal(hi.score, 100);
  const lo = scoreInboundMessage({ currentScore: 2, intent: 'sem_interesse', text: 'não quero' });
  assert.equal(lo.score, 0);
});