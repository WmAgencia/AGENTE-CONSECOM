/**
 * Unit tests for the marketing/prospection tools (no model calls).
 */
import { loadDotenvLocalIfPresent } from './load.env.js';
loadDotenvLocalIfPresent();

process.env.AGENT_API_KEY = 'chat-test-key-123';
process.env.AGENT_ENABLE_TOOLS = 'true';
process.env.AGENT_ALLOWED_PERMS = 'READ,NETWORK,WHATSAPP';
process.env.AGENT_ALLOWED_TOOLS = '';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resetEnvCache } from '../config/env.js';

before(async () => {
  const { buildApp } = await import('../app.js');
  const { app } = buildApp();
  await app.ready();
  // Build the registry through the app so tools are registered.
  const { getDefaultRegistry } = await import('../tools/registry.js');
  const reg = getDefaultRegistry();
  console.log('registered:', reg.list().map((t) => t.definition.name).join(', '));
  await app.close();
});

test('marcar_reuniao is registered', async () => {
  const { getDefaultRegistry } = await import('../tools/registry.js');
  const reg = getDefaultRegistry();
  assert.ok(reg.get('marcar_reuniao'), 'marcar_reuniao should be registered');
});

const ACCEPTED_HISTORY = [
  { role: 'user' as const, content: 'preciso organizar isso' },
  { role: 'assistant' as const, content: 'Podemos marcar uma reunião. Hoje às 14h ou amanhã às 10h?' },
  { role: 'user' as const, content: 'amanhã às 10h está ótimo, pode marcar' },
];

