import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  agentRequestSchema,
  chatRequestSchema,
  type AgentLoopResponse,
  type ChatResponse,
} from '../types.js';
import { runAgentLoop } from '../services/agent.service.js';
import { getLogger } from '../utils/logger.js';
import { getAgentApiKey } from '../config/env.js';
import { safeEqual, extractBearerToken } from '../utils/auth.js';
import {
  getConversationStore,
  turnsToHistory,
} from '../services/conversation.store.js';

/**
 * PreHandler that enforces the AGENT_API_KEY Bearer token on /api/chat.
 * On failure it sends the error reply and returns it (short-circuiting the
 * handler). On success it returns undefined so Fastify proceeds.
 */
async function authenticateApiKey(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  const expected = getAgentApiKey();
  if (!expected) {
    return reply.status(503).send({
      error: 'server_misconfigured',
      message: 'AGENT_API_KEY not configured on the server',
      statusCode: 503,
    });
  }
  const authHeader = req.headers['authorization'];
  const token = extractBearerToken(
    typeof authHeader === 'string' ? authHeader : undefined,
  );
  if (!token || !safeEqual(token, expected)) {
    return reply.status(401).send({
      error: 'unauthorized',
      message: 'Missing or invalid API key (Authorization: Bearer <AGENT_API_KEY>)',
      statusCode: 401,
    });
  }
  return undefined;
}

export function registerAgentRoutes(app: FastifyInstance): void {
  // === Legacy single-shot endpoint (backwards-compatible) ===
  // Accepts { task, conversationId? }. Returns AgentLoopResponse with
  // diagnostics added. ConversationId, when present, engages the in-RAM
  // memory store so multi-turn conversations work.
  app.post('/api/agent', async (req, reply) => {
    const log = getLogger();
    const parseResult = agentRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      const message = parseResult.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      log.warn({ message }, 'agent: validation rejected');
      return reply.status(400).send({
        error: 'validation_error',
        message,
        statusCode: 400,
      });
    }

    const { task, conversationId } = parseResult.data;
    const store = getConversationStore();
    const history = conversationId ? turnsToHistory(await store.get(conversationId)) : [];

    try {
      const response = await runAgentLoop({
        task,
        conversationId,
        source: 'http',
        history,
      });

      if (conversationId) {
        await store.appendUser(conversationId, task);
        await store.appendAssistant(conversationId, response.result);
      }

      const out: AgentLoopResponse = {
        ...response,
        conversationId,
      };
      return reply.status(200).send(out);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Agent execution failed';
      log.error({ errMessage: message }, 'agent: route handler error');
      return reply.status(502).send({
        error: 'agent_error',
        message,
        statusCode: 502,
      });
    }
  });

  // === Limpar histórico de uma conversa (reseta contexto poluído) ===
  // Protected by AGENT_API_KEY. Accepts { conversationId } and returns
  // { cleared: true } after removing the conversation + its turns.
  app.post(
    '/api/chat/clear',
    { preHandler: [authenticateApiKey] },
    async (req, reply) => {
      const body = req.body as { conversationId?: unknown } | null;
      const conversationId =
        body && typeof body.conversationId === 'string' ? body.conversationId : null;
      if (!conversationId) {
        return reply.status(400).send({
          error: 'validation_error',
          message: 'conversationId is required',
          statusCode: 400,
        });
      }
      const store = getConversationStore();
      const cleared = await store.clear(conversationId);
      const log = getLogger();
      log.info({ conversationId, cleared }, 'agent: conversation cleared');
      return reply.status(200).send({ cleared, conversationId });
    },
  );

  // === Site-facing endpoint (Samira Revela) ===
  // Protected by AGENT_API_KEY. Requires { conversationId, message } and
  // returns the minimal { conversationId, response, model, latencyMs }.
  app.post(
    '/api/chat',
    { preHandler: [authenticateApiKey] },
    async (req, reply) => {      const log = getLogger();
      const parseResult = chatRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        const message = parseResult.error.issues
          .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
          .join('; ');
        log.warn({ message }, 'chat: validation rejected');
        return reply.status(400).send({
          error: 'validation_error',
          message,
          statusCode: 400,
        });
      }

      const { message, conversationId, directives } = parseResult.data;
      const store = getConversationStore();
      // Same conversationId -> same persisted history. Different ids never
      // share context (enforced by the store + history fetch scoping).
      const history = turnsToHistory(await store.get(conversationId));

      try {
        const response = await runAgentLoop({
          task: message,
          conversationId,
          source: 'http',
          history,
          directives,
        });

        await store.appendUser(conversationId, message);
        await store.appendAssistant(conversationId, response.result);

        const out: ChatResponse = {
          conversationId,
          response: response.result,
          model: response.model,
          latencyMs: response.latencyMs,
        };
        return reply.status(200).send(out);
      } catch (err) {
        const messageErr =
          err instanceof Error ? err.message : 'Agent execution failed';
        log.error({ errMessage: messageErr }, 'chat: route handler error');
        return reply.status(502).send({
          error: 'agent_error',
          message: messageErr,
          statusCode: 502,
        });
      }
    },
  );
}
