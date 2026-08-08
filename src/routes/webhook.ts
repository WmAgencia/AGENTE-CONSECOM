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
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  evolutionWebhookPayloadSchema,
  extractMessage,
  type WebhookAcknowledgement,
  type EvolutionWebhookPayload,
} from '../types/webhook.js';
import { getEnv, getWebhookSecret, getSupabaseProspeccaoConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { extractQrFromEvolution, isValidQrDataUri } from '../utils/qr.js';
import { runAgentLoop } from '../services/agent.service.js';
import {
  loadLearningsForPrompt,
  captureLearning,
} from '../services/agent.learning.js';
import { sendText, isEvolutionMockMode } from '../services/evolution.service.js';
import {
  getConversationStore,
  turnsToHistory,
} from '../services/conversation.store.js';
import {
  findLeadByPhone,
  updateLeadStatus,
  isProspectingStatus,
  appendConversationTurn,
  loadAgentDirectives,
  loadAgentName,
  formatAgentSignature,
} from '../services/supabase.leads.js';

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

  app.post('/webhook/evolution', webhookHandler);
  // Evolution v2 pode adicionar o nome do evento ao path (ex: /webhook/evolution/messages-upsert).
  app.post('/webhook/evolution/:eventName', webhookHandler);

  async function webhookHandler(req: FastifyRequest, reply: FastifyReply) {
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

    // Normaliza o nome do evento: a Evolution envia "connection.update",
    // "qrcode.updated", "messages.upsert" (lowercase + dot). Internamente
    // trabalhamos com o formato canônico "CONNECTION_UPDATE", etc.
    const event = payload.event.toUpperCase().replace(/[.\s]/g, '_');

    // 3. Event filter
    const allowedEvents = (() => {
      try {
        return getEnv().EVOLUTION_WEBHOOK_EVENTS.map((e) => e.toUpperCase().replace(/[.\s]/g, '_'));
      } catch {
        return ['MESSAGES_UPSERT'];
      }
    })();

    if (!allowedEvents.includes(event)) {
      log.info({ event: payload.event }, 'webhook: unsupported event ignored');
      return reply.status(200).send({
        accepted: true,
        reason: 'unsupported_event',
      } satisfies WebhookAcknowledgement);
    }

    // 3b. Handle connection/QrCode events: atualiza status da instância no Supabase.
    // Eventos: CONNECTION_UPDATE, QRCODE_UPDATED.
    if (event === 'CONNECTION_UPDATE' || event === 'QRCODE_UPDATED' || event === 'APPLICATION_STARTUP') {
      void handleInstanceEvent(payload, event).catch((err) => {
        const message = err instanceof Error ? err.message : 'unknown';
        log.error({ errMessage: message, event: payload.event }, 'webhook: instance event handler crashed');
      });
      return reply.status(200).send({ accepted: true, reason: 'instance_event' } satisfies WebhookAcknowledgement);
    }

    // 4-6. Extract + anti-loop + idempotency (synchronous checks)
    const extracted = extractMessage(payload);
    if (!extracted) {
      // Either fromMe=true (anti-loop) or no text (media/ephemeral)
      const data = payload.data;
      const fromMe = data?.key?.fromMe === true;
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
  }

  /**
   * Handles Evolution lifecycle events (CONNECTION_UPDATE, QRCODE_UPDATED,
   * APPLICATION_STARTUP) and updates the corresponding row in
   * `whatsapp_connections` so the frontend reflects the real state.
   */
  async function handleInstanceEvent(
    payload: EvolutionWebhookPayload,
    event: string,
  ): Promise<void> {
    const log = getLogger();
    const cfg = getSupabaseProspeccaoConfig();
    if (!cfg.url || !cfg.serviceRoleKey) return;

    const instanceName = payload.instance;
    if (!instanceName) return;

    const data = payload.data as Record<string, unknown> | undefined;
    if (!data) return;

    const patch: Record<string, unknown> = {
      last_sync_at: new Date().toISOString(),
    };

    // ----- CONNECTION_UPDATE -----
    // data.state pode ser "open" | "close" | "connecting"
    // data.statusReason é um código numérico da Evolution (200 = connected,
    // 400/401/403/408/500/501/502/503 = falha). Estado é o sinal confiável.
    if (event === 'CONNECTION_UPDATE') {
      const state = typeof data.state === 'string' ? data.state.toLowerCase() : null;
      const reason = data.statusReason;
      const errorReasonCodes = [400, 401, 403, 408, 500, 501, 502, 503];
      if (state === 'open') {
        patch.status = 'connected';
        // Conexão bem-sucedida: limpa QR Code (já foi usado) e dados antigos.
        patch.qr_code = null;
        patch.phone_number = null;
        patch.whatsapp_name = null;
      } else if (state === 'close') {
        patch.status = 'disconnected';
        patch.qr_code = null;
      } else if (state === 'connecting') {
        patch.status = 'connecting';
      } else if (typeof reason === 'number' && errorReasonCodes.includes(reason)) {
        patch.status = 'error';
      } else if (typeof reason === 'number') {
        // statusReason válido mas sem erro (ex: 200 connected durante restart)
        // e sem state explícito — mantém o estado anterior.
        patch.status = state ?? 'connecting';
      }
      // Telefone/owner quando disponivel (Evolution envia `ownerJid` ou `jid`)
      const ownerJid = (data.ownerJid as string | undefined) ?? (data.jid as string | undefined);
      if (typeof ownerJid === 'string' && ownerJid.length > 0) {
        const at = ownerJid.indexOf('@');
        patch.phone_number = at > 0 ? ownerJid.slice(0, at) : ownerJid;
      }
      const profileName = data.profileName as string | undefined;
      if (typeof profileName === 'string') patch.whatsapp_name = profileName;
      const profilePicUrl = data.profilePicUrl as string | undefined;
      if (typeof profilePicUrl === 'string' && !patch.whatsapp_name) {
        // Não grava URL no whatsapp_name (campo é texto). Apenas loga.
        log.debug({ profilePicUrl }, 'webhook: profilePicUrl ignored (whatsapp_name is text)');
      }
      const instanceId = (data.instanceId as string | undefined) ?? (data.id as string | undefined);
      if (typeof instanceId === 'string') patch.evolution_instance_id = instanceId;
    }

    // ----- QRCODE_UPDATED -----
    if (event === 'QRCODE_UPDATED') {
      const extracted = extractQrFromEvolution(data);
      if (extracted?.dataUri && isValidQrDataUri(extracted.dataUri)) {
        patch.qr_code = extracted.dataUri;
        patch.status = 'connecting';
      } else {
        log.warn(
          { event: payload.event, dataKeys: Object.keys(data) },
          'webhook: QRCODE_UPDATED had no usable base64 in any known field',
        );
      }
      // pairingCode (opcional): alguns fluxos entregam só o pairing code.
      const pairingCode = data.pairingCode as string | undefined;
      if (typeof pairingCode === 'string' && pairingCode.trim().length > 0 && !patch.qr_code) {
        patch.qr_code = `data:text/plain;base64,${Buffer.from(pairingCode).toString('base64')}`;
      }
    }

    // ----- APPLICATION_STARTUP -----
    // Apenas atualiza last_sync_at + status connecting (instância subiu).

    try {
      const url = `${cfg.url}/rest/v1/whatsapp_connections?instance_name=eq.${encodeURIComponent(instanceName)}`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: cfg.serviceRoleKey,
          Authorization: `Bearer ${cfg.serviceRoleKey}`,
        },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const txt = await res.text();
        log.warn(
          { status: res.status, body: txt.slice(0, 200), event: payload.event },
          'webhook: failed to update whatsapp_connections',
        );
      } else {
        log.info(
          { instance: instanceName, event: payload.event, patch },
          'webhook: instance event processed',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      log.warn({ errMessage: message }, 'webhook: instance event update crashed');
    }
  }

  async function processMessage(msg: {
    text: string;
    from: string;
    messageKeyId: string | undefined;
    pushName: string | undefined;
  }): Promise<void> {
    const log = getLogger();
    const mockMode = isEvolutionMockMode();
    const fromJid = msg.from;

    // Prospecção Consecom: só respondemos leads que estejam na jornada
    // (na_fila / mensagem_enviada / respondendo). Desconhecidos são ignorados.
    let leadId: string | undefined;
    try {
      const lead = await findLeadByPhone(fromJid);
      if (lead && isProspectingStatus(lead.status)) {
        leadId = lead.id;
        // Primeiro retorno do lead: marca como "conversando" (persistido).
        if (lead.status !== 'conversando') {
          await updateLeadStatus(lead.id, 'conversando').catch(() => {});
        }
      } else {
        log.info({ from: maskFrom(fromJid) }, 'webhook: inbound ignored (not a prospecting lead)');
        return;
      }
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.warn({ errMessage: em, from: maskFrom(fromJid) }, 'webhook: lead lookup failed; ignoring');
      return;
    }

    const conversationId = `wa:${fromJid}`;
    const store = getConversationStore();
    const history = turnsToHistory(await store.get(conversationId));

    log.info(
      {
        from: maskFrom(fromJid),
        leadId,
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
        directives: (await loadAgentDirectives()) ?? undefined,
        learnings: (await loadLearningsForPrompt()) ?? undefined,
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

      // Autotreino: se o agente encerrou com um desfecho explícito, registra.
      if (leadId) {
        const final = agentResult.result.trim();
        const vitoriaTerms = ['reuni', 'agendad', 'confirmad', 'marcada', 'fechado', 'aceitou'];
        const rejTerms = ['sem interesse', 'rejeito', 'não tenho interesse', 'nao quero', 'dispens', 'cancel'];
        if (vitoriaTerms.some((t) => final.toLowerCase().includes(t))) {
          void captureLearning('vitoria', leadId);
        } else if (rejTerms.some((t) => final.toLowerCase().includes(t))) {
          void captureLearning('rejeicao', leadId);
        }
      }

      // Persist this turn pair (in-RAM store + Supabase for the lead).
      await store.appendUser(conversationId, msg.text);
      await store.appendAssistant(conversationId, agentResult.result);
      if (leadId) {
        await appendConversationTurn(leadId, 'user', msg.text).catch(() => {});
        await appendConversationTurn(leadId, 'assistant', agentResult.result, agentResult.model).catch(() => {});
      }

      // Send back via Evolution API (with agent name signature)
      const agentName = await loadAgentName();
      const finalText = formatAgentSignature(agentResult.result, agentName);
      const send = await sendText({ to: fromJid, text: finalText });
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
          to: fromJid,
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
