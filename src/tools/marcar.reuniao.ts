/**
 * Tool: marcar_reuniao
 * Permission: NETWORK
 *
 * Records that a prospect agreed to a meeting. When the lead came from
 * Consecom (has a lead id), this marks the lead as "reuniao_marcada" in
 * Supabase (RPC consecom_marcar_reuniao) and, when an admin group is
 * configured, notifies the team so they know to attend/handle the meeting.
 *
 * If Supabase is not configured, the tool returns ok:false so the agent never
 * claims the meeting was recorded without real confirmation.
 */
import type { ToolBase } from './registry.js';
import {
  getSupabaseProspeccaoConfig,
  hasSupabaseProspeccao,
  getEnv,
} from '../config/env.js';
import { sendGroupText } from '../services/evolution.service.js';
import { resolveNotificationGroupJid } from '../services/evolution.connections.js';
import { captureLearning } from '../services/agent.learning.js';

export function createMarcarReuniaoTool(): ToolBase {
  return {
    definition: {
      name: 'marcar_reuniao',
      description:
        'Registra que o lead aceitou/reuniu com você (prospecção Consecom). ' +
        'Quando o lead tem um ID no sistema, marcamos a reunião no Supabase e, se o ' +
        'grupo admin estiver configurado, notifica a equipe. Use SOMENTE quando o ' +
        'prospect realmente agendou/aceitou a reunião. Informe leadId quando conhecer.',
      parameters: {
        type: 'object',
        properties: {
          leadId: {
            type: 'string',
            description: 'ID do lead no sistema Consecom (quando conhecido).',
          },
          phone: {
            type: 'string',
            description: 'Número/whatsapp do lead (sem ou com @s.whatsapp.net).',
          },
          meetingAt: {
            type: 'string',
            description: 'Data/hora sugerida da reunião, em texto livre.',
          },
          notes: {
            type: 'string',
            description: 'Observações sobre a reunião (opcional).',
          },
        },
        required: [],
      },
    },
    permission: 'NETWORK',
    async execute(args, ctx) {
      const leadId =
        typeof args.leadId === 'string' ? args.leadId.trim() : '';
      const phone = typeof args.phone === 'string' ? args.phone.trim() : '';
      const meetingAt =
        typeof args.meetingAt === 'string' ? args.meetingAt.trim() : '';
      const notes =
        typeof args.notes === 'string' ? args.notes.trim() : '';

      if (!leadId && !phone) {
        return {
          ok: false,
          output:
            'Não há como registrar a reunião sem leadId ou phone. Peça o dado ou anote naturalmente.',
          error: 'invalid_args',
        };
      }

      let recorded = false;
      let supabaseError: string | undefined;
      if (hasSupabaseProspeccao() && leadId) {
        const cfg = getSupabaseProspeccaoConfig();
        if (!cfg.url || !cfg.serviceRoleKey) {
          supabaseError = 'Supabase não configurado';
        } else {
          try {
            const res = await fetch(`${cfg.url}/rest/v1/rpc/${cfg.rpc}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                apikey: cfg.serviceRoleKey,
                Authorization: `Bearer ${cfg.serviceRoleKey}`,
              },
              body: JSON.stringify({
                p_lead_id: leadId,
                p_meeting_at: meetingAt || null,
                p_notes: notes || null,
              }),
            });
            if (res.ok) {
              recorded = true;
            } else {
              supabaseError = `Supabase retornou status ${res.status}`;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'network error';
            supabaseError = `Falha ao chamar Supabase: ${msg}`;
          }
        }
      }

      // Notify the user's configured notification group (best-effort).
      // Resolve por instância -> conexão -> notification_groups; cai para
      // AGENT_ADMIN_GROUP_JID quando nenhum grupo por usuário está configurado.
      const envAdminGroup = getEnv().AGENT_ADMIN_GROUP_JID;
      let notifiedAdmin = false;
      if (recorded) {
        const targetGroup =
          (ctx.instance ? await resolveNotificationGroupJid(ctx.instance) : null) ??
          envAdminGroup;
        if (targetGroup) {
          const summary =
            `Reunião marcada (Consecom):${leadId ? ` lead=${leadId}` : ''}` +
            `${phone ? ` phone=${phone}` : ''}` +
            `${meetingAt ? ` data=${meetingAt}` : ''}` +
            `${notes ? ` obs=${notes}` : ''}`;
          const r = await sendGroupText(targetGroup, summary);
          notifiedAdmin = r.ok;
        }
      }

      if (leadId && !recorded) {
        return {
          ok: false,
          output:
            `Não foi possível registrar a reunião no sistema: ${supabaseError ?? 'desconhecido'}. ` +
            'Não afirme ao lead que a reunião foi registrada.',
          error: 'io_error',
        };
      }

      // Autotreino: vitória real -> captura a lição (fire-and-forget).
      if (recorded && leadId) {
        void captureLearning('vitoria', leadId, {
          lessonOverride: notes || undefined,
        });
      }

      return {
        ok: true,
        output:
          `Reunião registrada com sucesso.${notifiedAdmin ? ' Equipe notificada.' : ''}`,
        data: { recorded, notifiedAdmin },
      };
    },
  };
}