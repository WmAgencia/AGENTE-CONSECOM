/**
 * Tool: finalizar_sem_interesse
 * Permission: NETWORK
 *
 * Records that a prospect is not interested or that a callback/reunion was
 * canceled. Used by the outbound prospection agent to signal the outcome so the
 * pipeline can route the lead correctly:
 *
 *   - reason = "sem_interesse": marks the lead as "sem_interesse" and sets
 *     no_interest_until = now + no_interest_months (default 6 months). While
 *     that window is active, the Google Maps extension shows a "Sem interesse"
 *     tag and refuses to re-import/select the place.
 *   - reason = "reuniao_cancelada": marks the lead as "reuniao_cancelada".
 */
import type { ToolBase } from './registry.js';
import {
  getSupabaseProspeccaoConfig,
  hasSupabaseProspeccao,
} from '../config/env.js';
import { captureLearning } from '../services/agent.learning.js';

export function createFinalizeProspectingTool(): ToolBase {
  return {
    definition: {
      name: 'finalizar_sem_interesse',
      description:
        'Registra o desfecho de uma prospecção Consecom. Use "sem_interesse" ' +
        'quando o lead disser que não tem interesse/quer parar (bloqueia o ' +
        'lead por 6 meses). Use "reuniao_cancelada" quando o lead cancelar uma ' +
        'reunião já marcada. Informe leadId ou phone sempre que souber.',
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string', description: 'ID do lead no Consecom (quando conhecido).' },
          phone: { type: 'string', description: 'Número/whatsapp do lead.' },
          outcome: {
            type: 'string',
            enum: ['sem_interesse', 'reuniao_cancelada'],
            description: 'Qual desfecho registrar.',
          },
          motive: { type: 'string', description: 'Motivo/observação (opcional).' },
        },
        required: ['outcome'],
      },
    },
    permission: 'NETWORK',
    async execute(args) {
      const outcome = typeof args.outcome === 'string' ? args.outcome.trim() : '';
      const leadId = typeof args.leadId === 'string' ? args.leadId.trim() : '';
      const phone = typeof args.phone === 'string' ? args.phone.trim() : '';
      const motive = typeof args.motive === 'string' ? args.motive.trim() : '';

      if (!leadId && !phone) {
        return {
          ok: false,
          output: 'Sem leadId ou phone, não é possível registrar o desfecho.',
          error: 'invalid_args',
        };
      }
      if (outcome !== 'sem_interesse' && outcome !== 'reuniao_cancelada') {
        return { ok: false, output: `Outcome inválido: ${outcome}`, error: 'invalid_args' };
      }

      const cfg = getSupabaseProspeccaoConfig();
      if (!hasSupabaseProspeccao() || !cfg.url || !cfg.serviceRoleKey) {
        return { ok: false, output: 'Supabase não configurado.', error: 'io_error' };
      }

      const endpoint = `${cfg.url}/rest/v1/rpc/consecom_agent_outcome`;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: cfg.serviceRoleKey,
            Authorization: `Bearer ${cfg.serviceRoleKey}`,
          },
          body: JSON.stringify({
            p_lead_id: leadId || null,
            p_phone: phone || null,
            p_outcome: outcome,
            p_motive: motive || null,
            p_no_interest_months: 6,
          }),
        });
        if (!res.ok) {
          return {
            ok: false,
            output: `Supabase retornou status ${res.status}`,
            error: 'io_error',
          };
        }
const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if ((data as { ok?: boolean } | null)?.ok === true && leadId) {
        void captureLearning('rejeicao', leadId, { lessonOverride: motive || undefined });
      }
      return {
          ok: true,
          output:
            outcome === 'sem_interesse'
              ? 'Registrado como sem interesse (bloqueado por 6 meses).'
              : 'Reunião registrada como cancelada.',
          data,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'network error';
        return {
          ok: false,
          output: `Falha ao chamar o Supabase: ${msg}`,
          error: 'io_error',
        };
      }
    },
  };
}