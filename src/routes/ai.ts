/**
 * AI panel routes — Central da IA (painel VYNTRA).
 *
 * Exposes the SAME real agent integration used by the WhatsApp flow
 * (runAgentLoop + agent_settings as directives), but authenticated with the
 * user's Supabase session instead of AGENT_API_KEY (which must stay
 * server-side). Nothing here sends WhatsApp messages or fires campaigns:
 *   - GET  /api/ai/status    -> real integration status (model, provider, key…)
 *   - POST /api/ai/chat      -> one-shot real AI reply with conversation memory
 *   - POST /api/ai/flow-test -> simulated commercial flow (Tools DISABLED so no
 *                                real WhatsApp/campaign side-effects)
 *
 * Auth: `Authorization: Bearer <SUPABASE_ACCESS_TOKEN>`. The token is verified
 * against `{SUPABASE_URL}/auth/v1/user`. Without a resolved user -> 401.
 */
import type { FastifyInstance } from 'fastify';
import { getEnv, getSupabaseProspeccaoConfig, hasNvidiaApiKey } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import { extractBearerToken } from '../utils/auth.js';
import { runAgentLoop } from '../services/agent.service.js';
import { classifyIntentHeuristic, planInbound } from '../services/intent.classifier.js';
import { scoreInboundMessage } from '../services/scoring.js';
import {
  loadAgentDirectives,
} from '../services/supabase.leads.js';
import {
  getConversationStore,
  turnsToHistory,
} from '../services/conversation.store.js';
import { loadCommercialMemoryForPrompt } from '../services/memory.service.js';
import { z } from 'zod';

/** Última atividade da IA (timestamp ms) — atualizado a cada execução real. */
let lastActivityAt: number | null = null;
let lastActivityLabel = '';

function touchActivity(label: string): void {
  lastActivityAt = Date.now();
  lastActivityLabel = label;
}

export function getAiLastActivity(): { at: number | null; label: string } {
  return { at: lastActivityAt, label: lastActivityLabel };
}

const PROVIDER = 'NVIDIA NIM';

const aiChatSchema = z.object({
  message: z.string().min(1).max(8000),
  conversationId: z.string().min(1).max(200).optional(),
});

const aiFlowTestSchema = z.object({
  leadName: z.string().max(120).default('João'),
  company: z.string().max(180).default(''),
  context: z.string().max(500).default(''),
  initialMessage: z.string().max(2000).default('Olá, tudo bem?'),
});

