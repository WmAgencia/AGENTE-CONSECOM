/**
 * ROTAS DA IA PESSOAL (Assistente Pessoal da VYNTRA).
 *
 * Endpoints separados do painel da Central da IA (/api/ai/*) porque este é um
 * agente DISTINTO do agente comercial de atendimento:
 *   - GET  /api/personal/status -> capacidade (modelo, ferramentas, config)
 *   - POST /api/personal/chat   -> chat real do Assistente Pessoal
 *   - POST /api/personal/reset  -> apaga a memória da conversa pessoal
 *
 * Auth: `Authorization: Bearer <SUPABASE_ACCESS_TOKEN>` verificado contra
 * `{SUPABASE_URL}/auth/v1/user`. Todas as operações são escopadas por
 * `owner_user_id` = id do usuário autenticado (multi-tenancy).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getEnv, getSupabaseProspeccaoConfig, hasNvidiaApiKey } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { extractBearerToken } from '../utils/auth.js';
import { getConversationStore, turnsToHistory } from '../services/conversation.store.js';
import { runPersonalAgent, PERSONAL_TOOLS } from '../services/personal.agent.js';
import {
  listOwnMeetingsJson,
  searchOwnLeadsJson,
  reserveOwnMeeting,
  rescheduleOwnMeeting,
  cancelOwnMeeting,
  realizeOwnMeeting,
} from '../services/personal.agent.js';

const PROVIDER = 'NVIDIA NIM';

const chatSchema = z.object({
  message: z.string().min(1).max(8000),
  conversationId: z.string().min(1).max(200).optional(),
});

const reserveSchema = z.object({
  leadId: z.string().min(1).max(100),
  startIso: z.string().min(1).max(100),
  durationMin: z.number().int().positive().max(1440).optional(),
});

const cancelSchema = z.object({
  leadId: z.string().min(1).max(100),
  motive: z.string().max(500).optional(),
});

async function resolveSupabaseUser(
  token: string | undefined,
): Promise<{ id: string } | null> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !token) return null;
  try {
    const res = await fetch(`${cfg.url}/auth/v1/user`, {
      headers: {
        apikey: cfg.serviceRoleKey,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === 'string' && body.id.length > 0
      ? { id: body.id }
      : null;
  } catch {
    return null;
  }
}

export function registerPersonalRoutes(app: FastifyInstance): void {
  const log = getLogger();

  app.get('/api/personal/status', async (req, reply) => {
    const token = extractBearerToken(
      typeof req.headers['authorization'] === 'string'
        ? req.headers['authorization']
        : undefined,
    );
    const user = await resolveSupabaseUser(token);
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }
    const env = getEnv();
    return reply.send({
      configured: hasNvidiaApiKey(),
      provider: PROVIDER,
      model: env.AGENT_MODEL,
      tools: PERSONAL_TOOLS.map((t) => ({ name: t.name, description: t.description })),
      timestamp: new Date().toISOString(),
    });
  });

  app.post('/api/personal/chat', async (req, reply) => {
    const token = extractBearerToken(
      typeof req.headers['authorization'] === 'string'
        ? req.headers['authorization']
        : undefined,
    );
    const user = await resolveSupabaseUser(token);
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }

    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        statusCode: 400,
      });
    }

    const store = getConversationStore();
    // Namespace próprio (personal:<user>) — NÃO compartilha memória com o
    // agente comercial (panel:<user> / whatsapp:*).
    const conversationId = parsed.data.conversationId ?? `personal:${user.id}`;
    const history = turnsToHistory(await store.get(conversationId));

    try {
      const result = await runPersonalAgent({
        task: parsed.data.message,
        conversationId,
        userId: user.id,
        history,
      });

      await store.appendUser(conversationId, parsed.data.message);
      await store.appendAssistant(conversationId, result.result);

      return reply.send({
        conversationId,
        response: result.result,
        model: result.model,
        provider: PROVIDER,
        latencyMs: result.latencyMs,
        personal: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Personal assistant failed';
      log.error({ errMessage: message }, 'personal: chat route error');
      return reply.status(502).send({
        error: 'personal_ai_error',
        message,
        statusCode: 502,
      });
    }
  });

  app.post('/api/personal/reset', async (req, reply) => {
    const token = extractBearerToken(
      typeof req.headers['authorization'] === 'string'
        ? req.headers['authorization']
        : undefined,
    );
    const user = await resolveSupabaseUser(token);
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }
    const conversationId = `personal:${user.id}`;
    await getConversationStore().clear(conversationId);
    return reply.send({ ok: true, message: 'Memória do Assistente Pessoal apagada.' });
  });

  // ---------------------------------------------------------------------------
  // Ações reais do Assistente Pessoal (mesmo escopo owner_user_id).
  // Usadas pela UI mobile (MeetingsScreen) e qualquer cliente autenticado.
  // ---------------------------------------------------------------------------

  app.get('/api/personal/meetings', async (req, reply) => {
    const token = extractBearerToken(
      typeof req.headers['authorization'] === 'string'
        ? req.headers['authorization']
        : undefined,
    );
    const user = await resolveSupabaseUser(token);
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }
    const meetings = await listOwnMeetingsJson(user.id);
    return reply.send({ meetings });
  });

  app.get('/api/personal/leads', async (req, reply) => {
    const token = extractBearerToken(
      typeof req.headers['authorization'] === 'string'
        ? req.headers['authorization']
        : undefined,
    );
    const user = await resolveSupabaseUser(token);
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }
    const q = String((req.query as Record<string, unknown> | undefined)?.q ?? '');
    if (!q.trim()) {
      return reply.status(400).send({ error: 'validation_error', message: 'Informe ?q=...', statusCode: 400 });
    }
    const leads = await searchOwnLeadsJson(user.id, q);
    return reply.send({ leads });
  });

  app.post('/api/personal/meetings/reserve', async (req, reply) => {
    const token = extractBearerToken(
      typeof req.headers['authorization'] === 'string'
        ? req.headers['authorization']
        : undefined,
    );
    const user = await resolveSupabaseUser(token);
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }
    const parsed = reserveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        statusCode: 400,
      });
    }
    const result = await reserveOwnMeeting(
      user.id,
      parsed.data.leadId,
      parsed.data.startIso,
      parsed.data.durationMin,
    );
    return result.ok
      ? reply.send({ ok: true, message: result.message ?? 'Reunião marcada.' })
      : reply.status(409).send({ ok: false, message: result.message ?? 'Não foi possível marcar.', suggestions: result.suggestions ?? [], statusCode: 409 });
  });

  app.post('/api/personal/meetings/reschedule', async (req, reply) => {
    const token = extractBearerToken(
      typeof req.headers['authorization'] === 'string'
        ? req.headers['authorization']
        : undefined,
    );
    const user = await resolveSupabaseUser(token);
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }
    const parsed = reserveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        statusCode: 400,
      });
    }
    const result = await rescheduleOwnMeeting(user.id, parsed.data.leadId, parsed.data.startIso);
    return result.ok
      ? reply.send({ ok: true, message: result.message ?? 'Reunião reagendada.' })
      : reply.status(409).send({ ok: false, message: result.message ?? 'Não foi possível reagendar.', suggestions: result.suggestions ?? [], statusCode: 409 });
  });

  app.post('/api/personal/meetings/cancel', async (req, reply) => {
    const token = extractBearerToken(
      typeof req.headers['authorization'] === 'string'
        ? req.headers['authorization']
        : undefined,
    );
    const user = await resolveSupabaseUser(token);
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }
    const parsed = cancelSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        statusCode: 400,
      });
    }
    const result = await cancelOwnMeeting(user.id, parsed.data.leadId, parsed.data.motive);
    return result.ok
      ? reply.send({ ok: true, message: result.message ?? 'Reunião cancelada.' })
      : reply.status(409).send({ ok: false, message: result.message ?? 'Não foi possível cancelar.', statusCode: 409 });
  });

  app.post('/api/personal/meetings/realize', async (req, reply) => {
    const token = extractBearerToken(
      typeof req.headers['authorization'] === 'string'
        ? req.headers['authorization']
        : undefined,
    );
    const user = await resolveSupabaseUser(token);
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }
    const parsed = cancelSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        statusCode: 400,
      });
    }
    const result = await realizeOwnMeeting(user.id, parsed.data.leadId);
    return result.ok
      ? reply.send({ ok: true, message: result.message ?? 'Reunião marcada como realizada.' })
      : reply.status(409).send({ ok: false, message: result.message ?? 'Não foi possível concluir.', statusCode: 409 });
  });

  log.info('personal: routes registered');
}