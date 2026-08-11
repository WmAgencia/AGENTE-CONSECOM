/**
 * Tool: consultar_disponibilidade
 * Permission: NETWORK
 *
 * Consults the Consecom agenda (Supabase agent_settings) and returns the
 * available meeting slots for the next days. The agent uses this BEFORE
 * offering times to the lead, so it never invents a slot that is already
 * booked or outside the configured availability window.
 *
 * When the agenda is not configured (no weekly slots), returns ok:false and
 * tells the agent to check with the team instead of guessing times.
 */
import type { ToolBase } from './registry.js';
import {
  getAvailableSlots,
  formatSlotsForAgent,
  loadSettings,
  type AvailableSlot,
} from '../services/agenda.service.js';

export function createConsultarDisponibilidadeTool(): ToolBase {
  return {
    definition: {
      name: 'consultar_disponibilidade',
      description:
        'Consulta a agenda de reuniões (Consecom) e retorna os horários livres ' +
        'dos próximos dias. Use SEMPRE antes de oferecer data/horário ao lead, ' +
        'para não propor um horário já ocupado ou fora da sua disponibilidade. ' +
        'A resposta é uma lista de dia(s) com horários livres.',
      parameters: {
        type: 'object',
        properties: {
          days: {
            type: 'number',
            description:
              'Quantidade de dias à frente a consultar (padrão: usa a configuração da agenda).',
          },
          durationMin: {
            type: 'number',
            description: 'Duração da reunião em minutos (padrão: configuração da agenda).',
          },
        },
      },
    },
    permission: 'NETWORK',
    async execute(args, _ctx) {
      const days =
        typeof args.days === 'number' && args.days > 0 && args.days <= 30
          ? Math.round(args.days)
          : undefined;
      const durationMin =
        typeof args.durationMin === 'number' && args.durationMin > 0
          ? Math.round(args.durationMin)
          : undefined;

      const settings = await loadSettings();
      if (!settings.future_days && !days) {
        return {
          ok: false,
          output:
            'A agenda ainda não foi configurada (sem janela de disponibilidade). ' +
            'Pergunte ao lead o melhor dia/horário e confirme com a equipe antes de marcar.',
          error: 'invalid_args',
        };
      }

      const slots: AvailableSlot[] = await getAvailableSlots({ durationMin });

      if (slots.length === 0) {
        return {
          ok: false,
          output:
            'Nenhum horário disponível na janela consultada. ' +
            'Informe ao lead que não há vaga no momento e sugira que a equipe retorne com novas opções.',
          error: 'not_found',
        };
      }

      const text = await formatSlotsForAgent(slots);
      return {
        ok: true,
        output: text,
        data: { count: slots.length, slots },
      };
    },
  };
}
