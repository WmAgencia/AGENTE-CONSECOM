/**
 * Integration tests for the public chat API (POST /api/chat) using real
 * GLM-5.2 via NVIDIA. No mocks: every agent call reaches the live model and
 * demands NVIDIA_API_KEY (already present in the environment).
 *
 * Persistence uses the in-process conversation store (Postgres when
 * DATABASE_URL is set; RAM fallback locally). Both keep conversation 1's
 * context across requests and isolate conversation 2.
 *
 * Run:  npm run test
 */
import { loadDotenvLocalIfPresent } from './load.env.js';
loadDotenvLocalIfPresent();

process.env.AGENT_API_KEY = 'chat-test-key-123';
process.env.ALLOWED_ORIGINS =
  'http://localhost:1234,https://samirarevela.com.br,*.lovable.app';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { ChatResponse } from '../types.js';

const AUTH = { Authorization: 'Bearer chat-test-key-123' };
const GLM_TIMEOUT = 120_000;

let app: FastifyInstance;

before(async () => {
  const { buildApp } = await import('../app.js');
  ({ app } = buildApp());
  await app.ready();
});

after(async () => {
  await app.close();
});

async function chat(
  conversationId: string,
  message: string,
  headers: Record<string, string> = AUTH,
): Promise<{ status: number; body: ChatResponse | { error?: string; message?: string } }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: { 'Content-Type': 'application/json', ...headers },
    payload: { conversationId, message },
  });
  return { status: res.statusCode, body: res.json() as never };
}

// A) Health
test('A) GET /health returns ok', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as { status: string }).status, 'ok');
});

// B) Status
test('B) GET /api/status reports NVIDIA key + model', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/status' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    status: string;
    nvidiaApiKeyConfigured: boolean;
    model: string;
  };
  assert.equal(body.status, 'operational');
  assert.equal(body.nvidiaApiKeyConfigured, true);
  assert.equal(body.model, 'meta/llama-3.1-8b-instruct');
});

// C) Chat (new conversation) + auth enforcement
test('C) /api/chat enforces auth and answers a new conversation', {
  timeout: GLM_TIMEOUT,
}, async () => {
  // Without a key -> 401
  const noAuth = await app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: { 'Content-Type': 'application/json' },
    payload: { conversationId: 'teste-001', message: 'Olá' },
  });
  assert.equal(noAuth.statusCode, 401);

  // Wrong key -> 401
  const badAuth = await app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer wrong-key',
    },
    payload: { conversationId: 'teste-001', message: 'Olá' },
  });
  assert.equal(badAuth.statusCode, 401);

  // Correct key -> 200 with real GLM answer
  const { status, body } = await chat(
    'teste-001',
    'Olá, meu nome é João.',
  );
  assert.equal(status, 200);
  const b = body as ChatResponse;
  assert.equal(b.conversationId, 'teste-001');
  assert.equal(b.model, 'meta/llama-3.1-8b-instruct');
  assert.equal(typeof b.latencyMs, 'number');
  assert.ok(b.response && b.response.trim().length > 0, 'response is empty');
});

// D) Continued conversation: agent must recall the name from C.
test('D) /api/chat recalls context across messages in the same conversation', {
  timeout: GLM_TIMEOUT,
}, async () => {
  const { status, body } = await chat(
    'teste-001',
    'Qual é o meu nome?',
  );
  assert.equal(status, 200);
  const b = body as ChatResponse;
  assert.ok(b.response && b.response.trim().length > 0, 'response is empty');
  assert.match(
    b.response,
    /joão/i,
    'expected the agent to recall the name João from the prior turn',
  );
});

// E) Isolation: a different conversationId must not see teste-001's history.
test('E) /api/chat keeps different conversations isolated', {
  timeout: GLM_TIMEOUT,
}, async () => {
  // teste-002 starts fresh and must NOT know João (from teste-001).
  const { status, body } = await chat(
    'teste-002',
    'Qual é o meu nome? (Não sei ainda.)',
  );
  assert.equal(status, 200);
  const b = body as ChatResponse;
  const lower = b.response.toLowerCase();
  assert.ok(!lower.includes('joão'), 'teste-002 leaked teste-001 context');
});

// CORS behaviour
test('CORS: allowed origin gets header, denied origin is refused on preflight', async () => {
  // Preflight from an allowed origin -> 204 + Access-Control-Allow-Origin.
  const allowedPreflight = await app.inject({
    method: 'OPTIONS',
    url: '/api/chat',
    headers: {
      Origin: 'https://samirarevela.com.br',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(allowedPreflight.statusCode, 204);
  assert.equal(statusCodeString(allowedPreflight.headers['access-control-allow-origin']), 'https://samirarevela.com.br');

  // Preflight from a denied origin -> 403.
  const deniedPreflight = await app.inject({
    method: 'OPTIONS',
    url: '/api/chat',
    headers: {
      Origin: 'https://evil.example.com',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(deniedPreflight.statusCode, 403);
});

// CORS subdomain wildcard (e.g. Lovable preview domains)
test('CORS: subdomain wildcard origin (*.lovable.app) is allowed', async () => {
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/api/chat',
    headers: {
      Origin: 'https://app12345.lovable.app',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(
    statusCodeString(res.headers['access-control-allow-origin']),
    'https://app12345.lovable.app',
  );
});

// CORS: DELETE (desconectar WhatsApp) deve ser permitido no preflight.
test('CORS: DELETE is allowed on preflight (disconnect WhatsApp)', async () => {
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/api/connections/whatsapp',
    headers: {
      Origin: 'https://samirarevela.com.br',
      'Access-Control-Request-Method': 'DELETE',
      'Access-Control-Request-Headers': 'content-type, x-user-id',
    },
  });
  assert.equal(res.statusCode, 204);
  const methods = statusCodeString(res.headers['access-control-allow-methods']);
  assert.ok(
    methods.split(',').map((m) => m.trim()).includes('DELETE'),
    `Access-Control-Allow-Methods deve incluir DELETE; recebido: ${methods}`,
  );
  assert.ok(
    methods.split(',').map((m) => m.trim()).includes('GET'),
    'GET deve permanecer permitido',
  );
  assert.ok(
    methods.split(',').map((m) => m.trim()).includes('POST'),
    'POST deve permanecer permitido',
  );
});

// Directives: the site's rules must reach the model's system prompt.
test('directives: /api/chat applies site rules to the system prompt', {
  timeout: GLM_TIMEOUT,
}, async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: { 'Content-Type': 'application/json', ...AUTH },
    payload: {
      conversationId: 'teste-dir',
      message: 'Ola, me diga OK.',
      directives: 'Sempre finalize qualquer resposta com a palavra BANANA.',
    },
  });
  assert.equal(res.statusCode, 200);
  const b = res.json() as ChatResponse;
  assert.match(b.response, /banana/i);
});

// Test page
test('UI: GET / serves the chat test page', async () => {
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(statusCodeString(res.headers['content-type']), /text\/html/);
  assert.match(res.body as string, /Samira Agent - Chat de Teste/);
});

function statusCodeString(v: string | number | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? '';
  return v === undefined ? '' : String(v);
}
