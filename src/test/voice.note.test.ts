/**
 * Unit tests for voice note (sendWhatsAppAudio) + fallback para sendMedia.
 * Nenhuma chamada real é feita — servidores mock locais.
 */
import { loadDotenvLocalIfPresent } from './load.env.js';
loadDotenvLocalIfPresent();

process.env.AGENT_ENABLE_TOOLS = 'true';
process.env.AGENT_ALLOWED_PERMS = 'READ,NETWORK,WHATSAPP';
process.env.AGENT_ALLOWED_TOOLS = '';
process.env.EVOLUTION_SENDTEXT_MAX_RETRIES = '1';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resetEnvCache } from '../config/env.js';

/** Sobe um servidor mock que roteia por path com respostas configuráveis. */
async function startMock(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ port: number; close: () => void }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => server.close() };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function setupEnv(port: number): void {
  resetEnvCache();
  process.env.SUPABASE_URL = 'https://unit.supabase.co';
  process.env.EVOLUTION_API_URL = `http://127.0.0.1:${port}`;
  process.env.EVOLUTION_API_KEY = 'test-key';
  process.env.EVOLUTION_INSTANCE_NAME = 'test-instance';
  resetEnvCache();
}

const KB_AUDIO_URL = 'https://unit.supabase.co/storage/v1/object/public/consecom-media/audio/demo.mp3';

test('sendVoiceNote POSTs to /message/sendWhatsAppAudio with number and audio', async () => {
  let seenPath = '';
  let seenBody: unknown = null;
  const mock = await startMock((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seenPath = req.url ?? '';
      seenBody = raw ? JSON.parse(raw) : null;
      json(res, 200, { key: { id: 'voice-1' } });
    });
  });
  setupEnv(mock.port);
  const { sendVoiceNote } = await import('../services/evolution.service.js');
  const result = await sendVoiceNote({ to: '5511999999999@s.whatsapp.net', audio: KB_AUDIO_URL });
  assert.equal(result.ok, true);
  assert.equal(result.messageId, 'voice-1');
  assert.ok(seenPath);
  assert.equal(seenPath, '/message/sendWhatsAppAudio/test-instance');
  const body = seenBody as { number: string; audio: string };
  assert.equal(body.number, '5511999999999');
  assert.equal(body.audio, KB_AUDIO_URL);
  mock.close();
});

test('sendVoiceNote marks routeNotFound on 404', async () => {
  const mock = await startMock((_req, res) => json(res, 404, { error: 'not found' }));
  setupEnv(mock.port);
  const { sendVoiceNote } = await import('../services/evolution.service.js');
  const result = await sendVoiceNote({ to: '5511999999999', audio: KB_AUDIO_URL });
  assert.equal(result.ok, false);
  assert.equal(result.routeNotFound, true);
  assert.equal(result.status, 404);
  mock.close();
});

test('enviar_midia_kb uses voice note and reports ok when sendWhatsAppAudio works', async () => {
  const calls: string[] = [];
  const mock = await startMock((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      calls.push(req.url ?? '');
      json(res, 200, { key: { id: 'voice-ok' } });
    });
  });
  setupEnv(mock.port);
  const { createSendMediaTool } = await import('../tools/send.media.js');
  const tool = createSendMediaTool();
  const res = await tool.execute(
    { url: KB_AUDIO_URL },
    { conversationId: 't', source: 'whatsapp', deadlineMs: Date.now() + 5000, leadPhone: '5511999999999' },
  );
  assert.equal(res.ok, true);
  assert.match(res.output, /mensagem de voz/);
  assert.deepEqual(calls, ['/message/sendWhatsAppAudio/test-instance']);
  mock.close();
});

test('enviar_midia_kb falls back to sendMedia when voice-note route is 404', async () => {
  const calls: string[] = [];
  const mock = await startMock((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      calls.push(req.url ?? '');
      if (req.url?.includes('sendWhatsAppAudio')) json(res, 404, { error: 'route not found' });
      else json(res, 200, { key: { id: 'media-1' } });
    });
  });
  setupEnv(mock.port);
  const { createSendMediaTool } = await import('../tools/send.media.js');
  const tool = createSendMediaTool();
  const res = await tool.execute(
    { url: KB_AUDIO_URL },
    { conversationId: 't', source: 'whatsapp', deadlineMs: Date.now() + 5000, leadPhone: '5511999999999' },
  );
  assert.equal(res.ok, true);
  assert.match(res.output, /sucesso/);
  assert.deepEqual(calls, [
    '/message/sendWhatsAppAudio/test-instance',
    '/message/sendMedia/test-instance',
  ]);
  mock.close();
});

test('enviar_midia_kb reports io_error when voice-note fails without 404 (no double send)', async () => {
  const calls: string[] = [];
  const mock = await startMock((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      calls.push(req.url ?? '');
      json(res, 500, { error: 'boom' });
    });
  });
  setupEnv(mock.port);
  const { createSendMediaTool } = await import('../tools/send.media.js');
  const tool = createSendMediaTool();
  const res = await tool.execute(
    { url: KB_AUDIO_URL },
    { conversationId: 't', source: 'whatsapp', deadlineMs: Date.now() + 5000, leadPhone: '5511999999999' },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'io_error');
  assert.deepEqual(calls, ['/message/sendWhatsAppAudio/test-instance']);
  mock.close();
});

after(async () => {
  // no-op
});