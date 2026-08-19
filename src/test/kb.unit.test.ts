import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeContext, type KnowledgeFile } from '../services/kb.service.js';

function file(over: Partial<KnowledgeFile>): KnowledgeFile {
  return {
    id: 'f1',
    name: 'proposta.txt',
    kind: 'texto',
    content: 'Plano Pro: R$ 297/mês.',
    source_url: null,
    folder_path: 'Vendas',
    ...over,
  };
}

test('formata arquivo com caminho e tipo', () => {
  const out = buildKnowledgeContext([file({})]);
  assert.match(out, /\[TEXTO\] Vendas\/proposta\.txt/);
  assert.match(out, /Plano Pro: R\$ 297\/mês\./);
});

test('readme é rotulado como README', () => {
  const out = buildKnowledgeContext([file({ name: 'README.md', kind: 'readme', content: 'Como vender' })]);
  assert.match(out, /\[README\] Vendas\/README\.md/);
});

test('link sem conteúdo usa a URL', () => {
  const out = buildKnowledgeContext([file({ kind: 'link', content: null, source_url: 'https://site.com' })]);
  assert.match(out, /Link: https:\/\/site\.com/);
});

test('vazio retorna string vazia', () => {
  assert.equal(buildKnowledgeContext([]), '');
});

test('respeita o limite de caracteres', () => {
  const a = file({ id: 'a', name: 'a.txt', content: 'A'.repeat(200) });
  const b = file({ id: 'b', name: 'b.txt', content: 'B'.repeat(200) });
  const out = buildKnowledgeContext([a, b], 100);
  assert.ok(out.length <= 100 + 200, 'deve truncar, mantendo apenas o primeiro bloco');
  assert.match(out, /a\.txt/);
  assert.doesNotMatch(out, /b\.txt/);
});

test('arquivo sem conteúdo e sem url marca "(sem conteúdo)"', () => {
  const out = buildKnowledgeContext([file({ content: null, source_url: null })]);
  assert.match(out, /\(sem conteúdo\)/);
});