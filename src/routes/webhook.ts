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
import { reconcileConnectionOnConnect } from '../services/instance.rotation.js';
import { runAgentLoop } from '../services/agent.service.js';
import {
  loadLearningsForPrompt,
  captureLearning,
} from '../services/agent.learning.js';
import {
  resolveUserIdForInstance,
  loadCommercialMemoryForPrompt,
} from '../services/memory.service.js';
import { sendText, isEvolutionMockMode } from '../services/evolution.service.js';
import { findConnectionByInstanceName } from '../services/evolution.connections.js';
import {
  getConversationStore,
  turnsToHistory,
} from '../services/conversation.store.js';
import {
  findLeadByPhone,
  getLeadById,
  updateLeadStatus,
  canAutoReply,
  shouldActivateConversation,
  isSequenceComplete,
  loadLeadSequenceCompleteness,
  appendConversationTurn,
  loadAgentDirectives,
  loadAiResponseDelaySeconds,
  updateLeadAnalytics,
  cancelLeadSendRuns,
  recordAgentOutcome,
  updateLeadNeedsAttention,
  type LeadRow,
} from '../services/supabase.leads.js';
import {
  loadLeadStrategy,
  buildStrategyDirective,
} from '../services/strategy.service.js';
import {
  parseIntentMarker,
  stripIntentMarker,
  classifyIntentHeuristic,
  planInbound,
} from '../services/intent.classifier.js';
import { scoreInboundMessage } from '../services/scoring.js';
import {
  loadCampaignKnowledge,
  buildKnowledgeContext,
  incrementKbFileUsage,
} from '../services/kb.service.js';
import { blockIfSequenceActive, isLeadSequenceActive } from '../services/campaign.gate.js';
import { InboundMessageDebouncer } from '../services/inbound.message.debouncer.js';
import { parseFollowUpMarker, stripFollowUpMarker } from '../services/followup.parser.js';
import { createFollowUp } from '../services/followup.service.js';

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
  const delayedMessages = new InboundMessageDebouncer<Parameters<typeof processMessage>[0]>();
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
    // Se a instância CONECTOU agora (state=open), dispara a reconciliação de
    // rotação/reconexão DEPOIS de persistir o patch (fire-and-forget).
    let shouldReconcile = false;

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
        shouldReconcile = true;
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
        // Invalida o cache de estado real no worker (se estiver rodando)
        // para a próxima checagem da Evolution não usar dado obsoleto.
        try {
          const wkr = (app as any).sendWorker as
            | { invalidateInstanceCache: (instance: string) => void }
            | undefined;
          wkr?.invalidateInstanceCache(instanceName);
        } catch {
          // best-effort: se o worker não estiver acessível, o cache
          // expira naturalmente pelo TTL (15s default).
        }
        // Reconcilia rotação/reconexão agora que a conexão está conectada.
        if (shouldReconcile) {
          void reconcileConnectionOnConnect(instanceName).catch((err) => {
            log.warn(
              { instance: instanceName, errMessage: err instanceof Error ? err.message : 'unknown' },
              'webhook: reconcileConnectionOnConnect crashed',
            );
          });
        }
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
    instance?: string;
  }, deferred = false): Promise<void> {
    const log = getLogger();
    const mockMode = isEvolutionMockMode();
    const fromJid = msg.from;

    log.info(
      { from: maskFrom(fromJid), textLength: msg.text.length, messageKeyId: msg.messageKeyId, mockMode },
      '[WHATSAPP] Mensagem recebida',
    );

    if (fromJid.endsWith('@g.us')) {
      log.info({ from: maskFrom(fromJid) }, '[WHATSAPP] Mensagem de grupo ignorada (não respondemos grupos)');
      return;
    }

    // --- Lead identificado -------------------------------------------------
    let lead: LeadRow | undefined;
    let leadContext: string | undefined;
    let strategyDirective: string | undefined;
    try {
      lead = (await findLeadByPhone(fromJid)) ?? undefined;
      if (!lead) {
        log.info({ from: maskFrom(fromJid) }, '[LEAD][ERROR] Lead não encontrado para o número (inbound ignorado)');
        return;
      }
      // O índice telefônico é cacheado; o controle de takeover precisa ser
      // lido fresco para reagir imediatamente após o clique do operador.
      const freshControl = await getLeadById(lead.id);
      if (freshControl) lead = { ...lead, ai_control: freshControl.ai_control };
      if (!canAutoReply(lead.status)) {
        log.info(
          { leadId: lead.id, status: lead.status },
          '[LEAD] Lead bloqueado para atendimento automático (inbound ignorado)',
        );
        return;
      }
      log.info({ leadId: lead.id, name: lead.name, status: lead.status }, '[LEAD] Lead identificado');

      // Contexto do lead para personalizar a conversa (nome/nicho/telefone).
      const bits = [
        `leadId=${lead.id}`,
        lead.name ? `nome=${lead.name}` : null,
        lead.niche ? `nicho/negocio=${lead.niche}` : null,
        lead.category ? `categoria=${lead.category}` : null,
        `telefone=${fromJid.replace(/@.*$/, '')}`,
      ].filter(Boolean).join('; ');
      leadContext = bits;
      // Estratégia vinculada ao lead (se houver) para guiar o estilo da abordagem.
      const strategy = await loadLeadStrategy(lead.id);
      strategyDirective = buildStrategyDirective(strategy) ?? undefined;
    } catch (err) {
      const em = err instanceof Error ? err.message : 'unknown';
      log.warn({ errMessage: em, from: maskFrom(fromJid) }, '[LEAD][ERROR] Falha ao identificar o lead; inbound ignorado');
      return;
    }

    // --- Conversa (histórico) e status da campanha (diagnóstico) -----------
    const conversationId = `wa:${fromJid}`;
    const store = getConversationStore();
    const history = turnsToHistory(await store.get(conversationId));
    const agentHistory = deferred && history.at(-1)?.role === 'user' ? history.slice(0, -1) : history;
    log.info(
      {
        conversationId,
        leadId: lead.id,
        status: lead.status,
        historyLength: history.length,
      },
      '[CONVERSA] Conversa carregada',
    );

    const campaignInfo = await loadLeadCampaignStatus(lead.id);
    log.info(
      { leadId: lead.id, campaignId: campaignInfo?.campaignId, runStatus: campaignInfo?.runStatus, campaignStatus: campaignInfo?.campaignStatus, aiEnabled: campaignInfo?.aiEnabled },
      '[CAMPAIGN] Status da campanha do lead',
    );

    // O takeover é por lead e persistido no banco; não desliga a IA global.
    if (lead.ai_control === 'human') {
      try {
        await store.appendUser(conversationId, msg.text);
      } catch {}
      await appendConversationTurn(lead.id, 'user', msg.text).catch(() => {});
      log.info({ leadId: lead.id }, '[AI] conversa assumida por operador — resposta automática ignorada');
      return;
    }

if (campaignInfo?.campaignId && campaignInfo.aiEnabled === false) {
      try { await store.appendUser(conversationId, msg.text); } catch {}
      await appendConversationTurn(lead.id, 'user', msg.text).catch(() => {});
      await classifyInboundWithoutAi(lead.id, msg.text).catch((err) => {
        log.warn(
          { leadId: lead.id, errMessage: err instanceof Error ? err.message : 'unknown' },
          '[AI][OFF] classificação determinística falhou',
        );
      });
      log.info({ leadId: lead.id, campaignId: campaignInfo.campaignId }, '[AI] IA desativada — mensagem salva e classificada');
      return;
    }

    // --- Regra B: bloqueio da IA durante sequência de campanha ativa --------
    // Enquanto o lead tiver um run 'pending'/'running', a mensagem é salva mas
    // a IA NÃO é chamada nem envia resposta. Ao terminar a sequência (run
    // 'done') ou ela ser interrompida ('failed'), o portão libera.
    if (deferred
      ? await isLeadSequenceActive(lead.id)
      : await blockIfSequenceActive({ leadId: lead.id, conversationId, text: msg.text })) {
      return;
    }

    const delaySeconds = deferred ? 0 : await loadAiResponseDelaySeconds();
    if (delaySeconds > 0) {
      try {
        await store.appendUser(conversationId, msg.text);
      } catch {}
      await appendConversationTurn(lead.id, 'user', msg.text).catch(() => {});
      delayedMessages.schedule(lead.id, msg, delaySeconds * 1000, (pending) => {
        void processMessage(pending, true).catch((err) => {
          log.error({ leadId: lead.id, errMessage: err instanceof Error ? err.message : 'unknown' }, '[AI] delayed processing crashed');
        });
      });
      log.info({ leadId: lead.id, delaySeconds }, '[AI] mensagem agrupada — janela reiniciada');
      return;
    }

    await semaphore.acquire();
    try {
      log.info({ messageKeyId: msg.messageKeyId }, '[AI] Processando mensagem');

// Delegate to the agent loop with conversation history attached.
      const memoryOwnerId = await resolveUserIdForInstance(msg.instance);
      const connection = await findConnectionByInstanceName(msg.instance ?? '');
      const connectionIdentity =
        connection && (connection.display_name || connection.whatsapp_name)
          ? {
              connection_id: connection.id,
              connection_name: (connection.display_name ?? connection.whatsapp_name) as string,
              connection_phone: connection.phone_number,
            }
          : undefined;
      const agentResult = await runAgentLoop({
        task: msg.text,
        conversationId,
        source: 'whatsapp',
        history: agentHistory,
        directives: (await loadAgentDirectives()) ?? undefined,
        learnings: (await loadLearningsForPrompt()) ?? undefined,
        commercialMemory: (await loadCommercialMemoryForPrompt(memoryOwnerId)) ?? undefined,
        knowledgeBase: await resolveCampaignKnowledge(campaignInfo?.campaignId),
        instance: msg.instance,
        leadContext,
        strategyDirective,
        connectionIdentity,
      });
      log.info(
        {
          messageKeyId: msg.messageKeyId,
          latencyMs: agentResult.latencyMs,
          resultLength: agentResult.result.length,
          iterations: agentResult.iterations,
          toolCalls: agentResult.toolCalls,
        },
        '[AI] Agente respondeu',
      );

      // --- Intenção: marker da IA (fonte principal) com fallback heurístico.
       const followUp = parseFollowUpMarker(agentResult.result);
       let intent = parseIntentMarker(agentResult.result);
       if (!intent) intent = classifyIntentHeuristic(msg.text)?.intent ?? 'ambiguo';
       const cleanReply = stripIntentMarker(stripFollowUpMarker(agentResult.result));
       log.info({ messageKeyId: msg.messageKeyId, intent }, '[IA] Intenção detectada');

       if (followUp) {
         const idempotencyKey = `ai:${lead.id}:${followUp.date}:${followUp.time ?? 'sem-horario'}:${followUp.message}`;
         const created = await createFollowUp({
           lead_id: lead.id,
           owner_user_id: lead.owner_user_id ?? memoryOwnerId,
           scheduled_date: followUp.date,
           scheduled_time: followUp.time,
           message: followUp.message,
           source: 'ia',
           conversation_id: conversationId,
           origin_context: msg.text,
           idempotency_key: idempotencyKey,
         });
         if (created) {
           await updateLeadStatus(lead.id, 'responder_depois').catch(() => {});
           log.info({ leadId: lead.id, followUpId: created.id, date: followUp.date, time: followUp.time }, '[FOLLOW_UP] criado pela IA');
         }
       }

      // --- Plano de ação (Kanban + campanha — sem misturar os sistemas) -----
      // IMPORTANTE: o agente pode ter executado TOOLS que já mudaram o estado
      // do lead (marcar_reuniao => reuniao_marcada; finalizar_sem_interesse =>
      // sem_interesse). Então relemos o status FRESCO do banco (sem cache) para
      // não sobrescrever com o status obsoleto lido no início do processamento.
      const freshLead = await getLeadById(lead.id);
      const freshStatus = freshLead?.status ?? lead.status;
      const plan = planInbound(freshStatus, intent);
      if (plan.nextStatus === 'sem_interesse') {
        // Se o próprio agente já registrou sem_interesse (via tool), não
        // registra de novo (evita executar a RPC duas vezes no mesmo desfecho).
        const alreadyRecorded = freshStatus === 'sem_interesse';
        const recorded = alreadyRecorded
          ? true
          : await recordAgentOutcome({
              leadId: lead.id,
              outcome: 'sem_interesse',
              noInterestMonths: 6,
            });
        if (plan.stopCampaign) {
          await cancelLeadSendRuns(lead.id, 'sem_interesse');
        }
        void captureLearning('rejeicao', lead.id);
        log.info(
          { leadId: lead.id, recorded },
          '[KANBAN] Lead movido para Sem interesse + campanha interrompida',
        );
      } else if (shouldActivateConversation(freshStatus)) {
        // MODIFICAÇÃO 1: só move para 'conversando' quando TODAS as mensagens
        // da campanha foram enviadas. Resposta no meio da sequência (ou com
        // alguma mensagem pendente/falha) mantém o lead na coluna atual; a
        // sequência segue normalmente e o movimento acontece depois.
        const sequence = await loadLeadSequenceCompleteness(lead.id).catch(() => null);
        if (sequence === null || isSequenceComplete(sequence)) {
          await updateLeadStatus(lead.id, 'conversando').catch(() => {});
          log.info({ leadId: lead.id }, '[KANBAN] Lead movido para Conversando');
        } else {
          log.info(
            { leadId: lead.id, status: freshStatus, runStatus: sequence.runStatus },
            '[KANBAN] Sequência de campanha incompleta — lead mantido na coluna atual',
          );
        }
      } else {
        log.info({ leadId: lead.id, status: freshStatus }, '[KANBAN] Status mantido');
      }

      // --- Persistência dos turnos (sem o marker de intenção) --------------
      await store.appendAssistant(conversationId, cleanReply);
      if (!deferred) await store.appendUser(conversationId, msg.text);
      if (lead.id) {
        if (!deferred) await appendConversationTurn(lead.id, 'user', msg.text).catch(() => {});
        await appendConversationTurn(lead.id, 'assistant', cleanReply, agentResult.model).catch(() => {});
      }

      // --- Lead score (SINAIS reais: intenção + engajamento) ---------------
      if (lead.id) {
        const score = scoreInboundMessage({
          currentScore: freshLead?.score ?? lead.score,
          currentStatus: freshStatus,
          intent,
          text: msg.text,
        });
        void updateLeadAnalytics(lead.id, {
          score: score.score,
          score_factors: score.factors,
        }).catch(() => {});
      }

      // --- Envio da resposta (assinatura + limpa) ---------------------------
      const finalText = cleanReply || agentResult.result;
      log.info({ messageKeyId: msg.messageKeyId }, '[AI] Resposta gerada');
      const send = await sendText({ to: fromJid, text: finalText, instance: msg.instance });
      if (!send.ok) {
        log.error(
          {
            messageKeyId: msg.messageKeyId,
            sendStatus: send.status,
            sendError: send.error,
          },
          '[WHATSAPP][ERROR] Falha ao enviar resposta via Evolution API',
        );
      } else {
        log.info(
          {
            messageKeyId: msg.messageKeyId,
            mock: send.mock === true,
            sentMessageId: send.messageId,
          },
          '[WHATSAPP] Resposta enviada',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown agent error';
      log.error(
        { errMessage: message, messageKeyId: msg.messageKeyId },
        '[WHATSAPP][ERROR] Falha ao processar mensagem',
      );
      try {
        await sendText({
          to: fromJid,
          text: 'Desculpe, não consegui processar sua mensagem agora.',
          instance: msg.instance,
        });
      } catch {
        // swallow; already logged upstream
      }
    } finally {
      semaphore.release();
    }
  }
}

/**
 * Diagnóstico: busca run pendente/ativo + campanha do lead (best-effort).
 * Usado apenas para logs — não interfere no fluxo.
 */
async function loadLeadCampaignStatus(
  leadId: string,
): Promise<{ campaignId: string | null; runStatus: string | null; campaignStatus: string | null; aiEnabled: boolean } | null> {
  const cfg = getSupabaseProspeccaoConfig();
  if (!cfg.url || !cfg.serviceRoleKey) return null;
  const headers = {
    apikey: cfg.serviceRoleKey,
    Authorization: `Bearer ${cfg.serviceRoleKey}`,
  };
  try {
    const r = await fetch(
      `${cfg.url}/rest/v1/send_runs?select=id,campaign_id,status&lead_id=eq.${encodeURIComponent(leadId)}&order=created_at.desc&limit=1`,
      { headers },
    );
    if (!r.ok) return null;
    const rows = (await r.json()) as Array<{ campaign_id: string | null; status: string | null }>;
    if (rows.length === 0) return null;
    const row = rows[0];
    let campaignStatus: string | null = null;
    if (row.campaign_id) {
      const c = await fetch(
      `${cfg.url}/rest/v1/campaigns?select=status,ai_enabled&id=eq.${encodeURIComponent(row.campaign_id)}&limit=1`,
        { headers },
      );
      if (c.ok) {
        const cs = (await c.json()) as Array<{ status: string; ai_enabled?: boolean | null }>;
        campaignStatus = cs[0]?.status ?? null;
        return { campaignId: row.campaign_id, runStatus: row.status, campaignStatus, aiEnabled: cs[0]?.ai_enabled !== false };
      }
    }
return { campaignId: row.campaign_id, runStatus: row.status, campaignStatus, aiEnabled: true };
  } catch {
    return null;
  }
}

/**
 * Classificação DETERMINÍSTICA quando a IA da campanha está DESATIVADA.
 * Nenhuma resposta automática é enviada, mas eventos importantes ainda movem o
 * lead no Kanban (sem interesse / responder depois / conversando) e marcam
 * "precisa de atenção" para o operador acompanhar.
 */
async function classifyInboundWithoutAi(leadId: string, text: string): Promise<void> {
  const log = getLogger();
  const heuristic = classifyIntentHeuristic(text);
  const intent = heuristic?.intent ?? 'ambiguo';
  const fresh = await getLeadById(leadId);
  const plan = planInbound(fresh?.status, intent);
  log.info({ leadId, intent, confidence: heuristic?.confidence ?? 'none' }, '[AI][OFF] intenção detectada');

  const scored = scoreInboundMessage({
    currentScore: fresh?.score,
    currentStatus: fresh?.status,
    intent,
    text,
  });
  void updateLeadAnalytics(leadId, { score: scored.score, score_factors: scored.factors }).catch(() => {});

  if (plan.nextStatus === 'sem_interesse') {
    const alreadyRecorded = fresh?.status === 'sem_interesse';
    if (!alreadyRecorded) {
      await recordAgentOutcome({ leadId, outcome: 'sem_interesse', noInterestMonths: 6 });
    }
    if (plan.stopCampaign) await cancelLeadSendRuns(leadId, 'sem_interesse');
    log.info({ leadId }, '[AI][OFF] Lead movido para Sem interesse + campanha interrompida');
    return;
  }

  if (plan.nextStatus === 'responder_depois') {
    await updateLeadStatus(leadId, 'responder_depois');
    await updateLeadNeedsAttention(leadId, true);
    log.info({ leadId }, '[AI][OFF] Lead marcado como Responder depois');
    return;
  }

  // Qualquer outra resposta real com IA desativada = operador precisa ver.
  await updateLeadNeedsAttention(leadId, true);
  if (shouldActivateConversation(fresh?.status)) {
    const sequence = await loadLeadSequenceCompleteness(leadId).catch(() => null);
    if (sequence === null || isSequenceComplete(sequence)) {
await updateLeadStatus(leadId, 'conversando');
      log.info({ leadId }, '[AI][OFF] Lead movido para Conversando (sequência concluída)');
    }
  }
}

/**
 * Carrega e formata a Base de Conhecimento da campanha para o prompt do agente.
 * Conta os usos (best-effort) e devolve undefined quando não há base.
 */
async function resolveCampaignKnowledge(campaignId: string | null | undefined): Promise<string | undefined> {
  if (!campaignId) return undefined;
  try {
    const kb = await loadCampaignKnowledge(campaignId);
    if (!kb || kb.files.length === 0) return undefined;
    for (const file of kb.files) {
      void incrementKbFileUsage(file.id).catch(() => {});
    }
    return buildKnowledgeContext(kb.files);
  } catch {
    return undefined;
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
