/**
 * Unit tests for the marketing/prospection tools (no model calls).
 */
import { loadDotenvLocalIfPresent } from './load.env.js';
loadDotenvLocalIfPresent();

process.env.AGENT_API_KEY = 'chat-test-key-123';
process.env.AGENT_ENABLE_TOOLS = 'true';
process.env.AGENT_ALLOWED_PERMS = 'READ,NETWORK,WHATSAPP';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

test('marcar_reuniao succeeds for phone when Supabase unset', async () => {
  resetEnvCache();
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  const { createMarcarReuniaoTool } = await import('../tools/marcar.reuniao.js');
  const tool = createMarcarReuniaoTool();
  const res = await tool.execute(
    { phone: '5511999999999' },
    { conversationId: 't', source: 'internal', deadlineMs: Date.now() + 5000 },
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
    { leadId: 'lead-1', phone: '5511999999999' },
    { conversationId: 't', source: 'internal', deadlineMs: Date.now() + 5000 },
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

after(async () => {
  // no-op; app already closed
});