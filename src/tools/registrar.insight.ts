/**
 * Tool: registrar_insight
 * Permission: NETWORK
 *
 * Lets the agent record an observation/hypothesis about what works or fails in
 * the conversation (objection, successful angle, funnel gap). The insight is
 * stored as a DRAFT (status='nova') in agent_insights and never changes any
 * production rule directly — a human reviews it in the Intelligence dashboard.
 *
 * Safe-by-default: returns ok:false (no throw) when Supabase is not configured
 * or the insert fails, so the conversation flow is never blocked.
 */
import type { ToolBase } from './registry.js';
import {
  recordAgentInsight,
  type InsightKind,
} from '../services/insights.service.js';

export function createRegistrarInsightTool(): ToolBase {
  return {
    definition: {
      name: 'registrar_insight',
      description:
        'Registra uma observação/hipótese sobre a conversa (objeção, argumento que funcionou, ' +
        'gargalo do funil). Fica como rascunho para revisão humana — NUNCA altera regras em produção. ' +
        'Use com moderação: apenas quando você notar um padrão claro e acionável.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['estrategia', 'mensagem', 'pergunta', 'segmento', 'servico', 'objecao', 'gargalo'],
            description: 'Tipo do insight.',
          },
          title: {
            type: 'string',
            description: 'Título curto (máx 180 caracteres).',
          },
          body: {
            type: 'string',
            description: 'Descrição objetiva da observação (máx 2000 caracteres).',
          },
          leadId: {
            type: 'string',
            description: 'ID do lead quando conhecido.',
          },
          strategyId: {
            type: 'string',
            description: 'ID da estratégia em uso quando conhecido.',
          },
        },
        required: ['kind', 'title', 'body'],
      },
    },
    permission: 'NETWORK',
    async execute(args, _ctx) {
      const kind = typeof args.kind === 'string' ? (args.kind as InsightKind) : 'mensagem';
      const title = typeof args.title === 'string' ? args.title : '';
      const body = typeof args.body === 'string' ? args.body : '';
      if (!title.trim() || !body.trim()) {
        return { ok: false, output: 'title and body are required.', error: 'invalid_args' };
      }
      const res = await recordAgentInsight({
        kind,
        title: title.trim(),
        body: body.trim(),
        strategyId: typeof args.strategyId === 'string' && args.strategyId ? args.strategyId : undefined,
        leadId: typeof args.leadId === 'string' && args.leadId ? args.leadId : undefined,
      });
      if (!res.ok) {
        return {
          ok: false,
          output: 'Falha ao registrar insight (verifique se o banco de insights está configurado).',
          error: 'io_error',
        };
      }
      return { ok: true, output: 'Insight registrado como rascunho para revisão humana.' };
    },
  };
}