test('marcar_reuniao rejects when no leadId or phone', async () => {
  resetEnvCache();
  const { createMarcarReuniaoTool } = await import('../tools/marcar.reuniao.js');
  const tool = createMarcarReuniaoTool();
  const res = await tool.execute(
    {},
    { conversationId: 't', source: 'internal', deadlineMs: Date.now() + 5000 },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_args');
});

test('marcar_reuniao blocks an invented meeting without lead acceptance', async () => {
  resetEnvCache();
  const { createMarcarReuniaoTool } = await import('../tools/marcar.reuniao.js');
  const tool = createMarcarReuniaoTool();
  // Lead never agreed (the "hallucinated meeting" scenario).
  const res = await tool.execute(
    { phone: '5511999999999', meetingAt: 'amanhã às 10h' },
    {
      conversationId: 't',
      source: 'internal',
      deadlineMs: Date.now() + 5000,
      history: [
        { role: 'user', content: 'Eu não penso em melhorar o site' },
        { role: 'assistant', content: 'Reunião confirmada para amanhã às 10h' },
      ],
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_args');
});

test('marcar_reuniao accepts when the lead explicitly chose date and time', async () => {
  resetEnvCache();
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  const { createMarcarReuniaoTool } = await import('../tools/marcar.reuniao.js');
  const tool = createMarcarReuniaoTool();
  const res = await tool.execute(
    { phone: '5511999999999', meetingAt: 'amanhã às 10h' },
    {
      conversationId: 't',
      source: 'internal',
      deadlineMs: Date.now() + 5000,
      history: ACCEPTED_HISTORY,
    },
  );
  assert.equal(res.ok, true);
});

test('marcar_reuniao returns io_error when Supabase fails', async () => {
  resetEnvCache();
  process.env.SUPABASE_URL = 'https://invalid.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  process.env.AGENT_ADMIN_GROUP_JID = '';
  const { createMarcarReuniaoTool } = await import('../tools/marcar.reuniao.js');
  const tool = createMarcarReuniaoTool();
  const res = await tool.execute(
    { leadId: 'lead-1', phone: '5511999999999', meetingAt: 'amanhã às 10h' },
    {
      conversationId: 't',
      source: 'internal',
      deadlineMs: Date.now() + 5000,
      history: ACCEPTED_HISTORY,
    },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'io_error');
});

test('notify_admin_group requires a message', async () => {
  const { createNotifyAdminGroupTool } = await import('../tools/notify.admin.js');
  const tool = createNotifyAdminGroupTool();
  const res = await tool.execute({}, {
    conversationId: 't',
    source: 'internal',
    deadlineMs: Date.now() + 5000,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_args');
});

test('notify_admin_group returns tool_disabled when JID is unset', async () => {
  resetEnvCache();
  process.env.AGENT_ADMIN_GROUP_JID = '';
  const { createNotifyAdminGroupTool } = await import('../tools/notify.admin.js');
  const tool = createNotifyAdminGroupTool();
  const res = await tool.execute({ message: 'alguem esperando' }, {
    conversationId: 't',
    source: 'internal',
    deadlineMs: Date.now() + 5000,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'tool_disabled');
});

test('enviar_midia_kb is registered', async () => {
  const { getDefaultRegistry } = await import('../tools/registry.js');
  const reg = getDefaultRegistry();
  assert.ok(reg.get('enviar_midia_kb'), 'enviar_midia_kb should be registered');
});

test('enviar_midia_kb requires a url', async () => {
  resetEnvCache();
  const { createSendMediaTool } = await import('../tools/send.media.js');
  const tool = createSendMediaTool();
  const res = await tool.execute({}, {
    conversationId: 't',
    source: 'whatsapp',
    deadlineMs: Date.now() + 5000,
    leadPhone: '5511999999999',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_args');
});

test('enviar_midia_kb is disabled outside whatsapp', async () => {
  resetEnvCache();
  const { createSendMediaTool } = await import('../tools/send.media.js');
  const tool = createSendMediaTool();
  const res = await tool.execute(
    { url: 'https://unit.supabase.co/storage/v1/object/public/consecom-media/audio/demo.mp3' },
    { conversationId: 't', source: 'internal', deadlineMs: Date.now() + 5000, leadPhone: '5511999999999' },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'tool_disabled');
});

test('enviar_midia_kb requires leadPhone', async () => {
  resetEnvCache();
  const { createSendMediaTool } = await import('../tools/send.media.js');
  const tool = createSendMediaTool();
  const res = await tool.execute(
    { url: 'https://unit.supabase.co/storage/v1/object/public/consecom-media/audio/demo.mp3' },
    { conversationId: 't', source: 'whatsapp', deadlineMs: Date.now() + 5000 },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_args');
});

test('enviar_midia_kb rejects arbitrary external urls', async () => {
  resetEnvCache();
  process.env.SUPABASE_URL = 'https://unit.supabase.co';
  const { createSendMediaTool } = await import('../tools/send.media.js');
  const tool = createSendMediaTool();
  const res = await tool.execute(
    { url: 'https://evil.example.com/x.mp4' },
    { conversationId: 't', source: 'whatsapp', deadlineMs: Date.now() + 5000, leadPhone: '5511999999999' },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_args');
});

test('enviar_midia_kb sends a KB media and reports ok', async () => {
  resetEnvCache();
  process.env.SUPABASE_URL = 'https://unit.supabase.co';
  process.env.EVOLUTION_SENDTEXT_MAX_RETRIES = '1';
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: { id: 'msg-1' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  process.env.EVOLUTION_API_URL = `http://127.0.0.1:${port}`;
  process.env.EVOLUTION_API_KEY = 'test-key';
  process.env.EVOLUTION_INSTANCE_NAME = 'test-instance';
  resetEnvCache();
  const { createSendMediaTool } = await import('../tools/send.media.js');
  const tool = createSendMediaTool();
  const res = await tool.execute(
    { url: 'https://unit.supabase.co/storage/v1/object/public/consecom-media/audio/demo.mp3', caption: 'Segue o áudio' },
    { conversationId: 't', source: 'whatsapp', deadlineMs: Date.now() + 5000, leadPhone: '5511999999999' },
  );
  assert.equal(res.ok, true);
  server.close();
});

test('enviar_midia_kb returns io_error when Evolution fails', async () => {
  resetEnvCache();
  process.env.SUPABASE_URL = 'https://unit.supabase.co';
  process.env.EVOLUTION_SENDTEXT_MAX_RETRIES = '1';
  const server = createServer((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'boom' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  process.env.EVOLUTION_API_URL = `http://127.0.0.1:${port}`;
  process.env.EVOLUTION_API_KEY = 'test-key';
  process.env.EVOLUTION_INSTANCE_NAME = 'test-instance';
  resetEnvCache();
  const { createSendMediaTool } = await import('../tools/send.media.js');
  const tool = createSendMediaTool();
  const res = await tool.execute(
    { url: 'https://unit.supabase.co/storage/v1/object/public/consecom-media/video/demo.mp4' },
    { conversationId: 't', source: 'whatsapp', deadlineMs: Date.now() + 5000, leadPhone: '5511999999999' },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'io_error');
  server.close();
});

after(async () => {
  // no-op; app already closed
});