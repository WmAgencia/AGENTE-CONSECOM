import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDotenvLocalIfPresent } from './load.env.js';
import { buildApp } from '../app.js';

loadDotenvLocalIfPresent();

const EXT_KEY = 'consecom-extension-v1';
const OWNER = '9a6d110f-9a7b-4b69-9cd0-2d17baafef50';

test('import-leads aceita leads sem place_id (prospector global)', async () => {
  const { app } = buildApp();
  // Número dinâmico para garantir um telefone novo a cada run.
  const suffix = String(Date.now()).slice(-4);
  const phone = `(15) 99${suffix}-${suffix}1`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/extension/import-leads',
    headers: { 'x-extension-key': EXT_KEY },
    payload: {
      ownerUserId: OWNER,
      source: 'url_prospecting',
      sourceDetail: `https://example.com.br/contatos?utm=extensaoglobal-test-${suffix}`,
      tags: ['url_prospecting', 'extensao_global'],
      leads: [
        { name: 'Global Scanner Teste', phone },
        { name: 'Duplicado Leva', phone },
      ],
    },
  });
  const body = res.json();
  console.log('STATUS', res.statusCode);
  console.log('BODY', JSON.stringify(body));
  assert.equal(res.statusCode, 200);
  const summary = body.summary ?? {};
  // A dedup em leva remove o segundo antes de contabilizar `duplicates`.
  assert.equal(summary.created, 1);
  await app.close();
});

test('import-leads dedup contra banco por phone_normalized (modo global)', async () => {
  const { app } = buildApp();
  const suffix = String(Date.now()).slice(-4);
  const phone = `(11) 97${suffix}-${suffix}2`;
  const payload = {
    ownerUserId: OWNER,
    source: 'url_prospecting',
    sourceDetail: `https://dup.com.br/${suffix}`,
    tags: ['url_prospecting'],
    leads: [{ name: 'Dedup Global A', phone }],
  };
  const r1 = await app.inject({
    method: 'POST',
    url: '/api/extension/import-leads',
    headers: { 'x-extension-key': EXT_KEY },
    payload,
  });
  const r2 = await app.inject({
    method: 'POST',
    url: '/api/extension/import-leads',
    headers: { 'x-extension-key': EXT_KEY },
    payload,
  });
  const b1 = r1.json();
  const b2 = r2.json();
  console.log('R1', JSON.stringify(b1.summary));
  console.log('R2', JSON.stringify(b2.summary));
  assert.equal(r1.statusCode, 200);
  assert.equal(r2.statusCode, 200);
  assert.equal(b1.summary.created, 1);
  // Segunda importação do mesmo telefone → não cria duplicado.
  assert.equal(b2.summary.created, 0);
  await app.close();
});

test('import-leads rejeita leads sem ownerUserId', async () => {
  const { app } = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/extension/import-leads',
    headers: { 'x-extension-key': EXT_KEY },
    payload: { leads: [{ name: 'X', phone: '(15) 99999-1234' }] },
  });
  assert.equal(res.statusCode, 400);
  await app.close();
});