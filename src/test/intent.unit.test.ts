import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIntentHeuristic,
  planInbound,
  parseIntentMarker,
} from '../services/intent.classifier.js';

test('heurística: "Não tenho interesse." => sem_interesse (high)', () => {
  const r = classifyIntentHeuristic('Não tenho interesse.');
  assert.equal(r?.intent, 'sem_interesse');
  assert.equal(r?.confidence, 'high');
});

test('heurística: "Pode falar comigo amanhã." => responder_depois', () => {
  assert.equal(classifyIntentHeuristic('Pode falar comigo amanhã?')?.intent, 'responder_depois');
  assert.equal(classifyIntentHeuristic('Me chama depois, por favor')?.intent, 'responder_depois');
  assert.equal(classifyIntentHeuristic('Amanhã eu te respondo, ok?')?.intent, 'responder_depois');
  assert.equal(classifyIntentHeuristic('Vou ver e falo com você mais tarde')?.intent, 'responder_depois');
});

test('heurística: "Quero falar com uma pessoa." => humano', () => {
  assert.equal(classifyIntentHeuristic('Quero falar com uma pessoa')?.intent, 'humano');
  assert.equal(classifyIntentHeuristic('Pode me passar para um atendente?')?.intent, 'humano');
});

test('heurística: "Quero saber mais." => informacao', () => {
  assert.equal(classifyIntentHeuristic('Quero saber mais')?.intent, 'informacao');
});

test('heurística: "Quero contratar." => interesse', () => {
  assert.equal(classifyIntentHeuristic('Quero contratar')?.intent, 'interesse');
});

test('heurística: "Quanto custa?" => orcamento', () => {
  assert.equal(classifyIntentHeuristic('Quanto custa?')?.intent, 'orcamento');
});

test('recusa parcial com "mas" NÃO vira sem_interesse', () => {
  assert.notEqual(classifyIntentHeuristic('Não tenho interesse em tráfego, mas quero saber mais')?.intent, 'sem_interesse');
});

test('planInbound: sem_interesse move e para a campanha', () => {
  const plan = planInbound('enviado', 'sem_interesse');
  assert.equal(plan.nextStatus, 'sem_interesse');
  assert.equal(plan.stopCampaign, true);
});

test('planInbound: responder_depois move sem parar a campanha', () => {
  const plan = planInbound('conversando', 'responder_depois');
  assert.equal(plan.nextStatus, 'responder_depois');
  assert.equal(plan.stopCampaign, false);
});

test('planInbound: interesse/informacao mantém status', () => {
  assert.equal(planInbound('enviado', 'informacao').nextStatus, undefined);
  assert.equal(planInbound('enviado', 'orcamento').nextStatus, undefined);
});

test('marker: parse mantém whitelist (novos intents não entram no marker)', () => {
  assert.equal(parseIntentMarker('resp <!--INTENT:sem_interesse-->'), 'sem_interesse');
  assert.equal(parseIntentMarker('resp <!--INTENT:responder_depois-->'), null);
  assert.equal(parseIntentMarker('resp <!--INTENT:humano-->'), null);
});