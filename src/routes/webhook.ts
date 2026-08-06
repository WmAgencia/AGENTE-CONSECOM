/**
 * Webhook endpoint for Evolution API (MVP).
 *
 * Flow:
 *   Evolution API --POST /webhook/evolution--> this route
 *     1. validate WEBHOOK_SECRET (header x-webhook-secret or query ?secret=)
 *     2. parse + zod-validate payload (passthrough for forward compat)
 *     3. only accept events in EVOLUTION_WEBHOOK_EVENTS (default: messages.upsert)
 *     4. anti-loop: skip messages with key.fromMe === true
 *     5. extract text; skip if no text (audio/image/etc.)
 *     6. idempotency: skip if message.key.id already processed (LRU, TTL 10min)
 *     7. queue through concurrency semaphore (default 1) to protect NVIDIA API
 *     8. runAgent(text) -> response
 *     9. evolution.sendText({ to, text: response })
 *    10. ack 200 to Evolution immediately (processing happens async)
 *
 * Security:
 *  - Secret compared with constant-time comparison.
 *  - Errors never leak keys or message contents.
 *  - Logging uses only structural metadata (text length, JID masked, message
 *    key id). Full message is redacted by pino (utils/logger.ts).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  evolutionWebhookPayloadSchema,
  extractMessage,
  type WebhookAcknowledgement,
} from '../types/webhook.js';
import { getEnv, getWebhookSecret } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { runAgentLoop } from '../services/agent.service.js';
import { sendText, isEvolutionMockMode } from '../services/evolution.service.js';
import {
  getConversationStore,
  turnsToHistory,
} from '../services/conversation.store.js';

const IDEMPOTENCY_MAX_ENTRIES = 1000;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

class IdempotencyCache {
  private map = new Map<string, number>();
  private readonly max: number;
  private readonly ttlMs: number;

  constructor(max = IDEMPOTENCY_MAX_ENTRIES, ttlMs = IDEMPOTENCY_TTL_MS) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  hasAndMark(key: string): boolean {
    const now = Date.now();
    const seen = this.map.get(key);
    if (seen !== undefined && now - seen < this.ttlMs) {
      return true; // duplicate within TTL
    }
    if (this.map.size >= this.max) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, now);
    return false;
  }
}

class Semaphore {
  private active = 0;
  private readonly max: number;
  private waiters: Array<() => void> = [];

  constructor(max = 1) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active++;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return d === 0;
}

function extractSecret(req: FastifyRequest): string | undefined {
  const h = req.headers as Record<string, string | string[] | undefined>;
  const fromHeader =
    (h['x-webhook-secret'] as string | undefined) ??
    (h['apikey'] as string | undefined);
  if (fromHeader && typeof fromHeader === 'string') return fromHeader;
  const q = (req.query as Record<string, string | undefined> | null)?.secret;
  if (q) return q;
  return undefined;
}

export function registerWebhookRoutes(app: FastifyInstance): void {
  const cache = new IdempotencyCache();
  let semaphore: Semaphore;
  try {
    semaphore = new Semaphore(getEnv().EVOLUTION_AGENT_CONCURRENCY);
  } catch {
    // env not configured yet (e.g. NVIDIA_API_KEY unset during boot);
    // webhook won't function but we shouldn't break server registration.
    semaphore = new Semaphore(1);
  }

  app.post('/webhook/evolution', async (req, reply) => {
    const log = getLogger();

    // 1. Secret validation
    const provided = extractSecret(req);
    const expected = getWebhookSecret();
    if (!expected) {
      log.warn('webhook: received but WEBHOOK_SECRET not configured');
      return reply.status(503).send({
        accepted: false,
        reason: 'server_misconfigured',
        message: 'WEBHOOK_SECRET not configured',
      } satisfies WebhookAcknowledgement & { message: string });
    }
    if (!provided || !safeEqual(provided, expected)) {
      log.warn(
        { hadHeader: Boolean(provided) },
        'webhook: secret validation failed',
      );
      return reply.status(401).send({
        accepted: false,
        reason: 'invalid_secret',
      } satisfies WebhookAcknowledgement);
    }

    // 2. Parse payload
    const parseResult = evolutionWebhookPayloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      log.warn({ msg: 'webhook: payload schema rejected' }, 'webhook: rejected');
      return reply.status(400).send({
        accepted: false,
        reason: 'invalid_payload',
      } satisfies WebhookAcknowledgement);
    }
    const payload = parseResult.data;

    // 3. Event filter
    const allowedEvents = (() => {
      try {
        return getEnv().EVOLUTION_WEBHOOK_EVENTS;
      } catch {
        return ['messages.upsert'];
      }
    })();

    if (!allowedEvents.includes(payload.event)) {
      log.info({ event: payload.event }, 'webhook: unsupported event ignored');
      return reply.status(200).send({
        accepted: true,
        reason: 'unsupported_event',
      } satisfies WebhookAcknowledgement);
    }

    // 4-6. Extract + anti-loop + idempotency (synchronous checks)
    const extracted = extractMessage(payload);
    if (!extracted) {
      // Either fromMe=true (anti-loop) or no text (media/ephemeral)
      const data = payload.data;
      const fromMe = data?.key.fromMe === true;
      const reason = fromMe ? 'from_me' : 'no_text';
      log.info({ reason, event: payload.event }, 'webhook: skipped');
      return reply.status(200).send({
        accepted: true,
        reason,
      } satisfies WebhookAcknowledgement);
    }

    const messageKeyId = extracted.messageKeyId;
    if (messageKeyId && cache.hasAndMark(messageKeyId)) {
      log.info({ messageKeyId }, 'webhook: duplicate event ignored');
      return reply.status(200).send({
        accepted: true,
        reason: 'duplicate',
        messageKeyId,
      } satisfies WebhookAcknowledgement);
    }

    // Ack to Evolution immediately. Process in background.
    const ack: WebhookAcknowledgement = {
      accepted: true,
      messageKeyId,
    };
    void reply.status(200).send(ack);

    // 7-9. Enqueue processing
    void processMessage(extracted).catch((err) => {
      const message = err instanceof Error ? err.message : 'unknown';
      log.error({ errMessage: message }, 'webhook: processMessage crashed');
    });

    return reply;
  });

  async function processMessage(msg: {
    text: string;
    from: string;
    messageKeyId: string | undefined;
    pushName: string | undefined;
  }): Promise<void> {
    const log = getLogger();
    const mockMode = isEvolutionMockMode();
    const conversationId = `wa:${msg.from}`;
    const store = getConversationStore();
    const history = turnsToHistory(await store.get(conversationId));

    log.info(
      {
        from: maskFrom(msg.from),
        textLength: msg.text.length,
        messageKeyId: msg.messageKeyId,
        mockMode,
        conversationId,
        historyLength: history.length,
      },
      'webhook: enqueueing message',
    );

    await semaphore.acquire();
    try {
      log.info({ messageKeyId: msg.messageKeyId }, 'webhook: processing started');

      // Delegate to the agent loop with conversation history attached.
      const agentResult = await runAgentLoop({
        task: msg.text,
        conversationId,
        source: 'whatsapp',
        history,
      });

      log.info(
        {
          messageKeyId: msg.messageKeyId,
          latencyMs: agentResult.latencyMs,
          resultLength: agentResult.result.length,
          iterations: agentResult.iterations,
          toolCalls: agentResult.toolCalls,
        },
        'webhook: agent completed',
      );

      // Persist this turn pair to the in-RAM store.
      await store.appendUser(conversationId, msg.text);
      await store.appendAssistant(conversationId, agentResult.result);

      // Send back via Evolution API
      const send = await sendText({ to: msg.from, text: agentResult.result });
      if (!send.ok) {
        log.error(
          {
            messageKeyId: msg.messageKeyId,
            sendStatus: send.status,
            sendError: send.error,
          },
          'webhook: failed to send reply via Evolution API',
        );
      } else {
        log.info(
          {
            messageKeyId: msg.messageKeyId,
            mock: send.mock === true,
            sentMessageId: send.messageId,
          },
          'webhook: reply delivered',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown agent error';
      log.error(
        { errMessage: message, messageKeyId: msg.messageKeyId },
        'webhook: processing failed',
      );
      try {
        await sendText({
          to: msg.from,
          text: 'Desculpe, não consegui processar sua mensagem agora.',
        });
      } catch {
        // swallow; already logged upstream
      }
    } finally {
      semaphore.release();
    }
  }
}

function maskFrom(jid: string): string {
  if (!jid) return '';
  const at = jid.indexOf('@');
  if (at < 0) return jid.length > 6 ? `${jid.slice(0, 4)}...${jid.slice(-2)}` : jid;
  const user = jid.slice(0, at);
  const suffix = jid.slice(at + 1);
  if (user.length <= 6) return jid;
  return `${user.slice(0, 4)}...${user.slice(-2)}@${suffix}`;
}
