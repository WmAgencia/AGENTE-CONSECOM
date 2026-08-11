import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate } from '../services/template.service.js';

const LEAD = {
  name: 'Studio Bella Estética',
  phone: '(34) 99999-0000',
  category: 'Estética',
  website: 'https://studiobella.com.br',
  address: 'Av. Brasil, 100',
  city: 'Campinas',
  state: 'SP',
  rating: 4.8,
  reviews: 132,
  niche: 'Estética e Beleza',
  instagram: '@studiobella',
};

test('renderTemplate substitui todas as variáveis suportadas', () => {
  const msg = 'Olá, {nome}! Vi a {empresa} em {cidade}-{estado}. ({categoria}) {telefone} {site} {instagram} {avaliacao}/5 com {avaliacoes} avaliações.';
  const out = renderTemplate(msg, LEAD);
  assert.equal(
    out,
    'Olá, Studio Bella Estética! Vi a Studio Bella Estética em Campinas-SP. (Estética) (34) 99999-0000 https://studiobella.com.br @studiobella 4.8/5 com 132 avaliações.',
  );
});

test('renderTemplate mantém compatibilidade com placeholders antigos', () => {
  const out = renderTemplate('Oi {nome_empresa}, seu endereço é {endereco}. Nicho: {nicho}', LEAD);
  assert.equal(out, 'Oi Studio Bella Estética, seu endereço é Av. Brasil, 100. Nicho: Estética e Beleza');
});

test('variável sem valor vira string vazia (nunca undefined/null/literal)', () => {
  const out = renderTemplate('Olá, {nome}! Empresa: {empresa}. Site: {site}. IG: {instagram}', {
    name: 'Maria',
  });
  assert.equal(out, 'Olá, Maria! Empresa: Maria. Site: . IG: ');
  assert.ok(!out.includes('undefined'));
  assert.ok(!out.includes('null'));
  assert.ok(!out.includes('{empresa}'));
  assert.ok(!out.includes('{site}'));
});

test('{empresa} cai para {niche} quando o nome está vazio', () => {
  const out = renderTemplate('Vi a {empresa}', { name: '', niche: 'Mercado Municipal' });
  assert.equal(out, 'Vi a Mercado Municipal');
});

test('variável desconhecida é mantida literal (não explode)', () => {
  const out = renderTemplate('Tenho horário às {horario}', LEAD);
  assert.equal(out, 'Tenho horário às {horario}');
});

test('mensagem vazia ou sem variáveis passa intacta', () => {
  assert.equal(renderTemplate('', LEAD), '');
  assert.equal(renderTemplate('Olá, tudo bem?', LEAD), 'Olá, tudo bem?');
});

test('valor zero (avaliação 0.0) é tratado como ausente para fallback', () => {
  const out = renderTemplate('Nota {avaliacao}', { rating: 0 });
  assert.equal(out, 'Nota ');
});

test('avaliação numérica é stringificada corretamente', () => {
  assert.equal(renderTemplate('{avaliacao}', { rating: 4.9 }), '4.9');
  assert.equal(renderTemplate('{avaliacoes}', { reviews: 12 }), '12');
});