const aiTrainingSchema = z.object({
  message: z.string().min(1).max(8000),
  conversationId: z.string().min(1).max(200).optional(),
  persona: z
    .object({
      name: z.string().max(120).default('Carlos'),
      company: z.string().max(180).default(''),
      niche: z.string().max(180).default(''),
      profile: z.string().max(500).default('dono de pequeno negócio, cético e sem pressa'),
    })
    .optional(),
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

export function registerAiRoutes(app: FastifyInstance): void {
  const log = getLogger();

  app.get('/api/ai/status', async (req, reply) => {
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
    // "Última atividade" sempre reflete o estado real do servidor: nunca é
    // mockado. Se nenhuma conversa/teste rodou ainda, fica null (UI mostra
    // "sem atividade registrada").
    return reply.send({
      configured: hasNvidiaApiKey(),
      provider: PROVIDER,
      model: env.AGENT_MODEL,
      toolsEnabled: env.AGENT_ENABLE_TOOLS,
      evolutionConfigured: (() => {
        const e = env;
        return Boolean(e.EVOLUTION_API_URL && e.EVOLUTION_API_KEY && e.EVOLUTION_INSTANCE_NAME);
      })(),
      lastActivityAt: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
      lastActivityLabel,
      timestamp: new Date().toISOString(),
    });
  });

  app.post('/api/ai/chat', async (req, reply) => {
    const token = extractBearerToken(
      typeof req.headers['authorization'] === 'string'
        ? req.headers['authorization']
        : undefined,
    );
    const user = await resolveSupabaseUser(token);
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }

    const parsed = aiChatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        statusCode: 400,
      });
    }

    const store = getConversationStore();
    // Cada usuário tem memória própria; id opcional do front permite recomeçar.
    const conversationId = parsed.data.conversationId ?? `panel:${user.id}`;
    const history = turnsToHistory(await store.get(conversationId));

    try {
      const directives =
        (await loadAgentDirectives()) ??
        'Você é a IA de vendas do painel VYNTRA. Responda de forma natural em português.';

      const result = await runAgentLoop({
        task: parsed.data.message,
        conversationId,
        source: 'http',
        history,
        directives,
        commercialMemory:
          (await loadCommercialMemoryForPrompt(user.id)) ?? undefined,
        // No painel o teste é apenas conversa: NÃO envia WhatsApp nem move leads.
        enableTools: false,
      });

      await store.appendUser(conversationId, parsed.data.message);
      await store.appendAssistant(conversationId, result.result);
      touchActivity('chat');

      return reply.send({
        conversationId,
        response: result.result,
        model: result.model,
        provider: PROVIDER,
        latencyMs: result.latencyMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI request failed';
      log.error({ errMessage: message }, 'ai: chat route error');
      return reply.status(502).send({
        error: 'ai_error',
        message,
        statusCode: 502,
      });
    }
  });

  app.post('/api/ai/flow-test', async (req, reply) => {
    const token = extractBearerToken(
      typeof req.headers['authorization'] === 'string'
        ? req.headers['authorization']
        : undefined,
    );
    const user = await resolveSupabaseUser(token);
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }

    const parsed = aiFlowTestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        statusCode: 400,
      });
    }

    const { leadName, company, context, initialMessage } = parsed.data;
    const heuristic = classifyIntentHeuristic(initialMessage);
    const intent = heuristic?.intent ?? 'ambiguo';
    const score = scoreInboundMessage({ currentStatus: 'novo', intent, text: initialMessage });
    const plan = planInbound('novo', intent);

    // MODO DE TESTE explícito: tools desabilitadas garantem que nenhum
    // WhatsApp real é enviado e nenhuma campanha/lead real é alterado.
    const directives =
      (await loadAgentDirectives()) ??
      'Você é a IA de vendas do painel VYNTRA. Responda de forma natural em português.';

    const task =
      `MODO DE SIMULAÇÃO / TESTE — IMPORTANTE: nenhuma mensagem será enviada ` +
      `ao WhatsApp do lead. Apenas gere o conteúdo que seria enviado.\n\n` +
      `Lead de teste:\n` +
      `- Nome: ${leadName}\n` +
      (company ? `- Empresa: ${company}\n` : '') +
      (context ? `- Contexto: ${context}\n` : '') +
      `- Mensagem inicial do lead: "${initialMessage}"\n\n` +
      `Atue como o agente comercial (mesma configuração real do agente) e conduza ` +
      `a conversa conforme o fluxo configurado para este tipo de lead. Responda no ` +
      `formato:\n` +
      `ETAPA: <etapa do fluxo, ex: Primeiro contato>\n` +
      `MENSAGEM:\n<texto completo que o agente enviaria>\n` +
      `PROXIMA_ETAPA: <próxima etapa esperada>`;

    try {
      const result = await runAgentLoop({
        task,
        source: 'internal',
        directives,
        commercialMemory:
          (await loadCommercialMemoryForPrompt(user.id)) ?? undefined,
        enableTools: false,
        leadContext: `leadTeste=true; nome=${leadName}${company ? `; empresa=${company}` : ''}`,
      });
      touchActivity('flow-test');

      // Parse simples do bloco ETAPA/MENSAGEM/PROXIMA_ETAPA.
      const etapaMatch = result.result.match(/ETAPA:\s*(.+)/i);
      const msgMatch = result.result.match(/MENSAGEM:\s*([\s\S]*?)(?=\nPROXIMA_ETAPA|\nPROXIMA_ETAPA:)/i);
      const proxMatch = result.result.match(/PROXIMA_ETAPA:\s*([\s\S]+)/i);
      const etapa = etapaMatch ? etapaMatch[1].trim() : 'Primeiro contato';
      const mensagem = (msgMatch ? msgMatch[1].trim() : result.result.trim()).slice(0, 4000);
      const proximaEtapa = proxMatch ? proxMatch[1].trim().slice(0, 200) : 'Aguardar resposta';

      return reply.send({
        mode: 'simulation',
        simulationNotice: 'Modo de teste — nenhuma mensagem será enviada.',
        lead: { name: leadName, company },
        etapa,
        mensagem,
        proximaEtapa,
        status: 'ok',
        model: result.model,
        provider: PROVIDER,
        latencyMs: result.latencyMs,
         signed: mensagem,
         diagnostico: {
           intencao: intent,
           confianca: heuristic?.confidence ?? 'none',
           score: score.score,
           motivo: score.factors,
           estado: plan.nextStatus ?? 'novo',
           acao: plan.stopCampaign ? 'interromper_campanha' : intent === 'humano' ? 'encaminhar_humano' : 'responder_e_conduzir',
           material: context ? 'contexto_do_teste' : 'nenhum',
           handoff: intent === 'humano',
           ferramentas: 'desativadas_no_teste',
         },
       });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI flow-test failed';
      log.error({ errMessage: message }, 'ai: flow-test route error');
      return reply.status(502).send({
        error: 'ai_error',
        message,
        statusCode: 502,
      });
    }
  });

  app.post('/api/ai/training', async (req, reply) => {
    const token = extractBearerToken(
      typeof req.headers['authorization'] === 'string'
        ? req.headers['authorization']
        : undefined,
    );
    const user = await resolveSupabaseUser(token);
    if (!user) {
      return reply.status(401).send({ error: 'unauthorized', statusCode: 401 });
    }

    const parsed = aiTrainingSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'validation_error',
        message: parsed.error.issues.map((i) => i.message).join('; '),
        statusCode: 400,
      });
    }

    // SANDBOX TOTAL: usa um namespace de conversa dedicado, NÃO chama tools
    // (nenhum WhatsApp real, nenhuma campanha, nenhum Kanban, nenhuma reunião)
    // e a IA interpreta a PERSONA DO CLIENTE (não o agente comercial).
    const persona = parsed.data.persona;
    const name = persona?.name || 'Carlos';
    const company = persona?.company || 'uma empresa pequena';
    const niche = persona?.niche || '';
    const profile = persona?.profile || 'dono de pequeno negócio, cético e sem pressa';

    const systemPrompt =
      'Você é um cliente real num treinamento de vendas. O usuário que irá ' +
      'conversar com você é um VENDEDOR em treinamento. Você NÃO é assistente ' +
      'de vendas: você interpreta o papel de um prospect. Seja realista, ' +
      'humano e natural: responda curto (1-2 frases por vez), do jeito que um ' +
      'dono de negócio responde no WhatsApp. Seja cético, sério e sem pressa; ' +
      'você NÃO conhece o vendedor e NÃO tomou nenhuma decisão. Apresente ' +
      'dúvidas, resistências e perguntas sobre preço/resultado como qualquer ' +
      'cliente faria. Responda como porta-voz da própria empresa, sem revelar ' +
      'que é uma simulação.\n' +
      'SUA PERSONA:\n' +
      `- Nome: ${name}\n` +
      (company ? `- Empresa: ${company}\n` : '') +
      (niche ? `- Área/nicho: ${niche}\n` : '') +
      `- Perfil/atitude: ${profile}\n` +
      'IMPORTANTE: nunca marque reuniões, nunca agende nada e nunca informe ' +
      'dados falsos de outras pessoas. Se o vendedor te convencer, responda de ' +
      'acordo (pode aceitar uma proposta). Esta conversa é SOMENTE treinamento.';

    const store = getConversationStore();
    const conversationId =
      parsed.data.conversationId ?? `training:${user.id}`;
    const history = turnsToHistory(await store.get(conversationId));

    try {
      const result = await runAgentLoop({
        task: parsed.data.message,
        conversationId,
        source: 'http',
        history,
        directives: undefined,
        enableTools: false,
        systemPromptOverride: systemPrompt,
      });

      await store.appendUser(conversationId, parsed.data.message);
      await store.appendAssistant(conversationId, result.result);
      touchActivity('training');

      return reply.send({
        conversationId,
        response: result.result,
        model: result.model,
        provider: PROVIDER,
        latencyMs: result.latencyMs,
        sandbox: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI training failed';
      log.error({ errMessage: message }, 'ai: training route error');
      return reply.status(502).send({
        error: 'ai_error',
        message,
        statusCode: 502,
      });
    }
  });

  log.info('ai: routes registered');
}
